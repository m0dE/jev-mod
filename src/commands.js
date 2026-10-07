// Staff slash commands: /strikes, /warn, /pardon, plus /rule and /modlog for server managers.

import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags, ChannelType } from 'discord.js';
import { SEVERITY } from './config.js';
import { punishmentFor, punish, modLog } from './enforce.js';
import { MAX_CUSTOM_RULES } from './guild-settings.js';

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
    .addStringOption((o) => o.setName('reason').setDescription('Why').setRequired(true))
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
];

const fmtDate = (ms) => `<t:${Math.floor(ms / 1000)}:R>`;

export async function handleCommand(interaction, { store, settings }) {
  const guild = interaction.guild;

  if (interaction.commandName === 'rule') return handleRule(interaction, settings);

  if (interaction.commandName === 'modlog') {
    const channel = interaction.options.getChannel('channel');
    settings.setModLogChannel(guild.id, channel.id);
    await modLog(guild, new EmbedBuilder().setTitle('Mod log set').setDescription(`${interaction.user} set this channel as the mod log.`).setTimestamp());
    return interaction.reply({ content: `Moderation actions will be logged in ${channel}. Make sure I can view and post there.`, flags: MessageFlags.Ephemeral });
  }

  const user = interaction.options.getUser('user');

  if (interaction.commandName === 'strikes') {
    const list = store.active(guild.id, user.id);
    const next = (sev) => punishmentFor(sev, list.length).label;
    const embed = new EmbedBuilder()
      .setTitle(`${user.tag}: ${list.length} active offense(s)`)
      .setDescription(list.length
        ? list.map((s, i) => `**${i + 1}.** ${fmtDate(s.at)} — ${s.category}${s.severity ? ` (${s.severity})` : ''}: ${s.reason}${s.by !== 'auto' ? ` _(by <@${s.by}>)_` : ''} · expires ${fmtDate(s.until ?? s.at + 86_400_000)}`).join('\n')
        : 'No active offenses.')
      .addFields({ name: 'Next offense', value: Object.keys(SEVERITY).map((sev) => `${sev}: ${next(sev)}`).join('\n') });
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  if (interaction.commandName === 'warn') {
    const reason = interaction.options.getString('reason');
    const severity = interaction.options.getString('severity') ?? 'medium';
    const step = punishmentFor(severity, store.count(guild.id, user.id));
    const strikes = store.add(guild.id, user.id, {
      category: 'manual', severity, reason, by: interaction.user.id, cooldownMs: SEVERITY[severity].cooldownMs,
    });
    const member = await guild.members.fetch(user.id).catch(() => null);

    await user.send(`**${step.label} — ${guild.name}**\n${step.message}\nReason: ${reason}`).catch(() => {});
    const outcome = await punish({ guild, member, userId: user.id, step, reason: `Manual (${interaction.user.tag}): ${reason}` });
    await modLog(guild, new EmbedBuilder()
      .setTitle(`${outcome}: ${user.tag} (manual)`)
      .setDescription(`By ${interaction.user}: ${reason}\nSeverity: ${severity} · active offenses: ${strikes}`)
      .setTimestamp());
    return interaction.reply({ content: `${user} → **${outcome}** (${strikes} active offense(s)).`, flags: MessageFlags.Ephemeral });
  }

  if (interaction.commandName === 'pardon') {
    const count = interaction.options.getInteger('count');
    const removed = store.pardon(guild.id, user.id, count ?? undefined);
    await modLog(guild, new EmbedBuilder()
      .setTitle(`Pardon: ${user.tag}`)
      .setDescription(`${interaction.user} removed ${removed} offense(s). Now at ${store.count(guild.id, user.id)}.`)
      .setTimestamp());
    return interaction.reply({ content: `Removed ${removed} offense(s) from ${user}. They now have ${store.count(guild.id, user.id)} active.`, flags: MessageFlags.Ephemeral });
  }
}

async function handleRule(interaction, settings) {
  const guild = interaction.guild;
  const sub = interaction.options.getSubcommand();

  if (sub === 'add') {
    const text = interaction.options.getString('text');
    const severity = interaction.options.getString('severity') ?? 'low';
    const rule = settings.addRule(guild.id, text, severity);
    if (!rule) {
      return interaction.reply({ content: `This server already has ${MAX_CUSTOM_RULES} rules. Remove one first.`, flags: MessageFlags.Ephemeral });
    }
    await modLog(guild, new EmbedBuilder().setTitle(`Rule ${rule.id} added`).setDescription(`By ${interaction.user}: ${rule.text}\nSeverity: ${rule.severity}`).setTimestamp());
    return interaction.reply({ content: `Added rule **${rule.id}** (${rule.severity}): ${rule.text}\nIt applies to new messages right away.`, flags: MessageFlags.Ephemeral });
  }

  if (sub === 'remove') {
    const removed = settings.removeRule(guild.id, interaction.options.getInteger('id'));
    if (!removed) return interaction.reply({ content: 'No rule with that number. See /rule list.', flags: MessageFlags.Ephemeral });
    await modLog(guild, new EmbedBuilder().setTitle(`Rule ${removed.id} removed`).setDescription(`By ${interaction.user}: ${removed.text}`).setTimestamp());
    return interaction.reply({ content: `Removed rule **${removed.id}**: ${removed.text}`, flags: MessageFlags.Ephemeral });
  }

  const rules = settings.rules(guild.id);
  const embed = new EmbedBuilder()
    .setTitle(`${guild.name}: server rules`)
    .setDescription(rules.length
      ? rules.map((r) => `**${r.id}.** ${r.text} _(${r.severity})_`).join('\n')
      : 'No server rules yet. Add one with /rule add. The built-in rules (rudeness, bullying, griefing, spam, scams…) always apply.')
    .setFooter({ text: 'Server rules need the AI (Jev or Claude); keyword-only mode only applies the built-in rules.' });
  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
