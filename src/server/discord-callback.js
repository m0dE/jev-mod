// GET /discord/callback: where Discord sends a server manager after "Add to server" (when
// DISCORD_CLIENT_SECRET is set). `state` is the app's link code. The server comes from
// exchanging `code` with Discord, never from the guild_id query parameter, which anyone
// could edit to link someone else's server. The person coming back must be signed in as the
// app's owner, so a shared invite link can't attach someone else's server to your account.
// Errors go to the dashboard as a short reason code, which it turns into a message.

import express from 'express';
import { config } from '../config.js';
import { linkAppToGuild } from '../discord/commands.js';
import { SESSION_COOKIE, readCookie } from './api.js';

const TOKEN_URL = 'https://discord.com/api/oauth2/token';
// App names the dashboard or migration give before the real server name is known.
const DEFAULT_NAME = /^(my )?discord server( \d+)?$/i;

export function createDiscordCallbackRouter({ db, getClient = () => null, fetchImpl = (...a) => fetch(...a), log = console }) {
  const router = express.Router();

  const toApp = (res, appId, query) => res.redirect(`/app/apps/${encodeURIComponent(appId)}?${new URLSearchParams(query)}`);
  const toDashboard = (res, reason) => res.redirect(`/app?${new URLSearchParams({ discord: 'error', reason })}`);

  /** The server the bot was just added to, from Discord itself: { id, name } or null. */
  async function exchange(code) {
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: config.clientId ?? '',
        client_secret: config.discordClientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${config.publicUrl}/discord/callback`,
      }).toString(),
    });
    if (!res.ok) {
      log.warn(`[discord] OAuth code exchange failed: ${res.status}`);
      return null;
    }
    const body = await res.json().catch(() => null);
    return body?.guild?.id ? { id: String(body.guild.id), name: body.guild.name ?? null } : null;
  }

  router.get('/callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (!config.discordClientSecret) return toDashboard(res, 'not_set_up');
    if (error || typeof code !== 'string' || typeof state !== 'string') {
      return toDashboard(res, error === 'access_denied' ? 'cancelled' : 'no_code');
    }
    // Check who's here before using the code up, so the owner can still use it.
    const account = db.sessions.account(readCookie(req, SESSION_COOKIE));
    if (!account) return toDashboard(res, 'signed_out');
    const pending = db.discordLinks.peek(state);
    if (pending && pending.accountId !== account.id) {
      log.warn(`[discord] refused Add to server for app ${pending.id}: signed in as a different account`);
      return toDashboard(res, 'not_owner');
    }

    const app = db.discordLinks.consume(state);
    if (!app) return toDashboard(res, 'expired');
    const fail = (reason) => toApp(res, app.id, { discord: 'error', reason });
    if (app.kind !== 'discord') return fail('not_discord');

    let guild;
    try {
      guild = await exchange(code);
    } catch (err) {
      log.warn(`[discord] OAuth code exchange failed: ${err.message}`);
    }
    if (!guild) return fail('unconfirmed');

    const linked = linkAppToGuild(db, app, guild.id);
    if (!linked.ok) return fail(linked.code);

    const name = guild.name ?? getClient()?.guilds?.cache.get(guild.id)?.name;
    if (name && DEFAULT_NAME.test(linked.app.name)) db.apps.update(app.id, { name: name.slice(0, 80) });
    log.log(`[discord] linked server ${guild.id} to app ${app.id} via Add to server`);
    return toApp(res, app.id, { discord: 'linked' });
  });

  return router;
}
