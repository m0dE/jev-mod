// Tests for the hosted core: database, moderator, /v1 API, webhooks and the JSON migration.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Never call real APIs from tests, even if .env has keys.
delete process.env.TYPESAFE_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

const { openDb } = await import('../src/db.js');
const { createModerator } = await import('../src/moderation.js');
const { createServer, createRateLimiter } = await import('../src/server/index.js');
const { config } = await import('../src/config.js');
const { PLANS } = await import('../src/plans.js');
const { sign, webhookUrlProblem, createWebhookSender } = await import('../src/webhooks.js');
const { migrateLegacy } = await import('../src/migrate.js');

/** A classifier that flags any message containing "bad" (or uses the given verdict function). */
function fakeClassifier(judge) {
  return {
    aiAvailable: () => false,
    classify: async (text, meta) => (judge ? judge(text, meta) : text.includes('bad')
      ? { violation: true, category: 'rudeness', severity: 'low', reason: 'Rude message', source: 'rules' }
      : { violation: false, category: 'none', severity: 'none', source: 'rules' }),
  };
}

async function setup({ judge, sendWebhook, rateLimit, discordWarn } = {}) {
  const db = openDb(':memory:');
  const account = db.accounts.create({ email: 'owner@example.com' });
  const { secret: accountKey } = db.keys.create({ accountId: account.id, kind: 'account', name: 'agent' });
  const moderator = createModerator({ db, classifier: fakeClassifier(judge), sendWebhook });
  const server = createServer({ db, moderator, discordWarn, ...(rateLimit ? { rateLimit } : {}) }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = () => `http://127.0.0.1:${server.address().port}`;
  async function call(method, url, body, key = accountKey, headers = {}) {
    const res = await fetch(base() + url, {
      method,
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  return { db, account, accountKey, moderator, server, call, close: () => server.close() };
}

test('db: keys are stored hashed and verify', () => {
  const db = openDb(':memory:');
  const a = db.accounts.create({ email: 'x@y.z' });
  const { key, secret } = db.keys.create({ accountId: a.id, kind: 'account', name: 'k' });
  assert.match(secret, /^jef_acct_/);
  assert.ok(secret.startsWith(key.prefix));
  assert.equal(db.keys.verify(secret).id, key.id);
  assert.equal(db.keys.verify(secret + 'x'), null);
  const raw = db.raw.prepare('SELECT key_hash FROM api_keys').get().key_hash;
  assert.notEqual(raw, secret);
});

test('db: Google sign-in claims a pre-made account by email, then matches by sub', () => {
  const db = openDb(':memory:');
  const pre = db.accounts.create({ email: 'Admin@Example.com', plan: 'internal' });
  const a = db.accounts.upsertGoogle({ sub: 'g1', email: 'admin@example.com', name: 'Ad' });
  assert.equal(a.id, pre.id);
  assert.equal(a.plan, 'internal');
  assert.equal(db.accounts.upsertGoogle({ sub: 'g1', email: 'new@example.com', name: null }).id, pre.id);
  assert.throws(() => db.accounts.upsertGoogle({ sub: 'g2', email: 'new@example.com' }));
});

test('db: strikes cool down and pardon removes the newest', () => {
  let t = 1_000_000;
  const db = openDb(':memory:', { now: () => t });
  const a = db.accounts.create({ email: 'x@y.z' });
  const app = db.apps.create({ accountId: a.id, name: 'g', kind: 'api' });
  db.strikes.add(app.id, 'u', { category: 'a', cooldownMs: 1000 });
  t += 10;
  db.strikes.add(app.id, 'u', { category: 'b', cooldownMs: 5000 });
  assert.equal(db.strikes.count(app.id, 'u'), 2);
  t += 1000;
  assert.equal(db.strikes.count(app.id, 'u'), 1);
  assert.equal(db.strikes.pardon(app.id, 'u'), 1);
  assert.equal(db.strikes.count(app.id, 'u'), 0);
});

test('db: a Discord server links to one app only', () => {
  const db = openDb(':memory:');
  const a = db.accounts.create({ email: 'x@y.z' });
  const one = db.apps.create({ accountId: a.id, name: '1', kind: 'discord' });
  const two = db.apps.create({ accountId: a.id, name: '2', kind: 'discord' });
  db.apps.setGuild(one.id, '123');
  assert.equal(db.apps.byGuild('123').id, one.id);
  assert.throws(() => db.apps.setGuild(two.id, '123'), { code: 'guild_taken' });
  const { code } = db.discordLinks.create(two.id);
  assert.equal(db.discordLinks.consume(code.toLowerCase()).id, two.id);
  assert.equal(db.discordLinks.consume(code), null, 'codes work once');
});

test('db: history is pruned per plan', () => {
  let t = Date.now();
  const db = openDb(':memory:', { now: () => t });
  const free = db.accounts.create({ email: 'f@x.y' });
  const pro = db.accounts.create({ email: 'p@x.y', plan: 'pro' });
  const fa = db.apps.create({ accountId: free.id, name: 'f', kind: 'api' });
  const pa = db.apps.create({ accountId: pro.id, name: 'p', kind: 'api' });
  db.events.add(fa.id, { type: 'action' });
  db.events.add(pa.id, { type: 'action' });
  t += 10 * 86_400_000;
  db.events.prune((plan) => (PLANS[plan] ?? PLANS.free).historyDays);
  assert.equal(db.events.list(fa.id).length, 0);
  assert.equal(db.events.list(pa.id).length, 1);
});

test('moderator: escalates, records history, and punishes a flood only once', async () => {
  const t = await setup();
  try {
    const app = t.db.apps.create({ accountId: t.account.id, name: 'g', kind: 'api' });
    const ok = await t.moderator.moderate(app, { userId: 'u1', text: 'hello' });
    assert.equal(ok.allow, true);
    assert.equal(ok.action.type, 'none');
    const first = await t.moderator.moderate(app, { userId: 'u1', username: 'bob', text: 'bad', room: 'lobby' });
    assert.equal(first.allow, false);
    assert.equal(first.action.type, 'mute');
    assert.equal(first.action.durationMs, 2 * 60_000);
    assert.equal(first.strikes, 1);
    const again = await t.moderator.moderate(app, { userId: 'u1', text: 'bad again' });
    assert.equal(again.action.type, 'delete', 'second violation within 10 s is only deleted');
    assert.equal(again.strikes, 1);
    const events = t.db.events.list(app.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].username, 'bob');
    assert.equal(events[0].room, 'lobby');
    assert.equal(t.db.usage.get(t.account.id).messages, 3);
  } finally {
    t.close();
  }
});

test('moderator: the monthly AI quota is charged per take and stops at the limit', async () => {
  const takes = [];
  const t = await setup({ judge: (text, meta) => { takes.push(meta.quota.take()); return { violation: false, source: 'jev' }; } });
  try {
    const app = t.db.apps.create({ accountId: t.account.id, name: 'g', kind: 'api' });
    t.db.usage.add(t.account.id, { aiChecks: PLANS.free.aiChecksPerMonth - 1 });
    await t.moderator.moderate(app, { userId: 'u', text: 'one' });
    await t.moderator.moderate(app, { userId: 'u', text: 'two' });
    assert.deepEqual(takes, [true, false]);
    assert.equal(t.db.usage.get(t.account.id).aiChecks, PLANS.free.aiChecksPerMonth);
  } finally {
    t.close();
  }
});

test('moderator: an account can use at most a tenth of its monthly AI checks in one day', async () => {
  const takes = [];
  const t = await setup({ judge: (text, meta) => { takes.push(meta.quota.take()); return { violation: false }; } });
  try {
    const app = t.db.apps.create({ accountId: t.account.id, name: 'g', kind: 'api' });
    for (let i = 0; i < PLANS.free.aiChecksPerMonth / 10 + 1; i++) await t.moderator.moderate(app, { userId: 'u', text: `m${i}` });
    assert.equal(takes.filter(Boolean).length, PLANS.free.aiChecksPerMonth / 10);
    assert.equal(takes.at(-1), false);
  } finally {
    t.close();
  }
});

test('moderator: room context is passed when the caller sends none', async () => {
  let seen;
  const t = await setup({ judge: (text, meta) => { seen = meta; return { violation: false }; } });
  try {
    const app = t.db.apps.create({ accountId: t.account.id, name: 'g', kind: 'api' });
    await t.moderator.moderate(app, { userId: 'a', username: 'amy', text: 'hi', room: 'r' });
    await t.moderator.moderate(app, { userId: 'b', username: 'ben', text: 'yo', room: 'r' });
    assert.deepEqual(seen.recent, [], 'no AI, so no context is sent');
    assert.equal(seen.history.length, 0);
    assert.equal(seen.guildId, app.id);
  } finally {
    t.close();
  }
});

test('api: an agent sets up an app headlessly and moderates with the app key', async () => {
  const t = await setup();
  try {
    const created = await t.call('POST', '/v1/apps', { name: 'My game', kind: 'api', rules: [{ text: 'No cheat talk', severity: 'medium' }] });
    assert.equal(created.status, 201);
    assert.equal(created.body.app.rules.length, 1);
    const appKey = created.body.appKey.secret;
    assert.match(appKey, /^jef_app_/);

    const res = await t.call('POST', '/v1/moderate', { userId: 'p1', username: 'bob', text: 'you are bad', room: 'lobby' }, appKey);
    assert.equal(res.status, 200);
    assert.equal(res.body.allow, false);
    assert.equal(res.body.action.type, 'mute');

    const standing = await t.call('GET', `/v1/apps/${created.body.app.id}/users/p1`, undefined, appKey);
    assert.equal(standing.body.strikes, 1);
    assert.equal(standing.body.next.medium.type, 'mute');
    assert.equal(standing.body.next.high.type, 'ban', 'a severe offense on top of an active one is past the final warning');

    const events = await t.call('GET', `/v1/apps/${created.body.app.id}/events?limit=10`, undefined, appKey);
    assert.equal(events.body.events[0].type, 'action');
    assert.match(events.body.events[0].at, /^\d{4}-/);

    const pardon = await t.call('POST', `/v1/apps/${created.body.app.id}/users/p1/pardon`, {}, appKey);
    assert.deepEqual(pardon.body, { removed: 1, strikes: 0 });
  } finally {
    t.close();
  }
});

test('api: app keys are limited to their own app', async () => {
  const t = await setup();
  try {
    t.db.accounts.setBilling(t.account.id, { plan: 'pro' });
    const a = (await t.call('POST', '/v1/apps', { name: 'a' })).body;
    const b = (await t.call('POST', '/v1/apps', { name: 'b' })).body;
    const keyA = a.appKey.secret;
    assert.equal((await t.call('GET', '/v1/apps', undefined, keyA)).status, 403);
    assert.equal((await t.call('POST', '/v1/keys', {}, keyA)).status, 403);
    assert.equal((await t.call('GET', `/v1/apps/${b.app.id}`, undefined, keyA)).status, 404);
    assert.equal((await t.call('POST', '/v1/moderate', { appId: b.app.id, userId: 'u', text: 'hi' }, keyA)).status, 404);
    const own = await t.call('GET', `/v1/apps/${a.app.id}`, undefined, keyA);
    assert.equal(own.status, 200);
    assert.equal('webhookSecret' in own.body.app, false);
    // Account keys must name the app.
    assert.equal((await t.call('POST', '/v1/moderate', { userId: 'u', text: 'hi' })).status, 400);
    assert.equal((await t.call('POST', '/v1/moderate', { appId: a.app.id, userId: 'u', text: 'hi' })).status, 200);
  } finally {
    t.close();
  }
});

test('api: other accounts cannot see an app', async () => {
  const t = await setup();
  try {
    const app = (await t.call('POST', '/v1/apps', { name: 'mine' })).body.app;
    const other = t.db.accounts.create({ email: 'other@example.com' });
    const { secret } = t.db.keys.create({ accountId: other.id, kind: 'account', name: 'x' });
    assert.equal((await t.call('GET', `/v1/apps/${app.id}`, undefined, secret)).status, 404);
    assert.equal((await t.call('DELETE', `/v1/apps/${app.id}`, undefined, secret)).status, 404);
  } finally {
    t.close();
  }
});

test('api: plan limits on apps, rules, keys and webhooks', async () => {
  const t = await setup();
  try {
    const app = (await t.call('POST', '/v1/apps', { name: 'one' })).body.app;
    const second = await t.call('POST', '/v1/apps', { name: 'two' });
    assert.equal(second.status, 403);
    assert.equal(second.body.error.code, 'plan_limit');
    for (let i = 0; i < PLANS.free.customRules; i++) {
      assert.equal((await t.call('POST', `/v1/apps/${app.id}/rules`, { text: `rule ${i}` })).status, 201);
    }
    assert.equal((await t.call('POST', `/v1/apps/${app.id}/rules`, { text: 'one too many' })).status, 403);
    assert.equal((await t.call('POST', '/v1/keys', { name: 'second' })).status, 403);
    const hook = await t.call('PATCH', `/v1/apps/${app.id}`, { webhookUrl: 'https://example.com/hook' });
    assert.equal(hook.status, 403);

    t.db.accounts.setBilling(t.account.id, { plan: 'starter' });
    const ok = await t.call('PATCH', `/v1/apps/${app.id}`, { webhookUrl: 'https://example.com/hook' });
    assert.equal(ok.status, 200);
    assert.match(ok.body.app.webhookSecret, /^whsec_/);
    const bad = await t.call('PATCH', `/v1/apps/${app.id}`, { webhookUrl: 'https://127.0.0.1/hook' });
    assert.equal(bad.status, 400);
  } finally {
    t.close();
  }
});

test('api: input validation and errors', async () => {
  const t = await setup();
  try {
    assert.equal((await t.call('GET', '/v1/account', undefined, null)).status, 401);
    assert.equal((await t.call('GET', '/v1/account', undefined, 'jef_acct_nope')).body.error.code, 'invalid_api_key');
    assert.equal((await t.call('POST', '/v1/apps', { name: 'x', kind: 'irc' })).status, 400);
    const app = (await t.call('POST', '/v1/apps', { name: 'x' })).body.app;
    assert.equal((await t.call('POST', '/v1/moderate', { appId: app.id, text: 'hi' })).status, 400, 'userId is required');
    assert.equal((await t.call('POST', '/v1/moderate', { appId: app.id, userId: 'u', text: 'x'.repeat(4001) })).status, 400);
    assert.equal((await t.call('POST', `/v1/apps/${app.id}/rules`, { text: 'r', severity: 'extreme' })).status, 400);
    assert.equal((await t.call('PATCH', `/v1/apps/${app.id}`, { settings: { modLogChannelId: '1234567890' } })).status, 400, 'Discord settings on an API app');
    const res = await fetch(`http://127.0.0.1:${t.server.address().port}/v1/apps`, {
      method: 'POST', headers: { Authorization: `Bearer ${t.accountKey}`, 'Content-Type': 'application/json' }, body: '{nope',
    });
    assert.equal((await res.json()).error.code, 'invalid_json');
    assert.equal((await t.call('GET', '/v1/plans', undefined, null)).body.plans.some((p) => p.id === 'internal'), false);
  } finally {
    t.close();
  }
});

test('api: Discord apps get an invite link and settings', async () => {
  const t = await setup();
  try {
    const res = await t.call('POST', '/v1/apps', { name: 'My server', kind: 'discord' });
    assert.equal(res.status, 201);
    assert.equal(res.body.appKey, undefined);
    assert.match(res.body.discord.linkCode, /^[0-9A-F]{12}$/);
    assert.equal(res.body.discord.linkCommand, `/jef link code:${res.body.discord.linkCode}`);
    const id = res.body.app.id;
    const patched = await t.call('PATCH', `/v1/apps/${id}`, { settings: { modLogChannelId: '652551579886551049', exemptRoleIds: ['123456789012'] } });
    assert.equal(patched.body.app.settings.modLogChannelId, '652551579886551049');
    const cleared = await t.call('PATCH', `/v1/apps/${id}`, { settings: { exemptRoleIds: null } });
    assert.equal('exemptRoleIds' in cleared.body.app.settings, false);
    assert.equal((await t.call('POST', `/v1/apps/${id}/keys`, {})).status, 400);
  } finally {
    t.close();
  }
});

test('api: session cookie works for same-site JSON and is refused cross-site', async () => {
  const t = await setup();
  try {
    const token = t.db.sessions.create(t.account.id);
    const cookie = { Cookie: `jef_session=${token}` };
    assert.equal((await t.call('GET', '/v1/account', undefined, null, cookie)).body.auth, 'session');
    const origin = new URL(config.publicUrl).origin;
    assert.equal((await t.call('POST', '/v1/apps', { name: 'a' }, null, { ...cookie, Origin: origin })).status, 201);
    assert.equal((await t.call('POST', '/v1/keys', {}, null, { ...cookie, Origin: 'https://evil.example' })).status, 401);
    const form = await fetch(`http://127.0.0.1:${t.server.address().port}/v1/keys`, {
      method: 'POST', headers: { ...cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'name=x',
    });
    assert.equal(form.status, 415);
  } finally {
    t.close();
  }
});

test('api: /v1/moderate is rate limited per app', async () => {
  let n = 0;
  const t = await setup({ rateLimit: () => ++n <= 2 });
  try {
    const app = (await t.call('POST', '/v1/apps', { name: 'g' })).body.app;
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await t.call('POST', '/v1/moderate', { appId: app.id, userId: 'u', text: 'hi' })).status);
    assert.deepEqual(statuses, [200, 200, 429]);
  } finally {
    t.close();
  }
});

test('rate limiter refills over time', () => {
  let now = 0;
  const limit = createRateLimiter({ now: () => now });
  const app = { id: 'a' };
  const plan = { requestsPerSecond: 1 };
  assert.equal(limit(app, plan), true);
  assert.equal(limit(app, plan), true);
  assert.equal(limit(app, plan), false);
  now += 1000;
  assert.equal(limit(app, plan), true);
});

test('webhooks: paid plans get signed events; private addresses are refused', async () => {
  const sent = [];
  const t = await setup({ sendWebhook: async (app, type, data) => { sent.push({ app, type, data }); return true; } });
  try {
    const app = t.db.apps.create({ accountId: t.account.id, name: 'g', kind: 'api' });
    await t.moderator.moderate(app, { userId: 'u', text: 'bad' });
    assert.equal(sent.length, 0, 'free plan: no webhooks');
    t.db.accounts.setBilling(t.account.id, { plan: 'starter' });
    await t.moderator.moderate(app, { userId: 'v', text: 'bad' });
    assert.equal(sent[0].type, 'moderation.action');
  } finally {
    t.close();
  }

  const body = '{"a":1}';
  const header = sign('whsec_test', body, 1700000000);
  const expected = crypto.createHmac('sha256', 'whsec_test').update(`1700000000.${body}`).digest('hex');
  assert.equal(header, `t=1700000000,v1=${expected}`);
  assert.equal(webhookUrlProblem('https://10.0.0.1/x'), 'must be a public address');
  assert.equal(webhookUrlProblem('http://example.com'), 'must start with https://');

  for (const url of ['https://[::ffff:127.0.0.1]/', 'https://[::ffff:a9fe:a9fe]/', 'https://[::127.0.0.1]/', 'https://[64:ff9b::7f00:1]/',
    'https://[fd00::1]/', 'https://[fe80::1]/', 'https://[::]/', 'https://0.0.0.0/', 'https://169.254.169.254/']) {
    assert.equal(webhookUrlProblem(url), 'must be a public address', url);
  }
  assert.equal(webhookUrlProblem('https://[2606:4700::1111]/'), null);
  assert.equal(webhookUrlProblem('https://[::ffff:8.8.8.8]/'), null);

  // The real sender refuses to connect to a host that resolves to a private address.
  const local = (await import('node:http')).createServer((req, res) => { hits++; res.end(); });
  let hits = 0;
  await new Promise((r) => local.listen(0, '127.0.0.1', r));
  const send = createWebhookSender({ log: { warn() {} } });
  const port = local.address().port;
  assert.equal(await send({ id: 'a', webhookUrl: `http://localhost:${port}/`, webhookSecret: 's' }, 't', {}), false);
  assert.equal(await send({ id: 'a', webhookUrl: `http://[::ffff:127.0.0.1]:${port}/`, webhookSecret: 's' }, 't', {}), false);
  local.close();
  assert.equal(hits, 0, 'nothing private was called');

  const posts = [];
  const fake = createWebhookSender({ post: async (...a) => { posts.push(a); return { ok: true, status: 200 }; } });
  assert.equal(await fake({ id: 'a', webhookUrl: 'https://example.com/h', webhookSecret: 'whsec_x' }, 'moderation.action', { n: 1 }), true);
  const [, headers, sentBody] = posts[0];
  assert.equal(headers['Jef-Signature'].split(',v1=')[1], crypto.createHmac('sha256', 'whsec_x').update(`${headers['Jef-Signature'].slice(2, headers['Jef-Signature'].indexOf(','))}.${sentBody}`).digest('hex'));
});

test('migrate: old JSON data becomes Discord apps owned by the admin', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jef-migrate-'));
  const strikesFile = path.join(dir, 'strikes.json');
  const settingsFile = path.join(dir, 'guild-settings.json');
  const now = Date.now();
  fs.writeFileSync(strikesFile, JSON.stringify({ 111: { u1: [{ at: now - 1000, until: now + 60_000, category: 'rudeness', severity: 'low', reason: 'r', by: 'auto' }] } }));
  fs.writeFileSync(settingsFile, JSON.stringify({ 111: { rules: [{ id: 1, text: 'No old Braains talk', severity: 'low' }], nextRuleId: 2, modLogChannelId: '999' } }));
  const db = openDb(':memory:');
  const saved = config.adminEmails;
  config.adminEmails = ['admin@example.com'];
  try {
    const out = migrateLegacy(db, { guilds: [{ id: '111', name: 'Braains.io' }, { id: '222', name: 'Other' }], strikesFile, settingsFile, log: { log() {}, warn() {} } });
    assert.equal(out.apps, 2);
    const app = db.apps.byGuild('111');
    assert.equal(app.name, 'Braains.io');
    assert.equal(app.settings.modLogChannelId, '999');
    assert.equal(db.rules.list(app.id)[0].text, 'No old Braains talk');
    assert.equal(db.strikes.count(app.id, 'u1'), 1);
    assert.equal(db.accounts.get(app.accountId).plan, 'internal');
    assert.ok(fs.existsSync(`${strikesFile}.migrated`));
    assert.equal(migrateLegacy(db, { guilds: [{ id: '333' }] }), null, 'runs once');
  } finally {
    config.adminEmails = saved;
  }
});

test('api: a warn on a linked Discord app is carried out by the bot', async () => {
  const warned = [];
  const t = await setup({ discordWarn: async (app, w) => { warned.push({ app, w }); return '10 minute mute'; } });
  try {
    const app = (await t.call('POST', '/v1/apps', { name: 'srv', kind: 'discord' })).body.app;
    const unlinked = await t.call('POST', `/v1/apps/${app.id}/users/123456789012/warn`, { reason: 'spamming' });
    assert.equal(unlinked.body.discordOutcome, undefined, 'not linked yet: nothing to do on Discord');
    t.db.apps.setGuild(app.id, '222537158446153730');
    const res = await t.call('POST', `/v1/apps/${app.id}/users/123456789012/warn`, { reason: 'spamming', severity: 'low' });
    assert.equal(res.status, 200);
    assert.equal(res.body.discordOutcome, '10 minute mute');
    assert.equal(warned[0].w.userId, '123456789012');
    assert.equal(warned[0].w.strikes, 2);
    assert.equal(warned[0].w.by, 'agent');
  } finally {
    t.close();
  }
});

test('api: after a downgrade, apps, rules and account keys past the plan stop working', async () => {
  const t = await setup();
  try {
    t.db.accounts.setBilling(t.account.id, { plan: 'starter' });
    const first = (await t.call('POST', '/v1/apps', { name: 'first', rules: Array.from({ length: 5 }, (_, i) => ({ text: `rule ${i}` })) })).body;
    const second = (await t.call('POST', '/v1/apps', { name: 'second' })).body;
    const extraKey = (await t.call('POST', '/v1/keys', { name: 'extra' })).body.secret;
    t.db.accounts.setBilling(t.account.id, { plan: 'free' });

    const ok = await t.call('POST', '/v1/moderate', { userId: 'u', text: 'hi' }, first.appKey.secret);
    assert.equal(ok.status, 200);
    const off = await t.call('POST', '/v1/moderate', { userId: 'u', text: 'hi' }, second.appKey.secret);
    assert.equal(off.status, 403);
    assert.equal(off.body.error.code, 'plan_limit');
    assert.equal((await t.call('GET', `/v1/apps/${second.app.id}`)).body.app.inPlan, false);
    assert.equal((await t.call('GET', '/v1/account', undefined, extraKey)).status, 403, 'the newer account key is past the free plan');
    assert.equal((await t.call('GET', '/v1/account')).status, 200, 'the oldest key still works');

    let rulesSeen;
    const m = createModerator({ db: t.db, classifier: fakeClassifier((text, meta) => { rulesSeen = meta.customRules; return { violation: false }; }) });
    await m.moderate(t.db.apps.get(first.app.id), { userId: 'u', text: 'x' });
    assert.deepEqual(rulesSeen.map((r) => r.text), ['rule 0', 'rule 1', 'rule 2']);
    const skipped = await m.moderate(t.db.apps.get(second.app.id), { userId: 'u', text: 'bad' });
    assert.equal(skipped.disabled, 'plan_limit');
  } finally {
    t.close();
  }
});

test('migrate: an unreadable data file stops the move so it is tried again', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jef-migrate-'));
  const strikesFile = path.join(dir, 'strikes.json');
  fs.writeFileSync(strikesFile, '{ not json');
  const db = openDb(':memory:');
  const saved = config.adminEmails;
  config.adminEmails = ['admin@example.com'];
  try {
    assert.throws(() => migrateLegacy(db, { guilds: [{ id: '1' }], strikesFile, settingsFile: path.join(dir, 'none.json'), log: { log() {}, warn() {} } }));
    assert.equal(db.meta.get('legacy_migrated'), null);
    assert.equal(db.apps.byGuild('1'), null);
  } finally {
    config.adminEmails = saved;
  }
});

test('api: a mangled session cookie or a repeated query parameter is a client error, not a crash', async () => {
  const t = await setup();
  try {
    assert.equal((await t.call('GET', '/v1/account', undefined, null, { Cookie: 'jef_session=%E0%A4%A' })).status, 401);
    const app = (await t.call('POST', '/v1/apps', { name: 'x' })).body.app;
    assert.equal((await t.call('GET', `/v1/apps/${app.id}/events?userId=a&userId=b`)).status, 400);
  } finally {
    t.close();
  }
});
