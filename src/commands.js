// Staff slash commands: /strikes, /warn, /pardon.

import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } from 'discord.js';
import { MAX_STRIKES } from './config.js';
import { stepFor, modLog } from './enforce.js';

export const commands = [
  new SlashCommandBuilder()
    .setName('strikes')
    .setDescription("Show a member's active strikes")
    .addUserOption((o) => o.setName('user').setDescription('Member to look up').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Manually give a member a strike (follows the same ladder)')
    .addUserOption((o) => o.setName('user').setDescription('Member to warn').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Why').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder()
    .setName('pardon')
    .setDescription('Remove strikes from a member')
    .addUserOption((o) => o.setName('user').setDescription('Member to pardon').setRequired(true))
    .addIntegerOption((o) => o.setName('count').setDescription('How many recent strikes to remove (default: all)').setMinValue(1))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
];

const fmtDate = (ms) => `<t:${Math.floor(ms / 1000)}:R>`;

export async function handleCommand(interaction, { store }) {
  const user = interaction.options.getUser('user');
  const guild = interaction.guild;

  if (interaction.commandName === 'strikes') {
    const list = store.active(guild.id, user.id);
    const total = store.count(guild.id, user.id);
    const embed = new EmbedBuilder()
      .setTitle(`${user.tag}: ${total} / ${MAX_STRIKES} strikes`)
      .setDescription(list.length
        ? list.map((s, i) => `**${i + 1}.** ${fmtDate(s.at)} — ${s.category}${s.weight > 1 ? ` (×${s.weight})` : ''}: ${s.reason}${s.by !== 'auto' ? ` _(by <@${s.by}>)_` : ''}`).join('\n')
        : 'No active strikes.');
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  if (interaction.commandName === 'warn') {
    const reason = interaction.options.getString('reason');
    const strikes = store.add(guild.id, user.id, { category: 'manual', reason, by: interaction.user.id });
    const step = stepFor(strikes);
    const member = await guild.members.fetch(user.id).catch(() => null);

    await user.send(`**${step.label} — ${guild.name}**\n${step.message}\nReason: ${reason}\nStrikes: ${Math.min(strikes, MAX_STRIKES)}/${MAX_STRIKES}`).catch(() => {});
    let note = '';
    if (step.action === 'timeout') {
      await member?.timeout(step.timeoutMs, `Manual strike ${strikes}: ${reason}`).catch(() => { note = ' (timeout failed — check role order)'; });
    } else if (step.action === 'ban') {
      await guild.members.ban(user.id, { reason: `4th offense: ${reason}` }).catch(() => { note = ' (ban failed — check role order)'; });
    }
    await modLog(guild, new EmbedBuilder()
      .setTitle(`${step.label}: ${user.tag} (manual)`)
      .setDescription(`By ${interaction.user} — ${reason}\nStrikes: ${strikes}${note}`)
      .setTimestamp());
    return interaction.reply({ content: `${user} now has ${strikes}/${MAX_STRIKES} strikes → **${step.label}**${note}.`, flags: MessageFlags.Ephemeral });
  }

  if (interaction.commandName === 'pardon') {
    const count = interaction.options.getInteger('count');
    const removed = store.pardon(guild.id, user.id, count ?? undefined);
    await modLog(guild, new EmbedBuilder()
      .setTitle(`Pardon: ${user.tag}`)
      .setDescription(`${interaction.user} removed ${removed} strike(s). Now at ${store.count(guild.id, user.id)}.`)
      .setTimestamp());
    return interaction.reply({ content: `Removed ${removed} strike(s) from ${user}. They now have ${store.count(guild.id, user.id)}.`, flags: MessageFlags.Ephemeral });
  }
}
