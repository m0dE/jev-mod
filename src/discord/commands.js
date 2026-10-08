// Slash commands: /strikes, /warn, /pardon for staff, /rule and /modlog for server managers,
// and /jef to link this server to a Jef Bot app (and see which one it is linked to).
// Everything except /jef needs the server to be linked first.

import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags, ChannelType } from 'discord.js';
import { config, SEVERITY } from '../config.js';
import { planFor } from '../plans.js';
import { punish, modLog, warningEmbed } from './enforce.js';

const severityChoices = Object.entries(SEVERITY).map(([value, s]) => ({ name: `${value}: ${s.description}`, value }));

export const commands = [
  new SlashCommandBuilder()
    .setName('strikes')
    .setDescription("Show a member's active offenses and what happens next")
    .addUserOption((o) => o.setName('user').setDescription('Member to look up').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Manually punish a member (same mute ladder as automatic offenses)')
    .addUserOption((o) => o.setName('user').setDescription('Member to warn').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Why').setRequired(true).setMaxLength(300))
    .addStringOption((o) => o.setName('severity').setDescription('How serious (default: medium)')
      .addChoices(...severityChoices))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder()
    .setName('pardon')
    .setDescription('Remove offenses from a member')
    .addUserOption((o) => o.setName('user').setDescription('Member to pardon').setRequired(true))
    .addIntegerOption((o) => o.setName('count').setDescription('How many recent offenses to remove (default: all)').setMinValue(1))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder()
    .setName('rule')
    .setDescription("Manage this server's own rules, on top of the built-in ones")
    .addSubcommand((c) => c.setName('add').setDescription('Add a rule')
      .addStringOption((o) => o.setName('text').setDescription('The rule, in plain words, e.g. "No asking for or missing old Braains"').setRequired(true).setMaxLength(300))
      .addStringOption((o) => o.setName('severity').setDescription('How serious breaking it is (default: low, a 2 minute mute)').addChoices(...severityChoices)))
    .addSubcommand((c) => c.setName('list').setDescription("List this server's rules"))
    .addSubcommand((c) => c.setName('remove').setDescription('Remove a rule')
      .addIntegerOption((o) => o.setName('id').setDescription('Rule number from /rule list').setRequired(true)))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('modlog')
    .setDescription('Choose the channel where moderation actions are logged')
    .addChannelOption((o) => o.setName('channel').setDescription('Log channel').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('jef')
    .setDescription('Jef Bot: link this server to your Jef Bot app')
    .addSubcommand((c) => c.setName('link').setDescription('Link this server to a Jef Bot app, using the code from the dashboard')
      .addStringOption((o) => o.setName('code').setDescription('Link code from the Jef Bot dashboard').setRequired(true).setMaxLength(40)))
    .addSubcommand((c) => c.setName('status').setDescription('Which Jef Bot app this server is linked to, and this month\'s usage'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
];

const fmtDate = (ms) => `<t:${Math.floor(ms / 1000)}:R>`;
const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });
const dashboardUrl = () => `${config.publicUrl}/app`;
const howToLink = () => `This server isn't linked to a Jef Bot app yet, so nothing here is moderated. Create a Discord app at ${dashboardUrl()}, then run \`/jef link code:<code>\` here with the code it gives you.`;

/**
 * Link `app` to the Discord server `guildId`. Shared by /jef link and the "Add to server"
 * callback. A server already linked to another app of the same account moves over; one
 * linked to someone else's app is refused. Returns { ok: true, app, moved } or { ok: false, code, message }.
 */
export function linkAppToGuild(db, app, guildId) {
  if (!app || app.kind !== 'discord') {
    return { ok: false, code: 'not_discord', message: 'That code is for an API app, not a Discord app.' };
  }
  const current = db.apps.byGuild(guildId);
  if (current?.id === app.id) return { ok: true, app, moved: null };
  if (current && current.accountId !== app.accountId) {
    return { ok: false, code: 'guild_taken', message: 'This server is already linked to a Jef Bot app on another account. Its owner has to unlink it first.' };
  }
  try {
    const linked = db.transaction(() => {
      if (current) db.apps.setGuild(current.id, null);
      return db.apps.setGuild(app.id, guildId);
    })();
    return { ok: true, app: linked, moved: current ?? null };
  } catch (err) {
    if (err.code === 'guild_taken') return { ok: false, code: 'guild_taken', message: 'This server is already linked to another Jef Bot app.' };
    throw err;
  }
}

export async function handleCommand(interaction, { db, moderator }) {
  const guild = interaction.guild;
  const app = db.apps.byGuild(guild.id);

  if (interaction.commandName === 'jef') return handleJef(interaction, { db, app });
  if (!app) return interaction.reply(ephemeral(howToLink()));

  if (interaction.commandName === 'rule') return handleRule(interaction, { db, app });

  if (interaction.commandName === 'modlog') {
    const channel = interaction.options.getChannel('channel');
    const updated = db.apps.update(app.id, { settings: { modLogChannelId: channel.id } });
    await modLog(guild, updated, new EmbedBuilder().setTitle('Mod log set').setDescription(`${interaction.user} set this channel as the Jef Bot mod log.`).setTimestamp());
    return interaction.reply(ephemeral(`Moderation actions will be logged in ${channel}. Make sure Jef Bot can view and post there.`));
  }

  const user = interaction.options.getUser('user');

  if (interaction.commandName === 'strikes') {
    const { active, next } = moderator.standing(app, user.id);
    const embed = new EmbedBuilder()
      .setTitle(`${user.tag}: ${active.length} active offense(s)`)
      .setDescription(active.length
        ? active.map((s, i) => `**${i + 1}.** ${fmtDate(s.at)} — ${s.category}${s.severity ? ` (${s.severity})` : ''}: ${s.reason ?? '—'}${s.by !== 'auto' ? ` _(by ${/^\d+$/.test(s.by) ? `<@${s.by}>` : s.by})_` : ''} · expires ${fmtDate(s.until)}`).join('\n')
        : 'No active offenses.')
      .addFields({ name: 'Next offense', value: Object.entries(next).map(([sev, a]) => `${sev}: ${a.label}`).join('\n') });
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  if (interaction.commandName === 'warn') {
    const reason = interaction.options.getString('reason');
    const severity = interaction.options.getString('severity') ?? 'medium';
    // /warn only needs Moderate Members; reaching the ban step needs Ban Members too.
    if (moderator.standing(app, user.id).next[severity]?.type === 'ban' && !interaction.memberPermissions?.has(PermissionFlagsBits.BanMembers)) {
      return interaction.reply(ephemeral(`That would ban ${user}, and you don't have the Ban Members permission. Ask someone who does, or use a lower severity.`));
    }
    const { strikes, action } = moderator.warn(app, { userId: user.id, username: user.username, reason, severity, by: interaction.user.id });
    const member = await guild.members.fetch(user.id).catch(() => null);

    await user.send({ embeds: [warningEmbed({ action, reason, guildName: guild.name })] }).catch(() => {});
    const outcome = await punish({ guild, member, userId: user.id, action, reason: `Manual (${interaction.user.tag}): ${reason}` });
    await modLog(guild, app, new EmbedBuilder()
      .setTitle(`${outcome}: ${user.tag} (manual)`)
      .setDescription(`By ${interaction.user}: ${reason}\nSeverity: ${severity} · active offenses: ${strikes}`)
      .setTimestamp());
    return interaction.reply(ephemeral(`${user} → **${outcome}** (${strikes} active offense(s)).`));
  }

  if (interaction.commandName === 'pardon') {
    const count = interaction.options.getInteger('count');
    const { removed, strikes } = moderator.pardon(app, { userId: user.id, username: user.username, count: count ?? undefined, by: interaction.user.id });
    await modLog(guild, app, new EmbedBuilder()
      .setTitle(`Pardon: ${user.tag}`)
      .setDescription(`${interaction.user} removed ${removed} offense(s). Now at ${strikes}.`)
      .setTimestamp());
    return interaction.reply(ephemeral(`Removed ${removed} offense(s) from ${user}. They now have ${strikes} active.`));
  }
}

async function handleJef(interaction, { db, app }) {
  const guild = interaction.guild;
  const sub = interaction.options.getSubcommand();

  if (sub === 'link') {
    // The command defaults to Manage Server, but servers can change that; check again.
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply(ephemeral('You need the Manage Server permission to link this server.'));
    }
    const target = db.discordLinks.consume(interaction.options.getString('code'));
    if (!target) {
      return interaction.reply(ephemeral(`That code is unknown or has expired (codes last 1 hour). Get a new one from your app at ${dashboardUrl()}.`));
    }
    const linked = linkAppToGuild(db, target, guild.id);
    if (!linked.ok) return interaction.reply(ephemeral(linked.message));
    console.log(`[jef] ${guild.name} (${guild.id}) linked to app ${linked.app.id} by ${interaction.user.tag}`);
    const moved = linked.moved ? ` It was linked to **${linked.moved.name}** before.` : '';
    return interaction.reply(ephemeral(`This server is now moderated by your Jef Bot app **${linked.app.name}**.${moved} Manage it at ${dashboardUrl()}.`));
  }

  // status
  if (!app) return interaction.reply(ephemeral(howToLink()));
  const account = db.accounts.get(app.accountId);
  const plan = planFor(account);
  const usage = db.usage.get(account.id);
  const limit = (n) => (n === Infinity ? 'unlimited' : n.toLocaleString('en-US'));
  const embed = new EmbedBuilder()
    .setTitle(`Jef Bot: ${app.name}`)
    .setDescription(`This server is linked to the Jef Bot app **${app.name}** (\`${app.id}\`). Manage it at ${dashboardUrl()}.`)
    .addFields(
      { name: 'Plan', value: plan.name, inline: true },
      { name: `Messages (${usage.month})`, value: usage.messages.toLocaleString('en-US'), inline: true },
      { name: 'AI checks', value: `${usage.aiChecks.toLocaleString('en-US')} / ${limit(plan.aiChecksPerMonth)}`, inline: true },
      { name: 'Custom rules', value: `${db.rules.count(app.id)} / ${limit(plan.customRules)}`, inline: true },
    )
    .setFooter({ text: 'Usage is for the whole account, this calendar month (UTC).' });
  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleRule(interaction, { db, app }) {
  const guild = interaction.guild;
  const sub = interaction.options.getSubcommand();

  if (sub === 'add') {
    const text = interaction.options.getString('text');
    const severity = interaction.options.getString('severity') ?? 'low';
    const plan = planFor(db.accounts.get(app.accountId));
    if (db.rules.count(app.id) >= plan.customRules) {
      return interaction.reply(ephemeral(`The ${plan.name} plan allows ${plan.customRules} custom rule(s) per server. Remove one first, or upgrade at ${dashboardUrl()}.`));
    }
    const rule = db.rules.add(app.id, text, SEVERITY[severity] ? severity : 'low');
    await modLog(guild, app, new EmbedBuilder().setTitle(`Rule ${rule.id} added`).setDescription(`By ${interaction.user}: ${rule.text}\nSeverity: ${rule.severity}`).setTimestamp());
    return interaction.reply(ephemeral(`Added rule **${rule.id}** (${rule.severity}): ${rule.text}\nIt applies to new messages right away.`));
  }

  if (sub === 'remove') {
    const removed = db.rules.remove(app.id, interaction.options.getInteger('id'));
    if (!removed) return interaction.reply(ephemeral('No rule with that number. See /rule list.'));
    await modLog(guild, app, new EmbedBuilder().setTitle(`Rule ${removed.id} removed`).setDescription(`By ${interaction.user}: ${removed.text}`).setTimestamp());
    return interaction.reply(ephemeral(`Removed rule **${removed.id}**: ${removed.text}`));
  }

  const rules = db.rules.list(app.id);
  const embed = new EmbedBuilder()
    .setTitle(`${guild.name}: server rules`)
    .setDescription(rules.length
      ? rules.map((r) => `**${r.id}.** ${r.text} _(${r.severity})_`).join('\n')
      : 'No server rules yet. Add one with /rule add. The built-in rules (rudeness, bullying, griefing, spam, scams…) always apply.')
    .setFooter({ text: 'Server rules need the AI; keyword-only mode only applies the built-in rules.' });
  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
