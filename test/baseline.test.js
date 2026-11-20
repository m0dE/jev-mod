// The Nov 2026 moderation changes: 5 minute first mutes for every app (old and new), the
// built-in baseline that every app gets on top of its own rules, keyword fixes, the mod-log
// fallback and the startup health check. Jev scores below are real answers Jev gave for
// these messages on 2026-11-20 (baseline_* = the dedicated yes/no questions).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';

delete process.env.TYPESAFE_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

const { config } = await import('../src/config.js');
const { openDb } = await import('../src/db.js');
const { createModerator } = await import('../src/moderation.js');
const { createClassifier } = await import('../src/classifier.js');
const { createRuleClassifier } = await import('../src/rules.js');
const { jevRequest, jevVerdict, BASELINE } = await import('../src/jev.js');
const { DailyBudget } = await import('../src/budget.js');
const { findLogChannel, resolveModLog } = await import('../src/discord/enforce.js');
const { createDiscordHandlers } = await import('../src/discord/bot.js');

config.modLogChannelId = null;
const MIN = 60_000;
const quiet = { log() {}, warn() {}, error() {} };

// [message, category choice + p, baseline scores {threat, hate, insult, drama, griefing}]
const TOXIC = [
  ['and now it dead dead game nice work', ['none', 0.71], { threat: 0.03, hate: 0.02, insult: 0.45, drama: 0.94, griefing: 0.11 }, 'negativity', 'low'],
  ['dev should really kill himself tbh', ['toxicity', 0.98], { threat: 0.99, hate: 0.07, insult: 0.88, drama: 0.95, griefing: 0.06 }, 'threat', 'high'],
  ['you are all braindead losers', ['rudeness', 0.67], { threat: 0.02, hate: 0.05, insult: 0.97, drama: 0.88, griefing: 0.09 }, 'rudeness', 'low'],
  ['you guys are honestly pathetic', ['rudeness', 0.82], { threat: 0.02, hate: 0.03, insult: 0.94, drama: 0.92, griefing: 0.02 }, 'rudeness', 'low'],
  ['ur mom is so fat lmao', ['rudeness', 0.81], { threat: 0.02, hate: 0.05, insult: 0.94, drama: 0.20, griefing: 0.06 }, 'rudeness', 'low'],
  ['lets all go spam the new players and ruin their games lol', ['griefing', 1.0], { threat: 0.04, hate: 0.02, insult: 0.15, drama: 0.62, griefing: 0.98 }, 'griefing', 'medium'],
  ['this server is a joke, mods are clowns', ['negativity', 0.6], { threat: 0.02, hate: 0.02, insult: 0.94, drama: 0.97, griefing: 0.02 }, 'rudeness', 'low'],
];
const BANTER = [
  ['gg ez noobs, rematch?', ['none', 0.83], { threat: 0.02, hate: 0.03, insult: 0.23, drama: 0.05, griefing: 0.04 }],
  ['nah ur trash at this game bro 😂', ['none', 0.88], { threat: 0.02, hate: 0.02, insult: 0.30, drama: 0.04, griefing: 0.04 }],
  ['lmao you suck', ['none', 0.6], { threat: 0.02, hate: 0.02, insult: 0.72, drama: 0.21, griefing: 0.05 }],
  ['get good scrub', ['none', 0.9], { threat: 0.03, hate: 0.09, insult: 0.19, drama: 0.11, griefing: 0.09 }],
  ['i got him now', ['none', 0.98], { threat: 0.08, hate: 0.02, insult: 0.05, drama: 0.04, griefing: 0.04 }],
  ['this boss fight is killing me', ['none', 1.0], { threat: 0.02, hate: 0.01, insult: 0.02, drama: 0.03, griefing: 0.0 }],
  ['The game lwky needed a refresh of players', ['none', 0.95], { threat: 0.01, hate: 0.02, insult: 0.13, drama: 0.11, griefing: 0.03 }],
  ['why is the server so dead today', ['none', 0.9], { threat: 0.01, hate: 0.01, insult: 0.05, drama: 0.33, griefing: 0.01 }],
  ['i spawn camped that guy for 10 minutes lmao', ['none', 0.9], { threat: 0.02, hate: 0.01, insult: 0.15, drama: 0.05, griefing: 0.50 }],
  ['your nick is old', ['none', 0.9], { threat: 0.01, hate: 0.02, insult: 0.35, drama: 0.19, griefing: 0.02 }],
];

const answersFor = ([choice, p], baseline) => ({
  category: { choice, probabilities: { [choice]: p } },
  severity: { choice: 'medium' },
  scam: { noul: 0.01 }, advertising: { noul: 0.01 },
  ...Object.fromEntries(Object.entries(baseline).map(([k, v]) => [`baseline_${k}`, { noul: v }])),
});

function setupDb() {
  const clock = { now: Date.now() };
  const db = openDb(':memory:', { now: () => clock.now });
  const account = db.accounts.create({ email: 'owner@example.com', plan: 'internal' });
  return { db, account, clock };
}

test('first-offense mute is 5 minutes, also for servers linked before the change', async () => {
  const { db, account } = setupDb();
  // An app as it exists in production: linked long ago, with its own rules and old settings.
  const old = db.apps.create({ accountId: account.id, name: 'Braains.io', kind: 'discord' });
  db.apps.setGuild(old.id, '222537158446153730');
  db.apps.update(old.id, { settings: { modLogChannelId: '652551579886551049' } });
  db.rules.add(old.id, 'No asking for old Braains', 'low');
  const moderator = createModerator({ db, classifier: { aiAvailable: () => false, classify: async () => ({ violation: false }) } });

  const next = moderator.standing(db.apps.byGuild('222537158446153730'), 'u').next;
  assert.equal(next.low.durationMs, 5 * MIN);
  assert.equal(next.low.label, '5 minute mute');
  assert.equal(next.medium.durationMs, 5 * MIN, 'toxic, negative or griefing: 5 minutes first');
  assert.equal(next.high.durationMs, 24 * 60 * MIN, 'high toxicity: 24 hours');
  assert.equal(moderator.standing(old, 'u').next.low.durationMs, 5 * MIN);
});

test('every full Jev check asks the baseline questions, with or without custom rules', () => {
  const plain = jevRequest('hi', {});
  const custom = jevRequest('hi', { customRules: [{ id: 7, text: 'No old Braains', severity: 'low' }] });
  for (const req of [plain, custom]) {
    for (const k of Object.keys(BASELINE)) assert.equal(req.questions[`baseline_${k}`]?.type, 'noul', k);
  }
  assert.ok(custom.questions.custom_7, 'custom rules still asked on top');
  assert.deepEqual(Object.keys(BASELINE).sort(), ['drama', 'griefing', 'hate', 'insult', 'threat']);
});

test('baseline catches obvious toxic messages (real Jev scores)', () => {
  for (const [text, cat, base, category, severity] of TOXIC) {
    const v = jevVerdict(answersFor(cat, base));
    assert.equal(v.violation, true, text);
    assert.equal(v.category, category, text);
    assert.equal(v.severity, severity, text);
    assert.equal(v.standalone, true, `${text}: acted on without waiting for a pattern`);
  }
});

test('baseline lets normal banter and civil criticism through (real Jev scores)', () => {
  for (const [text, cat, base] of BANTER) assert.equal(jevVerdict(answersFor(cat, base)).violation, false, text);
});

test('a custom rule and the baseline together: the server rule names the reason', () => {
  const rule = { id: 2, text: 'No diss about our games', severity: 'low' };
  const a = { ...answersFor(['none', 0.71], { drama: 0.94 }), custom_2: { noul: 0.9 } };
  const v = jevVerdict(a, 0.9, [rule]);
  assert.equal(v.category, 'custom');
  assert.equal(v.others[0].category, 'negativity');
});

test('baseline end to end: classifier + moderator, toxic is muted 5 min, banter allowed, threat 24 h', async () => {
  const scores = new Map([...TOXIC, ...BANTER].map(([text, cat, base]) => [text, answersFor(cat, base)]));
  const jevClient = { decide: async (body) => ({ answers: scores.get(body.state.message_to_judge.content) }) };
  const logs = [];
  const classifier = createClassifier({
    jevClient, gate: { check: async () => 1 }, budget: new DailyBudget({ limit: 0 }),
    ruleClassifier: createRuleClassifier({ blockedWords: [] }), log: { log: (l) => logs.push(l) },
  });
  const { db, account } = setupDb();
  const app = db.apps.create({ accountId: account.id, name: "m0dE's games", kind: 'discord' });
  const moderator = createModerator({ db, classifier });

  let n = 0;
  for (const [text] of BANTER) {
    const r = await moderator.moderate(app, { userId: `b${n++}`, text });
    assert.equal(r.allow, true, text);
  }
  const insult = await moderator.moderate(app, { userId: 't1', text: 'you are all braindead losers' });
  assert.deepEqual([insult.allow, insult.action.type, insult.action.durationMs], [false, 'mute', 5 * MIN]);
  const drama = await moderator.moderate(app, { userId: 't2', text: 'and now it dead dead game nice work' });
  assert.equal(drama.action.durationMs, 5 * MIN);
  const threat = await moderator.moderate(app, { userId: 't3', text: 'dev should really kill himself tbh' });
  assert.equal(threat.action.durationMs, 24 * 60 * MIN);
  assert.match(threat.action.label, /FINAL/);
  assert.ok(logs.some((l) => l.includes('near miss') && l.includes('lmao you suck')), 'near misses are logged');
});

test('keyword baseline: third-person self-harm and slurs caught, gaming trash talk not', () => {
  const rules = createRuleClassifier({ blockedWords: [] });
  for (const t of ['dev should really kill himself tbh', 'i hope you die', 'he needs to kill himself']) {
    assert.equal(rules(t).severity, 'high', t);
  }
  for (const t of ['f@ggot', 'n1gger']) assert.equal(rules(t).category, 'hate', t);
  for (const t of ['nah ur trash at this game bro 😂', 'this boss fight is killing me', 'i killed him lol', 'spice', 'the snickers']) {
    assert.equal(rules(t).violation, false, t);
  }
  assert.equal(rules('you are trash').violation, true);
  // Live test in m0dE's games, Nov 20: after "gg ez noobs, rematch?" Jev scored this 0.78 (needs 0.85).
  for (const t of ['you are all braindead losers', 'you guys are idiots', "y'all are such losers", 'you are a bunch of clowns']) {
    assert.equal(rules(t).category, 'rudeness', t);
  }
  for (const t of ['gg ez noobs, rematch?', 'you are all invited to the tournament', 'you guys are trash at this game lol']) {
    assert.equal(rules(t).violation, false, t);
  }
});

// --- Discord: log channel fallback and startup health check ---

const perms = (ok = true) => ({ has: () => ok });
const textChannel = (id, name, canPost = true) => ({
  id, name, type: ChannelType.GuildText, permissionsFor: () => perms(canPost), sent: [],
  async send(m) { this.sent.push(m); return { delete: async () => {} }; },
});
function fakeGuild(id, channels, { me = { permissions: perms(true) }, systemChannel = null } = {}) {
  const cache = new Map(channels.map((c) => [c.id, c]));
  return { id, name: `Guild ${id}`, members: { me }, channels: { cache, fetch: async (cid) => cache.get(cid) ?? null }, systemChannel };
}

test('servers without /modlog log to a staff channel found by name', async () => {
  const general = textChannel('1', 'general');
  const automod = textChannel('2', 'automod-logs');
  const actions = textChannel('3', 'mod-actions');
  const g = fakeGuild('303543835345158145', [general, actions, automod]);
  assert.equal(findLogChannel(g)?.name, 'automod-logs');
  assert.equal((await resolveModLog(g, { settings: {} }))?.id, '2');
  assert.equal((await resolveModLog(g, { settings: { modLogChannelId: '3' } }))?.id, '3', 'a configured channel wins');
  assert.equal(findLogChannel(fakeGuild('x', [general, textChannel('9', 'mod-log', false)])), null, 'only channels it can post in');
  // m0dE's games style names.
  assert.equal(findLogChannel(fakeGuild('y', [textChannel('5', '🍻ㅣꓖeneral'), textChannel('6', '📜ㅣdc-logs')]))?.id, '6');
  assert.equal(findLogChannel(fakeGuild('z', [textChannel('7', '🔒・mod-log')]))?.id, '7');
  assert.equal(findLogChannel(fakeGuild('w', [textChannel('8', 'dev-logs-archive')])), null);
});

test('startup health check: linked servers report channels, log channel and missing permissions; unlinked get a notice once', async () => {
  const { db, account } = setupDb();
  db.meta.set('legacy_migrated', 'test');
  const app = db.apps.create({ accountId: account.id, name: "m0dE's games", kind: 'discord' });
  db.apps.setGuild(app.id, 'linked');
  const lines = [];
  const log = { log: (l) => lines.push(l), warn: (l) => lines.push(l), error: (...a) => lines.push(a.join(' ')) };
  const classifier = { aiAvailable: () => false, aiName: () => null, classify: async () => ({ violation: false }) };
  const h = createDiscordHandlers({ db, moderator: createModerator({ db, classifier }), classifier, log, linkNoticeDelayMs: 0 });

  const modlog = textChannel('10', 'mod-log');
  const hidden = { ...textChannel('11', 'general'), permissionsFor: () => perms(false) };
  const me = { permissions: { has: (flag) => flag !== 8192n /* ManageMessages */ } };
  const linked = fakeGuild('linked', [modlog, hidden], { me });
  const system = textChannel('20', 'welcome');
  const unlinked = fakeGuild('unlinked', [system], { systemChannel: system });
  const client = { user: { tag: 'Jef#1' }, guilds: { cache: new Map([['linked', linked], ['unlinked', unlinked]]) } };

  await h.onReady(client);
  const report = lines.find((l) => l.includes('(linked)'));
  assert.match(report, /baseline rules on/);
  assert.match(report, /reads 1\/2 text channels/);
  assert.match(report, /mod log #mod-log \(found by name/);
  assert.match(report, /MISSING permissions: delete messages/);
  assert.equal(modlog.sent.length, 1, 'missing permissions posted to the mod log');
  assert.ok(lines.some((l) => /unlinked.*NOT LINKED/.test(l)));
  assert.equal(system.sent.length, 1);
  assert.match(system.sent[0].content, /\/jef link/);

  await h.onReady(client);
  assert.equal(system.sent.length, 1, 'link notice only once');
  assert.equal(modlog.sent.length, 1, 'permission warning only when it changes');
});

test('JEF_TEST_USER_IDS: the owner is moderated and a timeout is attempted, with the error logged', async () => {
  const { db, account } = setupDb();
  const app = db.apps.create({ accountId: account.id, name: 'g', kind: 'discord' });
  db.apps.setGuild(app.id, 'g1');
  const classifier = { aiAvailable: () => false, aiName: () => null, classify: async () => ({ violation: true, category: 'rudeness', severity: 'low', reason: 'Insult', source: 'jev' }) };
  const lines = [];
  const log = { log: (l) => lines.push(l), warn: (l) => lines.push(l), error: (...a) => lines.push(a.join(' ')) };
  const h = createDiscordHandlers({ db, moderator: createModerator({ db, classifier }), classifier, log, linkNoticeDelayMs: 0 });
  const calls = [];
  const msg = (id) => ({
    id, content: 'you are all braindead losers', channelId: 'c1',
    guild: { id: 'g1', name: 'G', ownerId: 'owner', members: { me: null }, channels: { cache: new Map(), fetch: async () => null } },
    channel: { name: 'general', toString: () => '#general', send: async () => ({ delete: async () => {} }) },
    author: { id: 'owner', username: 'm0de', tag: 'm0de', bot: false, toString: () => '<@owner>', send: async () => {} },
    member: { id: 'owner', moderatable: false, permissions: { has: () => true }, roles: { cache: new Map() },
      timeout: async () => { calls.push('timeout'); throw Object.assign(new Error('Missing Permissions'), { code: 50013 }); } },
    delete: async () => calls.push('delete'),
  });
  const saved = config.testUserIds;
  try {
    config.testUserIds = [];
    await h.onMessage(msg('1'));
    assert.deepEqual(calls, [], 'owner skipped normally');
    config.testUserIds = ['owner'];
    await h.onMessage(msg('2'));
    assert.deepEqual(calls, ['delete', 'timeout']);
    assert.ok(lines.some((l) => /mute failed for owner: 50013 Missing Permissions/.test(l)));
    assert.ok(lines.some((l) => /5 minute mute \(mute failed\)/.test(l)));
  } finally { config.testUserIds = saved; }
});
