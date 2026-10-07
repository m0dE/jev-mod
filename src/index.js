// Entry point: watch every new or edited message, delete rule-breakers, escalate.

import { Client, GatewayIntentBits, Partials, Events, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { config } from './config.js';
import { createClassifier } from './classifier.js';
import { StrikeStore } from './strikes.js';
import { enforce, logWatch, setModLogResolver } from './enforce.js';
import { GuildSettings } from './guild-settings.js';
import { MessageHistory } from './history.js';
import { looksLikeScam } from './rules.js';
import { handleCommand } from './commands.js';

if (!config.discordToken) {
  console.error('DISCORD_TOKEN is missing. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const store = new StrikeStore(config.dataFile);
const history = new MessageHistory();
const settings = new GuildSettings(config.settingsFile);
setModLogResolver((guildId) => settings.modLogChannelId(guildId));
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
    .map((m) => `${m.author.username}: ${m.content.slice(0, 200)}`);
}

// Who the message is aimed at: the replied-to message, or the first person mentioned.
async function replyTarget(message) {
  if (message.reference?.messageId) {
    const ref = await message.fetchReference().catch(() => null);
    if (ref) return `${ref.author.username}: ${ref.content.slice(0, 300)}`;
  }
  const mentioned = message.mentions.users.first();
  return mentioned ? mentioned.username : null;
}

// Clean up the rest of a spam wave or scam run, wherever it was posted.
async function deleteEarlier(guild, entries) {
  for (const e of entries) {
    const channel = e.channelId && (guild.channels.cache.get(e.channelId) ?? await guild.channels.fetch(e.channelId).catch(() => null));
    await channel?.messages?.delete(e.id).catch(() => {});
  }
}

// Don't process the same message twice if create + update arrive together.
const inFlight = new Set();
const justPunished = new Map();

async function moderate(message) {
  if (isExempt(message) || !message.content || inFlight.has(message.id)) return;
  inFlight.add(message.id);
  try {
    const replyTo = await replyTarget(message);
    // Recorded before the (slow) AI check so a fast flood sees every message.
    const earlier = history.recent(message.guild.id, message.author.id, message.id);
    history.add(message.guild.id, message.author.id, {
      id: message.id, channelId: message.channelId, channel: message.channel.name, to: replyTo, content: message.content,
    });
    const verdict = await classifier.classify(message.content, {
      guildId: message.guild.id,
      customRules: settings.rules(message.guild.id),
      authorName: message.author.username,
      replyTo,
      mentionCount: message.mentions.users.size + message.mentions.roles.size + (message.mentions.everyone ? 10 : 0),
      recent: classifier.aiAvailable() ? await recentContext(message) : [],
      history: earlier,
    });
    history.flag(message.guild.id, message.author.id, message.id, verdict.hint ?? (verdict.violation ? verdict.category : null));
    if (verdict.watch) {
      console.log(`[mod] watching ${message.author.tag} in #${message.channel.name}: possible ${verdict.watch}`);
      await logWatch({ message, verdict });
    }
    if (!verdict.violation) return;

    // A flood can produce several violations at once: punish once, just delete the rest.
    const key = `${message.guild.id}:${message.author.id}`;
    if (Date.now() - (justPunished.get(key) ?? 0) < 10_000) {
      await message.delete().catch(() => {});
      return;
    }
    justPunished.set(key, Date.now());
    setTimeout(() => justPunished.delete(key), 10_000).unref();

    const { strikes, outcome } = await enforce({ message, verdict, store });
    if (verdict.duplicates?.length) await deleteEarlier(message.guild, verdict.duplicates);
    // Scam links often go out in several messages; clear any others from the last 30 minutes.
    if (verdict.category === 'scam') {
      await deleteEarlier(message.guild, history.recent(message.guild.id, message.author.id, message.id).filter((h) => looksLikeScam(h.content)));
    }
    console.log(`[mod] ${message.guild.name} #${message.channel.name} ${message.author.tag}: ${verdict.category}/${verdict.severity} → ${outcome} (${strikes} active)`);
  } catch (err) {
    console.error('[mod] failed to moderate message', err);
  } finally {
    setTimeout(() => inFlight.delete(message.id), 60_000).unref();
  }
}

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag} in ${c.guilds.cache.size} server(s). AI moderation: ${classifier.aiName() ?? 'off — keyword rules only'}.`);
});

client.on(Events.MessageCreate, moderate);

// Removed from a server: delete its offense records and settings.
client.on(Events.GuildDelete, (guild) => {
  if (!guild.available) return; // an outage, not a removal
  store.forgetGuild(guild.id);
  settings.forgetGuild(guild.id);
  console.log(`[bot] removed from ${guild.name ?? guild.id}; deleted its data`);
});

// Hourly: how many messages needed Jev, and how much of today's budget is used.
setInterval(() => {
  const s = classifier.takeStats();
  if (!s.messages) return;
  console.log(`[usage] last hour: ${s.messages} messages · skipped ${s.trivial} trivial, ${s.cached} cached, ${s.gatedClean} cleared by quick check · ${s.fullChecks} full checks${s.overBudget ? ` · ${s.overBudget} over budget` : ''} · ${s.tokens} Jev tokens · today ${s.budgetUsedToday}/${s.budgetLimit || '∞'}`);
}, 60 * 60_000).unref();

// Catch people who post something clean and then edit it into something else.
client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  if (newMessage.partial) newMessage = await newMessage.fetch().catch(() => null);
  if (!newMessage || oldMessage.content === newMessage.content) return;
  await moderate(newMessage);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.inGuild()) return;
  try {
    await handleCommand(interaction, { store, settings });
  } catch (err) {
    console.error('[command]', err);
    const reply = { content: 'Something went wrong running that command.', flags: MessageFlags.Ephemeral };
    await (interaction.replied || interaction.deferred ? interaction.followUp(reply) : interaction.reply(reply)).catch(() => {});
  }
});

client.login(config.discordToken);
