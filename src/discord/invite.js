// The "Add to Discord" link for an app. With DISCORD_CLIENT_SECRET set, Discord sends the
// server manager back to /discord/callback, which links the server to the app on its own;
// without it, they finish with /jef link <code> in the server.

import { config } from '../config.js';

// View Channels, Send Messages, Manage Messages, Embed Links, Read Message History, Ban Members, Moderate Members.
const PERMISSIONS = (1n << 10n) | (1n << 11n) | (1n << 13n) | (1n << 14n) | (1n << 16n) | (1n << 2n) | (1n << 40n);

export function discordInviteUrl(linkCode) {
  if (!config.clientId) return null;
  const params = new URLSearchParams({
    client_id: config.clientId,
    permissions: PERMISSIONS.toString(),
    scope: 'bot applications.commands',
  });
  if (config.discordClientSecret && linkCode) {
    params.set('response_type', 'code');
    params.set('redirect_uri', `${config.publicUrl}/discord/callback`);
    params.set('state', linkCode);
  }
  return `https://discord.com/oauth2/authorize?${params}`;
}
