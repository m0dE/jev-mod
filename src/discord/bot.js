// The Discord bot. One bot serves every customer's servers: a message is moderated only
// when its server is linked to a Jef Bot app (see /jef link and server/discord-callback.js).
// The moderator decides; this file carries the result out on Discord.

import { Client, GatewayIntentBits, Partials, Events, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { config } from '../config.js';
import { migrateLegacy } from '../migrate.js';
import { enforce, logWatch } from './enforce.js';
import { handleCommand } from './commands.js';

// How long to wait after joining a server before saying it needs linking: with "Add to
// server" the callback usually links it within a few seconds.
const LINK_NOTICE_DELAY_MS = 15_000;

/** Channels and roles the app ignores, else the IGNORED_CHANNEL_IDS / EXEMPT_ROLE_IDS env lists. */
function exemptLists(app) {
  return {
    channels: app.settings?.ignoredChannelIds ?? config.ignoredChannelIds,
    roles: app.settings?.exemptRoleIds ?? config.exemptRoleIds,
  };
}

function isExempt(message, app) {
  const { channels, roles } = exemptLists(app);
  if (channels.includes(message.channelId)) return true;
  const member = message.member;
  if (!member) return false;
  if (member.id === message.guild.ownerId) return true;
  if (member.permissions?.has(PermissionFlagsBits.ManageMessages)) return true;
  return roles.some((id) => member.roles?.cache.has(id));
}

async function recentContext(message) {
  const before = await message.channel.messages?.fetch({ limit: 5, before: message.id }).catch(() => null);
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
  const mentioned = message.mentions?.users.first();
  return mentioned ? mentioned.username : null;
}

const mentionCount = (message) => (message.mentions
  ? message.mentions.users.size + message.mentions.roles.size + (message.mentions.everyone ? 10 : 0)
  : 0);

/**
 * The bot's event handlers, separate from the Client so tests can drive them with fakes.
 * Returns { onMessage, onMessageUpdate, onReady, onGuildCreate, onGuildDelete, onInteraction }.
 */
export function createDiscordHandlers({ db, moderator, classifier, log = console, linkNoticeDelayMs = LINK_NOTICE_DELAY_MS }) {
  // Don't process the same message twice if create + update arrive together.
  const inFlight = new Set();

  async function onMessage(message) {
    if (!message.guild || message.author?.bot || message.system || message.webhookId) return;
    if (!message.content || inFlight.has(message.id)) return;
    const app = db.apps.byGuild(message.guild.id);
    if (!app || isExempt(message, app)) return; // unlinked servers aren't moderated

    inFlight.add(message.id);
    try {
      const result = await moderator.moderate(app, {
        userId: message.author.id,
        username: message.author.username,
        text: message.content,
        messageId: message.id,
        room: message.channelId,
        roomName: `#${message.channel.name}`,
        replyTo: await replyTarget(message),
        context: classifier.aiAvailable() ? await recentContext(message) : undefined,
        mentionCount: mentionCount(message),
      });

      if (result.watch) {
        log.log(`[mod] watching ${message.author.tag} in #${message.channel.name}: possible ${result.watch}`);
        await logWatch({ app, message, category: result.watch });
      }
      if (result.allow) return;

      const outcome = await enforce({ app, message, result, log });
      log.log(`[mod] ${message.guild.name} #${message.channel.name} ${message.author.tag}: ${result.category}/${result.severity} → ${outcome} (${result.strikes} active)`);
    } catch (err) {
      log.error('[mod] failed to moderate message', err);
    } finally {
      setTimeout(() => inFlight.delete(message.id), 60_000).unref?.();
    }
  }

  // Catch people who post something clean and then edit it into something else.
  async function onMessageUpdate(oldMessage, newMessage) {
    if (newMessage.partial) newMessage = await newMessage.fetch().catch(() => null);
    if (!newMessage || oldMessage.content === newMessage.content) return;
    await onMessage(newMessage);
  }

  function onReady(client) {
    log.log(`[discord] logged in as ${client.user.tag} in ${client.guilds.cache.size} server(s). AI moderation: ${classifier.aiName?.() ?? 'off — keyword rules only'}.`);
    // The single-server bot's data becomes apps owned by the operator (runs once).
    try {
      migrateLegacy(db, { guilds: [...client.guilds.cache.values()].map((g) => ({ id: g.id, name: g.name })) });
    } catch (err) {
      log.error('[migrate] failed to import the old data', err);
    }
    // Removed while we were offline: the cache has every server we're still in (even ones in an outage).
    for (const app of db.apps.linked()) {
      if (!client.guilds.cache.has(app.discordGuildId)) forget(app);
    }
  }

  // Joined a server: if nobody has linked it yet, say how.
  async function onGuildCreate(guild) {
    log.log(`[discord] added to ${guild.name} (${guild.id})`);
    if (linkNoticeDelayMs) await new Promise((r) => setTimeout(r, linkNoticeDelayMs));
    if (db.apps.byGuild(guild.id)) return;
    const channel = guild.systemChannel;
    const me = guild.members?.me;
    if (!channel || !me || !channel.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)) return;
    await channel.send({
      content: `Thanks for adding **Jef Bot**! This server isn't linked to a Jef Bot app yet, so nothing is moderated. A server manager can create a Discord app at ${config.publicUrl}/app and then run \`/jef link code:<code>\` here.`,
      allowedMentions: { parse: [] },
    }).catch(() => {});
  }

  function forget(app, guildName) {
    db.transaction(() => {
      db.apps.setGuild(app.id, null);
      db.strikes.forgetApp(app.id);
      db.events.forgetApp(app.id);
    })();
    log.log(`[discord] removed from ${guildName ?? app.discordGuildId}; unlinked app ${app.id} and deleted its strikes and history`);
  }

  // Removed from a server: unlink its app and delete the server's strikes and history.
  function onGuildDelete(guild) {
    if (!guild.available) return; // an outage, not a removal
    const app = db.apps.byGuild(guild.id);
    if (app) forget(app, guild.name);
  }

  async function onInteraction(interaction) {
    if (!interaction.isChatInputCommand() || !interaction.inGuild()) return;
    try {
      await handleCommand(interaction, { db, moderator });
    } catch (err) {
      log.error('[command]', err);
      const reply = { content: 'Something went wrong running that command.', flags: MessageFlags.Ephemeral };
      await (interaction.replied || interaction.deferred ? interaction.followUp(reply) : interaction.reply(reply)).catch(() => {});
    }
  }

  return { onMessage, onMessageUpdate, onReady, onGuildCreate, onGuildDelete, onInteraction };
}

export function startDiscordBot({ db, moderator, classifier }) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent, // privileged: enable it in the Developer Portal
      GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Message],
  });
  const h = createDiscordHandlers({ db, moderator, classifier });

  client.once(Events.ClientReady, h.onReady);
  client.on(Events.MessageCreate, h.onMessage);
  client.on(Events.MessageUpdate, h.onMessageUpdate);
  client.on(Events.GuildCreate, (guild) => h.onGuildCreate(guild).catch((err) => console.error('[discord] join notice failed', err)));
  client.on(Events.GuildDelete, (guild) => {
    try {
      h.onGuildDelete(guild);
    } catch (err) {
      console.error('[discord] cleanup after removal failed', err);
    }
  });
  client.on(Events.InteractionCreate, h.onInteraction);

  client.login(config.discordToken).catch((err) => console.error('[discord] login failed:', err.message));
  return { client };
}
