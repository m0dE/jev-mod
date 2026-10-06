// Entry point: watch every new or edited message, delete rule-breakers, escalate.

import { Client, GatewayIntentBits, Partials, Events, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { config } from './config.js';
import { createClassifier } from './classifier.js';
import { StrikeStore } from './strikes.js';
import { enforce } from './enforce.js';
import { handleCommand } from './commands.js';

if (!config.discordToken) {
  console.error('DISCORD_TOKEN is missing. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const store = new StrikeStore(config.dataFile, { expiryDays: config.strikeExpiryDays });
const classifier = createClassifier();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged: enable it in the Developer Portal
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message],
});

function isExempt(message) {
  if (!message.guild || message.author?.bot || message.system || message.webhookId) return true;
  if (config.ignoredChannelIds.includes(message.channelId)) return true;
  const member = message.member;
  if (!member) return false;
  if (member.id === message.guild.ownerId) return true;
  if (member.permissions.has(PermissionFlagsBits.ManageMessages)) return true;
  return config.exemptRoleIds.some((id) => member.roles.cache.has(id));
}

async function recentContext(message) {
  const before = await message.channel.messages.fetch({ limit: 5, before: message.id }).catch(() => null);
  if (!before) return [];
  return [...before.values()].reverse()
    .filter((m) => m.content)
    .map((m) => `${m.author.username}: ${m.content.slice(0, 300)}`);
}

// Don't process the same message twice if create + update arrive together.
const inFlight = new Set();

async function moderate(message) {
  if (isExempt(message) || !message.content || inFlight.has(message.id)) return;
  inFlight.add(message.id);
  try {
    const verdict = await classifier.classify(message.content, {
      authorName: message.author.username,
      mentionCount: message.mentions.users.size + message.mentions.roles.size + (message.mentions.everyone ? 10 : 0),
      recent: classifier.aiAvailable() ? await recentContext(message) : [],
    });
    if (!verdict.violation) return;

    const { strikes, outcome } = await enforce({ message, verdict, store });
    console.log(`[mod] ${message.guild.name} #${message.channel.name} ${message.author.tag}: ${verdict.category}/${verdict.severity} → ${outcome} (${strikes} strikes)`);
  } catch (err) {
    console.error('[mod] failed to moderate message', err);
  } finally {
    setTimeout(() => inFlight.delete(message.id), 60_000).unref();
  }
}

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag} in ${c.guilds.cache.size} server(s). AI moderation: ${classifier.aiAvailable() ? `on (${config.model})` : 'off — keyword rules only'}.`);
});

client.on(Events.MessageCreate, moderate);

// Catch people who post something clean and then edit it into something else.
client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  if (newMessage.partial) newMessage = await newMessage.fetch().catch(() => null);
  if (!newMessage || oldMessage.content === newMessage.content) return;
  await moderate(newMessage);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.inGuild()) return;
  try {
    await handleCommand(interaction, { store });
  } catch (err) {
    console.error('[command]', err);
    const reply = { content: 'Something went wrong running that command.', flags: MessageFlags.Ephemeral };
    await (interaction.replied || interaction.deferred ? interaction.followUp(reply) : interaction.reply(reply)).catch(() => {});
  }
});

client.login(config.discordToken);
