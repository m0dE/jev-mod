// What happens to a member after an offense: delete, record it, then mute for longer
// the more offenses they still have active — up to a ban.

import { EmbedBuilder } from 'discord.js';
import { config, LADDER, BAN, SEVERITY } from './config.js';

const COLORS = [0xf1c40f, 0xe6a23c, 0xe67e22, 0xe74c3c, 0xc0392b, 0x8b0000];

/** The punishment for an offense of `severity` when the member already has `prior` active offenses. */
export function punishmentFor(severity, prior) {
  const level = (SEVERITY[severity] ?? SEVERITY.medium).start + prior;
  return level < LADDER.length ? { ...LADDER[level], level } : { ...BAN, level: LADDER.length };
}

function warningEmbed({ step, verdict, guildName }) {
  return new EmbedBuilder()
    .setColor(COLORS[step.level])
    .setTitle(`${step.label} — ${guildName}`)
    .setDescription(`${step.message}\nRepeat offenses within 24 hours get longer mutes.`)
    .addFields({ name: 'Reason', value: verdict.reason || verdict.category })
    .setTimestamp();
}

/**
 * Punish `message.author` for a confirmed violation. Every Discord call is
 * best-effort: a missing permission on one step must not stop the others.
 */
export async function enforce({ message, verdict, store, log = console }) {
  const { guild, member, author, channel } = message;
  const severity = SEVERITY[verdict.severity] ? verdict.severity : 'medium';

  await message.delete().catch((e) => log.warn(`[enforce] could not delete message: ${e.message}`));

  const prior = store.count(guild.id, author.id);
  const step = punishmentFor(severity, prior);
  const strikes = store.add(guild.id, author.id, {
    category: verdict.category,
    severity,
    reason: verdict.reason,
    excerpt: message.content,
    cooldownMs: SEVERITY[severity].cooldownMs,
  });
  const embed = warningEmbed({ step, verdict, guildName: guild.name });

  // DM first: once banned we can no longer reach them.
  const dmed = await author.send({ embeds: [embed] }).then(() => true, () => false);

  const outcome = await punish({ guild, member, userId: author.id, step, reason: verdict.reason, log });

  // Short public notice so the channel knows why the message vanished; it cleans itself up.
  const notice = await channel.send({
    content: `${author}, your message was removed: **${verdict.reason || verdict.category}**. ${step.label}.`,
    allowedMentions: { users: [author.id] },
  }).catch(() => null);
  if (notice) setTimeout(() => notice.delete().catch(() => {}), 15_000).unref?.();

  await modLog(guild, new EmbedBuilder()
    .setColor(COLORS[step.level])
    .setTitle(`${outcome}: ${author.tag}`)
    .addFields(
      { name: 'User', value: `${author} (${author.id})`, inline: true },
      { name: 'Channel', value: `${channel}`, inline: true },
      { name: 'Active offenses', value: `${strikes}`, inline: true },
      { name: 'Category', value: `${verdict.category} / ${verdict.severity} (${verdict.source})`, inline: true },
      { name: 'DM delivered', value: dmed ? 'yes' : 'no', inline: true },
      { name: 'Reason', value: verdict.reason || '—' },
      { name: 'Message', value: (message.content || '—').slice(0, 1000) },
    )
    .setTimestamp());

  return { strikes, step, outcome };
}

/** Mute or ban per `step`. Returns the step label, noting anything Discord refused. */
export async function punish({ guild, member, userId, step, reason, log = console }) {
  let outcome = step.label;
  if (step.ban) {
    await guild.members.ban(userId, { reason: `Repeated offenses: ${reason}`, deleteMessageSeconds: 3600 })
      .catch((e) => { outcome += ' (ban failed)'; log.warn(`[enforce] ban failed: ${e.message}`); });
  } else if (member?.moderatable) {
    await member.timeout(step.timeoutMs, reason)
      .catch((e) => { outcome += ' (mute failed)'; log.warn(`[enforce] mute failed: ${e.message}`); });
  } else {
    outcome += ' (cannot mute this member)';
  }
  return outcome;
}

/** Possible griefing or bullying that isn't a pattern yet: no action, just a note for staff. */
export async function logWatch({ message, verdict }) {
  await modLog(message.guild, new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle(`Watching: ${message.author.tag}`)
    .setDescription(`Possible ${verdict.category}. No action yet; it needs a pattern across their messages.`)
    .addFields(
      { name: 'Channel', value: `${message.channel}`, inline: true },
      { name: 'Message', value: (message.content || '—').slice(0, 1000) },
    )
    .setTimestamp());
}

// Which channel a server logs to: set per server with /modlog, else MOD_LOG_CHANNEL_ID.
let modLogChannelFor = () => config.modLogChannelId;
export function setModLogResolver(fn) {
  modLogChannelFor = (guildId) => fn(guildId) ?? config.modLogChannelId;
}

export async function modLog(guild, embed) {
  const channelId = modLogChannelFor(guild.id);
  if (!channelId) return;
  const ch = guild.channels.cache.get(channelId)
    ?? await guild.channels.fetch(channelId).catch(() => null);
  await ch?.send({ embeds: [embed] }).catch(() => {});
}
