// Tests for the multi-server Discord side, with fake Discord objects: which messages are
// moderated, carrying out results, /jef link, the "Add to server" callback and cleanup.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { PermissionFlagsBits } from 'discord.js';

// Never call real APIs from tests, even if .env has keys.
delete process.env.TYPESAFE_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

const { config } = await import('../src/config.js');
const { openDb } = await import('../src/db.js');
const { createModerator } = await import('../src/moderation.js');
const { createDiscordHandlers } = await import('../src/discord/bot.js');
const { handleCommand } = await import('../src/discord/commands.js');
const { createDiscordCallbackRouter } = await import('../src/server/discord-callback.js');

// Don't let the operator's .env change what the tests see.
config.ignoredChannelIds = [];
config.exemptRoleIds = [];
config.modLogChannelId = null;

const quiet = { log() {}, warn() {}, error() {} };

/** Flags any message containing "bad". */
function fakeClassifier() {
  return {
    aiAvailable: () => false,
    aiName: () => null,
    classify: async (text) => (text.includes('bad')
      ? { violation: true, category: 'rudeness', severity: 'low', reason: 'Rude message', source: 'rules' }
      : { violation: false, category: 'none', severity: 'none', source: 'rules' }),
  };
}

function setup() {
  const db = openDb(':memory:');
  const account = db.accounts.create({ email: 'owner@example.com' });
  const app = db.apps.create({ accountId: account.id, name: 'My Discord server', kind: 'discord' });
  const classifier = fakeClassifier();
  const calls = [];
  const real = createModerator({ db, classifier });
  // Record what the bot asks the moderator.
  const moderator = { ...real, moderate: async (a, input) => { calls.push({ app: a, input }); return real.moderate(a, input); } };
  const handlers = createDiscordHandlers({ db, moderator, classifier, log: quiet, linkNoticeDelayMs: 0 });
  return { db, account, app, moderator, calls, handlers };
}

const fakeGuild = (id = 'g1', extra = {}) => ({
  id, name: `Guild ${id}`, ownerId: 'owner', available: true,
  members: { ban: async () => {}, fetch: async () => null },
  channels: { cache: new Map(), fetch: async () => null },
  ...extra,
});

let nextId = 1;
function fakeMessage(content, { guild = fakeGuild(), channelId = 'c1', manager = false } = {}) {
  const calls = [];
  return {
    calls,
    id: String(nextId++),
    content,
    guild,
    channelId,
    channel: { id: channelId, name: 'general', toString: () => `<#${channelId}>`, send: async () => ({ delete: async () => {} }) },
    author: { id: 'u1', username: 'kid', tag: 'kid#0001', bot: false, toString: () => '<@u1>', send: async () => calls.push('dm') },
    member: {
      id: 'u1', moderatable: true,
      permissions: { has: () => manager },
      roles: { cache: new Map() },
      timeout: async (ms) => calls.push(`timeout:${ms}`),
    },
    mentions: { users: { size: 0, first: () => undefined }, roles: { size: 0 }, everyone: false },
    delete: async () => calls.push('delete'),
  };
}

function fakeInteraction(commandName, { guild = fakeGuild(), sub = null, options = {}, canManage = true } = {}) {
  const replies = [];
  return {
    replies,
    commandName,
    guild,
    user: { id: 'staff', tag: 'staff#0001', toString: () => '<@staff>' },
    memberPermissions: { has: () => canManage },
    options: {
      getSubcommand: () => sub,
      getString: (n) => options[n] ?? null,
      getInteger: (n) => options[n] ?? null,
      getUser: (n) => options[n] ?? null,
      getChannel: (n) => options[n] ?? null,
    },
    isChatInputCommand: () => true,
    inGuild: () => true,
    reply: async (r) => replies.push(typeof r === 'string' ? r : r.content ?? r.embeds?.[0]?.data?.title),
  };
}

test('messages in a server that is not linked are ignored', async () => {
  const { handlers, calls } = setup();
  const msg = fakeMessage('you are bad');
  await handlers.onMessage(msg);
  assert.equal(calls.length, 0, 'the moderator is never asked');
  assert.deepEqual(msg.calls, []);
});

test('in a linked server the moderator judges each message and violations are carried out', async () => {
  const { db, app, handlers, calls } = setup();
  db.apps.setGuild(app.id, 'g1');

  const clean = fakeMessage('hello all');
  await handlers.onMessage(clean);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].app.id, app.id);
  assert.deepEqual(
    { userId: calls[0].input.userId, text: calls[0].input.text, room: calls[0].input.room, roomName: calls[0].input.roomName },
    { userId: 'u1', text: 'hello all', room: 'c1', roomName: '#general' },
  );
  assert.equal(calls[0].input.context, undefined, 'no context without the AI');
  assert.deepEqual(clean.calls, []);

  const bad = fakeMessage('you are bad');
  await handlers.onMessage(bad);
  assert.ok(bad.calls.includes('delete'));
  assert.ok(bad.calls.includes('dm'));
  assert.ok(bad.calls.includes(`timeout:${2 * 60_000}`), 'first low offense: 2 minute mute');
  assert.equal(db.strikes.count(app.id, 'u1'), 1);

  // Managers, ignored channels and bots are left alone.
  await handlers.onMessage(fakeMessage('you are bad', { manager: true }));
  db.apps.update(app.id, { settings: { ignoredChannelIds: ['quiet'] } });
  await handlers.onMessage(fakeMessage('you are bad', { channelId: 'quiet' }));
  await handlers.onMessage({ ...fakeMessage('you are bad'), author: { id: 'b', bot: true } });
  assert.equal(calls.length, 2);
});

test('/jef link links the server with a code, and refuses a server linked to another account', async () => {
  const { db, account, app, moderator } = setup();
  const guild = fakeGuild('g9');

  const notLinked = fakeInteraction('strikes', { guild, options: { user: { id: 'u1' } } });
  await handleCommand(notLinked, { db, moderator });
  assert.match(notLinked.replies[0], /isn't linked/);

  const bad = fakeInteraction('jef', { guild, sub: 'link', options: { code: 'NOPE' } });
  await handleCommand(bad, { db, moderator });
  assert.match(bad.replies[0], /unknown or has expired/);

  const noPerm = fakeInteraction('jef', { guild, sub: 'link', options: { code: db.discordLinks.create(app.id).code }, canManage: false });
  await handleCommand(noPerm, { db, moderator });
  assert.match(noPerm.replies[0], /Manage Server/);
  assert.equal(db.apps.byGuild('g9'), null);

  const ok = fakeInteraction('jef', { guild, sub: 'link', options: { code: db.discordLinks.create(app.id).code.toLowerCase() } });
  await handleCommand(ok, { db, moderator });
  assert.match(ok.replies[0], /now moderated/);
  assert.equal(db.apps.byGuild('g9').id, app.id);

  const status = fakeInteraction('jef', { guild, sub: 'status' });
  await handleCommand(status, { db, moderator });
  assert.match(status.replies[0], /My Discord server/);

  // Another app on the same account takes the server over.
  const second = db.apps.create({ accountId: account.id, name: 'Second', kind: 'discord' });
  await handleCommand(fakeInteraction('jef', { guild, sub: 'link', options: { code: db.discordLinks.create(second.id).code } }), { db, moderator });
  assert.equal(db.apps.byGuild('g9').id, second.id);
  assert.equal(db.apps.get(app.id).discordGuildId, null);

  // Someone else's app can't.
  const stranger = db.accounts.create({ email: 'other@example.com' });
  const theirs = db.apps.create({ accountId: stranger.id, name: 'Theirs', kind: 'discord' });
  const taken = fakeInteraction('jef', { guild, sub: 'link', options: { code: db.discordLinks.create(theirs.id).code } });
  await handleCommand(taken, { db, moderator });
  assert.match(taken.replies[0], /another account/);
  assert.equal(db.apps.byGuild('g9').id, second.id);

  // API apps can't be linked.
  const api = db.apps.create({ accountId: account.id, name: 'Game', kind: 'api' });
  const wrongKind = fakeInteraction('jef', { guild: fakeGuild('g10'), sub: 'link', options: { code: db.discordLinks.create(api.id).code } });
  await handleCommand(wrongKind, { db, moderator });
  assert.match(wrongKind.replies[0], /API app/);
});

test('/rule add stops at the plan limit', async () => {
  const { db, app, moderator } = setup();
  db.apps.setGuild(app.id, 'g1');
  const add = (text) => {
    const i = fakeInteraction('rule', { sub: 'add', options: { text } });
    return handleCommand(i, { db, moderator }).then(() => i.replies[0]);
  };
  for (const t of ['one', 'two', 'three']) assert.match(await add(t), /Added rule/);
  assert.match(await add('four'), /Free plan allows 3/);
  assert.equal(db.rules.count(app.id), 3);
});

test('leaving a server unlinks its app and deletes its strikes and history', () => {
  const { db, app, handlers } = setup();
  db.apps.setGuild(app.id, 'g1');
  db.strikes.add(app.id, 'u1', { category: 'rudeness', severity: 'low', reason: 'r' });
  db.events.add(app.id, { type: 'action', userId: 'u1' });

  handlers.onGuildDelete({ ...fakeGuild('g1'), available: false });
  assert.equal(db.apps.get(app.id).discordGuildId, 'g1', 'an outage is not a removal');

  handlers.onGuildDelete(fakeGuild('g1'));
  assert.equal(db.apps.get(app.id).discordGuildId, null);
  assert.equal(db.strikes.count(app.id, 'u1'), 0);
  assert.deepEqual(db.events.list(app.id), []);
  assert.ok(db.apps.get(app.id), 'the app itself stays');
});

test('joining an unlinked server posts how to link it', async () => {
  const { db, app, handlers } = setup();
  const sent = [];
  const systemChannel = { permissionsFor: () => ({ has: () => true }), send: async (m) => sent.push(m.content) };
  const guild = (id) => fakeGuild(id, { systemChannel, members: { me: {} } });
  await handlers.onGuildCreate(guild('new'));
  assert.equal(sent.length, 1);
  assert.match(sent[0], /\/jef link/);
  assert.ok(sent[0].includes(`${config.publicUrl}/app`));

  db.apps.setGuild(app.id, 'linked');
  await handlers.onGuildCreate(guild('linked'));
  assert.equal(sent.length, 1, 'nothing when it is already linked');
});

// `token` is the session cookie sent with each request (null = signed out).
async function callbackServer(db, fetchImpl, token = null) {
  const web = express();
  web.use('/discord', createDiscordCallbackRouter({ db, getClient: () => null, fetchImpl, log: quiet }));
  const server = web.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const get = async (query, as = token) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/discord/callback?${new URLSearchParams(query)}`, {
      redirect: 'manual', headers: as ? { Cookie: `jef_session=${as}` } : {},
    });
    return decodeURIComponent(res.headers.get('location').replace(/\+/g, ' '));
  };
  return { server, get };
}

test('the Add to server callback links the server Discord confirms, not the guild_id in the URL', async (t) => {
  const saved = { secret: config.discordClientSecret, clientId: config.clientId };
  config.discordClientSecret = 'shh';
  config.clientId = 'cid';
  t.after(() => { config.discordClientSecret = saved.secret; config.clientId = saved.clientId; });

  const { db, app } = setup();
  const exchanges = [];
  const fetchImpl = async (url, opts) => {
    exchanges.push({ url, body: new URLSearchParams(opts.body) });
    return { ok: true, json: async () => ({ access_token: 'x', guild: { id: 'real-guild', name: 'Braains' } }) };
  };
  const { server, get } = await callbackServer(db, fetchImpl, db.sessions.create(app.accountId));
  t.after(() => server.close());

  const { code } = db.discordLinks.create(app.id);
  assert.equal(await get({ code: 'oauth-code', state: code }, null), '/app?discord=error&reason=signed_out');
  assert.equal(exchanges.length, 0, 'signed out: Discord is not even asked');
  const location = await get({ code: 'oauth-code', state: code, guild_id: 'forged-guild' });
  assert.equal(location, `/app/apps/${app.id}?discord=linked`);
  assert.equal(exchanges[0].url, 'https://discord.com/api/oauth2/token');
  assert.equal(exchanges[0].body.get('code'), 'oauth-code');
  assert.equal(exchanges[0].body.get('client_secret'), 'shh');
  assert.equal(exchanges[0].body.get('redirect_uri'), `${config.publicUrl}/discord/callback`);
  assert.equal(db.apps.byGuild('real-guild').id, app.id);
  assert.equal(db.apps.byGuild('forged-guild'), null);
  assert.equal(db.apps.get(app.id).name, 'Braains', 'the default name becomes the server name');

  assert.equal(await get({ code: 'again', state: code }), '/app?discord=error&reason=expired', 'a link code works once');

  // Someone else's invite link can't attach your server to their account.
  const stranger = db.accounts.create({ email: 'other@example.com' });
  const theirs = db.apps.create({ accountId: stranger.id, name: 'Theirs', kind: 'discord' });
  const theirCode = db.discordLinks.create(theirs.id).code;
  assert.equal(await get({ code: 'c', state: theirCode }), '/app?discord=error&reason=not_owner');
  assert.equal(db.apps.get(theirs.id).discordGuildId, null);
  assert.ok(db.discordLinks.peek(theirCode), 'the code is not used up for its owner');

  // A server already linked to someone else's app stays theirs.
  const taken = await get({ code: 'c', state: theirCode }, db.sessions.create(stranger.id));
  assert.equal(taken, `/app/apps/${theirs.id}?discord=error&reason=guild_taken`);
  assert.equal(db.apps.byGuild('real-guild').id, app.id);
});

test('the callback refuses when Discord does not confirm, and without a client secret', async (t) => {
  const saved = config.discordClientSecret;
  t.after(() => { config.discordClientSecret = saved; });
  const { db, app } = setup();
  const { server, get } = await callbackServer(db, async () => ({ ok: false, status: 400, json: async () => ({}) }), db.sessions.create(app.accountId));
  t.after(() => server.close());

  config.discordClientSecret = null;
  assert.equal(await get({ code: 'c', state: db.discordLinks.create(app.id).code, guild_id: 'g' }), '/app?discord=error&reason=not_set_up');

  config.discordClientSecret = 'shh';
  const location = await get({ code: 'c', state: db.discordLinks.create(app.id).code, guild_id: 'g' });
  assert.equal(location, `/app/apps/${app.id}?discord=error&reason=unconfirmed`);
  assert.equal(db.apps.get(app.id).discordGuildId, null);
});

test('on start, servers that removed the bot while it was offline are unlinked and forgotten', () => {
  const { db, app, handlers } = setup();
  db.apps.setGuild(app.id, 'gone');
  db.strikes.add(app.id, 'u1', { category: 'rudeness' });
  const kept = db.apps.create({ accountId: app.accountId, name: 'Still here', kind: 'discord' });
  db.apps.setGuild(kept.id, 'here');
  const client = { user: { tag: 'Jef Bot#0001' }, guilds: { cache: new Map([['here', { id: 'here', name: 'Here' }]]) } };
  // Mark the one-time import done, or onReady would move the real data/ files.
  db.meta.set('legacy_migrated', 'test');
  handlers.onReady(client);
  assert.equal(db.apps.get(app.id).discordGuildId, null);
  assert.equal(db.strikes.count(app.id, 'u1'), 0);
  assert.equal(db.apps.get(kept.id).discordGuildId, 'here');
});

test('/warn refuses to ban without the Ban Members permission', async () => {
  const { db, app, handlers } = setup();
  const guild = fakeGuild('g-warn');
  db.apps.setGuild(app.id, guild.id);
  const target = { id: 'u7', username: 'kid', tag: 'kid#0007', toString: () => '<@u7>', send: async () => {} };
  db.strikes.add(app.id, 'u7', { category: 'rudeness', severity: 'high', cooldownMs: 86_400_000 });
  // Moderate Members but not Ban Members: high on top of an active strike would be a ban.
  const it = fakeInteraction('warn', { guild, options: { user: target, reason: 'slurs', severity: 'high' } });
  it.memberPermissions = { has: (p) => p !== PermissionFlagsBits.BanMembers };
  await handlers.onInteraction(it);
  assert.match(it.replies[0], /Ban Members/);
  assert.equal(db.strikes.count(app.id, 'u7'), 1, 'nothing recorded');
});
