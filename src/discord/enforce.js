// Carrying out a moderation result on Discord: delete the message, DM the member, mute or
// ban them, leave a short public notice and log it for staff. The decision itself (strikes,
// which step of the ladder) is made by the shared moderator in ../moderation.js.

import { EmbedBuilder, ChannelType, PermissionFlagsBits } from 'discord.js';
import { config } from '../config.js';

export const COLORS = [0xf1c40f, 0xe6a23c, 0xe67e22, 0xe74c3c, 0xc0392b, 0x8b0000];
const color = (action) => COLORS[Math.min(action.level ?? (action.type === 'ban' ? 5 : 0), COLORS.length - 1)];

/** The DM a member gets: what happened, where and why. */
export function warningEmbed({ action, reason, guildName }) {
  return new EmbedBuilder()
    .setColor(color(action))
    .setTitle(`${action.label} — ${guildName}`)
    .setDescription(`${action.message ?? ''}\nRepeat offenses within 24 hours get longer mutes.`.trim())
    .addFields({ name: 'Reason', value: reason || 'Breaking the server rules' })
    .setFooter({ text: 'Jef Bot moderation' })
    .setTimestamp();
}

/**
 * Carry out `result` (from moderator.moderate) for `message`. Every Discord call is
 * best-effort: a missing permission on one step must not stop the others.
 * Returns { outcome, deleted }: the outcome label (noting anything Discord refused) and
 * whether the message was really deleted ({ ok: true } or { ok: false, reason }).
 */
export async function enforce({ app, message, result, log = console }) {
  const { guild, member, author, channel } = message;
  const action = result.action ?? { type: 'delete' };
  const reason = result.reason || result.category;

  // Only a delete Discord confirmed counts; the error says why not ("Unknown Message" when it
  // was already gone, "Missing Permissions" without Manage Messages).
  const deleted = await deleteMessage(message, log);

  let outcome = 'Message removed';
  if (action.type === 'mute' || action.type === 'ban') {
    // DM first: once banned we can no longer reach them.
    const dmed = await author.send({ embeds: [warningEmbed({ action, reason, guildName: guild.name })] }).then(() => true, () => false);

    outcome = await punish({ guild, member, userId: author.id, action, reason, log });

    // Short public notice so the channel knows why the message vanished; it cleans itself up.
    const notice = await channel.send({
      content: `${author}, your message was removed: **${reason}**. ${action.label}.`,
      allowedMentions: { users: [author.id] },
    }).catch(() => null);
    if (notice) setTimeout(() => notice.delete().catch(() => {}), 15_000).unref?.();

    await modLog(guild, app, new EmbedBuilder()
      .setColor(color(action))
      .setTitle(`${outcome}: ${author.tag}`)
      .addFields(
        { name: 'User', value: `${author} (${author.id})`, inline: true },
        { name: 'Channel', value: `${channel}`, inline: true },
        { name: 'Active offenses', value: `${result.strikes}`, inline: true },
        { name: 'Category', value: `${result.category} / ${result.severity} (${result.source})`, inline: true },
        { name: 'DM delivered', value: dmed ? 'yes' : 'no', inline: true },
        { name: 'Message deleted', value: deletedLabel(deleted), inline: true },
        { name: 'Reason', value: result.reason || '—' },
        { name: 'Message', value: (message.content || '—').slice(0, 1000) },
      )
      .setTimestamp());
  }

  if (result.deleteMessages?.length) await deleteMessages(guild, result.deleteMessages);
  return { outcome, deleted };
}

/** Delete `message`: { ok: true } once Discord confirms, else { ok: false, reason }. */
export async function deleteMessage(message, log = console) {
  try {
    await message.delete();
    return { ok: true };
  } catch (e) {
    const reason = e?.message || String(e);
    log.warn(`[enforce] could not delete message ${message.id ?? ''}: ${reason}`);
    return { ok: false, reason };
  }
}

/** "yes", or "no (<reason>)", for mod-log embeds and log lines. */
export const deletedLabel = (deleted) => (deleted?.ok ? 'yes' : `no (${deleted?.reason ?? 'unknown'})`);

/** Mute or ban per `action` ({ type: 'mute' | 'ban', label, durationMs }). Returns the label, noting failures. */
export async function punish({ guild, member, userId, action, reason, log = console }) {
  let outcome = action.label;
  if (action.type === 'ban') {
    await guild.members.ban(userId, { reason: `Repeated offenses: ${reason}`, deleteMessageSeconds: 3600 })
      .catch((e) => { outcome += ' (ban failed)'; log.warn(`[enforce] ban failed: ${e.message}`); });
  } else if (action.type === 'mute') {
    // JEF_TEST_USER_IDS: try anyway, so a test from the owner's account shows Discord's answer.
    if (member?.moderatable || (member && config.testUserIds.includes(userId))) {
      await member.timeout(action.durationMs, reason)
        .then(() => log.log(`[enforce] timed out ${userId} for ${action.durationMs / 60_000} min`))
        .catch((e) => { outcome += ' (mute failed)'; log.warn(`[enforce] mute failed for ${userId}: ${e.code ?? ''} ${e.message}`); });
    } else {
      outcome += ' (cannot mute this member)';
    }
  }
  return outcome;
}

/** Clean up the rest of a spam wave or scam run ([{ messageId, room }]; room is a channel id). */
export async function deleteMessages(guild, list) {
  for (const { messageId, room } of list) {
    const channel = room && (guild.channels.cache.get(room) ?? await guild.channels.fetch(room).catch(() => null));
    await channel?.messages?.delete(messageId).catch(() => {});
  }
}

/** Possible griefing or bullying that isn't a pattern yet: no action, just a note for staff. */
export async function logWatch({ app, message, category }) {
  await modLog(message.guild, app, new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle(`Watching: ${message.author.tag}`)
    .setDescription(`Possible ${category}. No action yet; it needs a pattern across their messages.`)
    .addFields(
      { name: 'Channel', value: `${message.channel}`, inline: true },
      { name: 'Message deleted', value: deletedLabel({ ok: false, reason: 'watch only, not deleted' }), inline: true },
      { name: 'Message', value: (message.content || '—').slice(0, 1000) },
    )
    .setTimestamp());
}

/** Which channel a server logs to: set per app with /modlog or the dashboard, else MOD_LOG_CHANNEL_ID. */
export const modLogChannelId = (app) => app?.settings?.modLogChannelId ?? config.modLogChannelId ?? null;

// For servers that never ran /modlog: staff log channels by name, best first.
const LOG_CHANNEL_NAMES = [
  /^(?:jef|jev)[-_ ]?(?:bot[-_ ]?)?(?:mod[-_ ]?)?logs?$/,
  /^mod[-_ ]?logs?$/,
  /^modbot[-_ ]?logs?$/,
  /^automod[-_ ]?logs?$/,
  /^mod(?:eration)?[-_ ]?actions?$/,
  /^(?:dc|discord)[-_ ]?logs?$/,
];
// "📜ㅣdc-logs" and "#・mod-log" count as dc-logs and mod-log: drop leading emoji and separators.
const plainName = (name) => String(name).toLowerCase().replace(/^.*[ㅣ|│・•»]\s*/u, '').replace(/^[^a-z0-9]+/, '');
const LOG_PERMS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];

/** A text channel that looks like a staff log and that the bot can post embeds in, or null. */
export function findLogChannel(guild) {
  const me = guild.members?.me;
  const usable = [...(guild.channels?.cache?.values() ?? [])].filter((c) => c.type === ChannelType.GuildText
    && (!me || c.permissionsFor?.(me)?.has(LOG_PERMS)));
  for (const re of LOG_CHANNEL_NAMES) {
    const found = usable.find((c) => re.test(plainName(c.name)));
    if (found) return found;
  }
  return null;
}

/** The channel actions are logged to: the configured one, else one found by name. */
export async function resolveModLog(guild, app) {
  const channelId = modLogChannelId(app);
  const configured = channelId && (guild.channels.cache.get(channelId)
    ?? await guild.channels.fetch(channelId).catch(() => null));
  return configured || findLogChannel(guild);
}

export async function modLog(guild, app, embed) {
  const ch = await resolveModLog(guild, app);
  await ch?.send({ embeds: [embed] }).catch(() => {});
}

/**
 * Carry out a warn made from the dashboard or API on a linked Discord server: DM, mute or
 * ban, mod log — the same as /warn. Returns the outcome label, or null if the bot isn't
 * in that server.
 */
export async function applyManualWarn({ client, app, userId, action, reason, severity, strikes, by, log = console }) {
  const guild = client?.guilds.cache.get(app.discordGuildId);
  if (!guild) return null;
  const member = await guild.members.fetch(userId).catch(() => null);
  await member?.send({ embeds: [warningEmbed({ action, reason, guildName: guild.name })] }).catch(() => {});
  const outcome = await punish({ guild, member, userId, action, reason: `Manual (${by}, from the dashboard): ${reason}`, log });
  await modLog(guild, app, new EmbedBuilder()
    .setColor(color(action))
    .setTitle(`${outcome}: ${member?.user.tag ?? userId} (manual)`)
    .setDescription(`By ${by} from the Jef Bot dashboard: ${reason}\nSeverity: ${severity} · active offenses: ${strikes}`)
    .setTimestamp());
  return outcome;
}
