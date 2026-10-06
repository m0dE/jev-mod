// What happens to a member after an offense: delete, record the strike, then walk
// the ladder — warning, timeout, final warning, ban.

import { EmbedBuilder } from 'discord.js';
import { config, LADDER, MAX_STRIKES } from './config.js';

const COLORS = { 1: 0xf1c40f, 2: 0xe67e22, 3: 0xe74c3c, 4: 0x8b0000 };

export function stepFor(strikes) {
  return LADDER[Math.min(Math.max(strikes, 1), MAX_STRIKES)];
}

function warningEmbed({ step, strikes, verdict, guildName }) {
  return new EmbedBuilder()
    .setColor(COLORS[step.level])
    .setTitle(`${step.label} — ${guildName}`)
    .setDescription(step.message)
    .addFields(
      { name: 'Reason', value: verdict.reason || verdict.category, inline: false },
      { name: 'Strikes', value: `${Math.min(strikes, MAX_STRIKES)} / ${MAX_STRIKES}`, inline: true },
    )
    .setTimestamp();
}

/**
 * Punish `message.author` for a confirmed violation. Every Discord call is
 * best-effort: a missing permission on one step must not stop the others.
 */
export async function enforce({ message, verdict, store, log = console }) {
  const { guild, member, author, channel } = message;
  const weight = verdict.severity === 'high' ? config.severeStrikes : 1;

  await message.delete().catch((e) => log.warn(`[enforce] could not delete message: ${e.message}`));

  const strikes = store.add(guild.id, author.id, {
    category: verdict.category,
    reason: verdict.reason,
    excerpt: message.content,
    weight,
  });
  const step = stepFor(strikes);
  const embed = warningEmbed({ step, strikes, verdict, guildName: guild.name });

  // DM first: once banned we can no longer reach them.
  const dmed = await author.send({ embeds: [embed] }).then(() => true, () => false);

  let outcome = step.label;
  if (step.action === 'timeout' && member?.moderatable) {
    await member.timeout(step.timeoutMs, `Strike ${strikes}: ${verdict.reason}`)
      .catch((e) => { outcome += ' (timeout failed)'; log.warn(`[enforce] timeout failed: ${e.message}`); });
  } else if (step.action === 'timeout') {
    outcome += ' (cannot time out this member)';
  } else if (step.action === 'ban') {
    await guild.members.ban(author.id, { reason: `4th offense: ${verdict.reason}`, deleteMessageSeconds: 3600 })
      .catch((e) => { outcome += ' (ban failed)'; log.warn(`[enforce] ban failed: ${e.message}`); });
  }

  // Short public notice so the channel knows why the message vanished; it cleans itself up.
  const notice = await channel.send({
    content: `${author}, your message was removed: **${verdict.reason || verdict.category}**. ${step.label} (${Math.min(strikes, MAX_STRIKES)}/${MAX_STRIKES}).`,
    allowedMentions: { users: [author.id] },
  }).catch(() => null);
  if (notice) setTimeout(() => notice.delete().catch(() => {}), 15_000).unref?.();

  await modLog(guild, new EmbedBuilder()
    .setColor(COLORS[step.level])
    .setTitle(`${outcome}: ${author.tag}`)
    .addFields(
      { name: 'User', value: `${author} (${author.id})`, inline: true },
      { name: 'Channel', value: `${channel}`, inline: true },
      { name: 'Strikes', value: `${strikes} (${weight > 1 ? `+${weight}, severe` : '+1'})`, inline: true },
      { name: 'Category', value: `${verdict.category} / ${verdict.severity} (${verdict.source})`, inline: true },
      { name: 'DM delivered', value: dmed ? 'yes' : 'no', inline: true },
      { name: 'Reason', value: verdict.reason || '—' },
      { name: 'Message', value: (message.content || '—').slice(0, 1000) },
    )
    .setTimestamp());

  return { strikes, step, outcome };
}

export async function modLog(guild, embed) {
  if (!config.modLogChannelId) return;
  const ch = guild.channels.cache.get(config.modLogChannelId)
    ?? await guild.channels.fetch(config.modLogChannelId).catch(() => null);
  await ch?.send({ embeds: [embed] }).catch(() => {});
}
