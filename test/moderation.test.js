import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRuleClassifier, normalize } from '../src/rules.js';
import { punishmentFor } from '../src/ladder.js';
import { enforce } from '../src/discord/enforce.js';
import { openDb } from '../src/db.js';
import { createModerator } from '../src/moderation.js';
import { MessageHistory } from '../src/history.js';
import { checkSpam } from '../src/spam.js';
import { DailyBudget } from '../src/budget.js';
import { createGate } from '../src/gate.js';
import { isTrivial } from '../src/classifier.js';
import { looksLikeScam } from '../src/rules.js';
import { createClassifier } from '../src/classifier.js';
import { createJevClient, jevVerdict, jevRequest } from '../src/jev.js';

// Never call real APIs from tests, even if .env has keys.
delete process.env.TYPESAFE_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

// The quick check always says "maybe", so tests reach Jev's full check.
const suspicious = { check: async () => 1 };
const unlimited = new DailyBudget({ limit: 0 });

const rules = createRuleClassifier({ blockedWords: ['badword'] });

/** An in-memory database with one Discord app, and a clock the tests can move. */
function setupDb() {
  const clock = { now: Date.now() };
  const db = openDb(':memory:', { now: () => clock.now });
  const account = db.accounts.create({ email: 'owner@example.com', plan: 'internal' });
  const app = db.apps.create({ accountId: account.id, name: 'Test Server', kind: 'discord' });
  return { db, app, clock };
}

test('rules flag toxic, rude, griefing and negative messages', () => {
  const cases = {
    'kys loser': 'toxicity',
    "you're such an idiot": 'rudeness',
    'stfu nobody cares': 'rudeness',
    "let's grief their base tonight": 'griefing',
    'this server is trash': 'negativity',
    'i know where you live': 'threat',
    'what a b.a.d.w.o.r.d': 'hate',
    'k y s': null, // spaced-out single letters are deliberately left to the AI
  };
  for (const [msg, category] of Object.entries(cases)) {
    const v = rules(msg);
    if (category) assert.equal(v.category, category, msg);
    else assert.equal(v.violation, false, msg);
  }
});

test('rules leave normal chat alone', () => {
  for (const msg of [
    'gg everyone, that was fun',
    'this boss is killing me lol',
    "I'm having a rough day honestly",
    'I disagree, I think the update made the game slower',
    'I killed the dragon!',
    'can someone help me build a house?',
  ]) {
    assert.equal(rules(msg).violation, false, msg);
  }
});

test('mass mentions count as griefing', () => {
  assert.equal(rules('hi', { mentionCount: 8 }).category, 'griefing');
});

test('normalize sees through l33t-speak', () => {
  assert.equal(normalize('5TFU n00b'), 'stfu noob');
});

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

test('punishment starts at the severity and escalates with each active offense', () => {
  const ladder = (sev) => [0, 1, 2, 3, 4, 5].map((n) => punishmentFor(sev, n)).map((p) => (p.ban ? 'ban' : p.timeoutMs / MIN));
  assert.deepEqual(ladder('low'), [2, 10, 60, 360, 1440, 'ban']);
  assert.deepEqual(ladder('medium'), [10, 60, 360, 1440, 'ban', 'ban']);
  assert.deepEqual(ladder('high'), [1440, 'ban', 'ban', 'ban', 'ban', 'ban']);
});

test('offenses cool down: low and medium after a day, high after 30 days', () => {
  const { db, app, clock } = setupDb();
  db.strikes.add(app.id, 'u', { category: 'rudeness', severity: 'low', reason: 'r', cooldownMs: DAY });
  assert.equal(db.strikes.add(app.id, 'u', { category: 'threat', severity: 'high', reason: 'r', cooldownMs: 30 * DAY }), 2);
  assert.equal(db.strikes.count(app.id, 'other'), 0, 'per user');

  clock.now += 2 * DAY;
  assert.equal(db.strikes.count(app.id, 'u'), 1, 'the low one has cooled down');
  clock.now += 29 * DAY;
  assert.equal(db.strikes.count(app.id, 'u'), 0, 'everything has cooled down');

  clock.now -= 31 * DAY;
  assert.equal(db.strikes.pardon(app.id, 'u', 1), 1);
  assert.equal(db.strikes.count(app.id, 'u'), 1);
  assert.equal(db.strikes.pardon(app.id, 'u'), 1);
  assert.equal(db.strikes.count(app.id, 'u'), 0);
});

function fakeMessage(content) {
  const calls = [];
  const author = { id: 'u1', username: 'griefer', tag: 'griefer#0001', toString: () => '<@u1>',
    send: async () => calls.push('dm') };
  return {
    calls,
    content,
    author,
    guild: {
      id: 'g1', name: 'Test Server',
      members: { ban: async (id) => calls.push(`ban:${id}`) },
      channels: { cache: new Map(), fetch: async () => null },
    },
    member: { moderatable: true, timeout: async (ms) => calls.push(`timeout:${ms}`) },
    channel: { toString: () => '#general', send: async () => ({ delete: async () => {} }) },
    delete: async () => calls.push('delete'),
  };
}

/** The moderator decides (with a classifier that always returns `verdict`), Discord enforcement carries it out. */
function offender(verdict) {
  const env = setupDb();
  const classifier = { aiAvailable: () => false, classify: async () => verdict };
  const moderator = createModerator({ db: env.db, classifier, now: () => env.clock.now });
  let n = 0;
  return {
    ...env,
    async offend(content) {
      const msg = fakeMessage(content);
      const result = await moderator.moderate(env.app, { userId: 'u1', username: 'griefer', text: content, messageId: String(++n), room: 'c1' });
      await enforce({ app: env.app, message: msg, result, log: { warn() {} } });
      return { msg, result };
    },
  };
}

test('repeat subtle rudeness gets longer mutes, and resets after cooling down', async () => {
  const o = offender({ violation: true, category: 'rudeness', severity: 'low', reason: 'Snarky', source: 'jev' });
  const mutes = [];
  for (let i = 0; i < 3; i++) {
    const { msg } = await o.offend('nobody asked lol');
    assert.ok(msg.calls.includes('delete'), 'message deleted every time');
    assert.ok(msg.calls.includes('dm'), 'member told by DM every time');
    mutes.push(msg.calls.find((c) => c.startsWith('timeout:')));
    o.clock.now += 60 * MIN;
  }
  assert.deepEqual(mutes, [`timeout:${2 * MIN}`, `timeout:${10 * MIN}`, `timeout:${60 * MIN}`]);

  o.clock.now += 2 * DAY; // 48 hours later: back to the start
  const { msg } = await o.offend('nobody asked lol');
  assert.ok(msg.calls.includes(`timeout:${2 * MIN}`));
});

test('a clear insult four times in a day ends in a ban', async () => {
  const o = offender({ violation: true, category: 'rudeness', severity: 'medium', reason: 'Insult', source: 'rules' });
  const results = [];
  for (let i = 0; i < 5; i++) {
    const { msg, result } = await o.offend('you are an idiot');
    results.push(result.action.type === 'ban' ? 'ban' : result.action.durationMs / MIN);
    if (result.action.type === 'ban') assert.ok(msg.calls.includes('ban:u1'));
    o.clock.now += MIN;
  }
  assert.deepEqual(results, [10, 60, 360, 1440, 'ban']);
});

test('a severe offense goes straight to the final warning', async () => {
  const o = offender({ violation: true, category: 'toxicity', severity: 'high', reason: 'Self-harm', source: 'rules' });
  const { msg, result } = await o.offend('kys');
  assert.ok(msg.calls.includes(`timeout:${DAY}`));
  assert.match(result.action.label, /FINAL/);
});

test('a flood is punished once; the rest are only deleted', async () => {
  const o = offender({ violation: true, category: 'spam', severity: 'low', reason: 'Flooding', source: 'rules' });
  await o.offend('spam');
  const { msg, result } = await o.offend('spam');
  assert.equal(result.action.type, 'delete');
  assert.deepEqual(msg.calls, ['delete'], 'no DM or mute the second time');
});

test('griefing and bullying need a pattern, not one message', async () => {
  const griefing = "let's grief their base tonight";
  const hist = new MessageHistory();
  const classifier = createClassifier({ ruleClassifier: rules }); // no AI: counts earlier look-alikes

  const first = await classifier.classify(griefing, { history: hist.recent('g', 'u') });
  assert.equal(first.violation, false, 'one message is only watched');
  assert.equal(first.watch, 'griefing');

  hist.add('g', 'u', { id: '1', channel: 'general', content: griefing, flagged: 'griefing' });
  assert.equal((await classifier.classify(griefing, { history: hist.recent('g', 'u') })).violation, false);
  hist.add('g', 'u', { id: '2', channel: 'general', content: griefing, flagged: 'griefing' });
  const third = await classifier.classify(griefing, { history: hist.recent('g', 'u') });
  assert.equal(third.violation, true, 'a pattern is acted on');
  assert.equal(third.severity, 'medium');

  const pings = await classifier.classify('hey', { mentionCount: 8, history: [] });
  assert.equal(pings.violation, true, 'mass-pinging still counts on its own');
});

test('Jev judges the pattern from the member history', async () => {
  const replies = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    replies.push(body);
    const answers = body.questions.pattern
      ? { pattern: { type: 'noul', noul: 0.95 } }
      : { category: { choice: 'harassment', probabilities: { harassment: 0.97 } }, severity: { choice: 'medium' } };
    return { ok: true, json: async () => ({ answers }) };
  };
  const classifier = createClassifier({ jevClient: createJevClient({ apiKey: 'k', fetchImpl }), gate: suspicious, budget: unlimited, ruleClassifier: rules });

  const alone = await classifier.classify('lol sam is so cringe', { history: [] });
  assert.equal(alone.violation, false);
  assert.equal(replies.length, 1, 'no pattern check without any history');

  const hist = new MessageHistory();
  hist.add('g', 'u', { id: '1', channel: 'general', to: 'sam', content: 'nobody wants you here sam', flagged: 'harassment' });
  const v = await classifier.classify('lol sam is so cringe', { history: hist.recent('g', 'u') });
  assert.equal(v.violation, true);
  assert.equal(v.reason, 'Bullying another member');
  assert.equal(replies[2].state.authors_recent_messages[0].content, 'nobody wants you here sam');
});

test('history forgets old messages and keeps edits as one entry', () => {
  let now = Date.now();
  const hist = new MessageHistory({ windowMinutes: 30, now: () => now });
  hist.add('g', 'u', { id: '1', channel: 'c', content: 'a' });
  hist.add('g', 'u', { id: '1', channel: 'c', content: 'a (edited)' });
  assert.deepEqual(hist.recent('g', 'u').map((e) => e.content), ['a (edited)']);
  assert.equal(hist.recent('g', 'u', '1').length, 0, 'the message being judged is left out');
  now += 31 * MIN;
  assert.equal(hist.recent('g', 'u').length, 0);
});

test('AI classifier is used when rules pass, and errors fall back to rules', async () => {
  const fakeClient = (reply) => ({
    beta: { messages: { create: async (req) => {
      assert.equal(req.output_config.format.type, 'json_schema');
      if (reply instanceof Error) throw reply;
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(reply) }] };
    } } },
  });

  const ai = createClassifier({ client: fakeClient({ violation: true, category: 'negativity', severity: 'low', reason: 'Trashing members' }), ruleClassifier: rules });
  const v = await ai.classify('honestly everyone in this chat is so mid and annoying');
  assert.equal(v.violation, true);
  assert.equal(v.source, 'ai');

  const broken = createClassifier({ client: fakeClient(new Error('network down')), ruleClassifier: rules });
  const origError = console.error;
  console.error = () => {};
  try {
    assert.equal((await broken.classify('hello friends')).violation, false);
    assert.equal((await broken.classify('kys')).violation, true, 'rules still work');
  } finally {
    console.error = origError;
  }
});

test('Jev verdicts only count when confident, and errors fall back to rules', async () => {
  const answers = (choice, p, severity = 'medium') => ({
    category: { type: 'choice', choice, probabilities: { [choice]: p } },
    severity: { type: 'choice', choice: severity },
  });
  assert.deepEqual(
    { ...jevVerdict(answers('rudeness', 0.95)) },
    { violation: true, category: 'rudeness', severity: 'medium', reason: 'Rude message', source: 'jev', hint: 'harassment', standalone: false, others: [] },
  );
  assert.equal(jevVerdict(answers('rudeness', 0.85)).violation, false, 'unsure: let it through');
  assert.equal(jevVerdict(answers('none', 0.99)).violation, false);

  let sent;
  const fetchImpl = async (url, opts) => {
    sent = { url, body: JSON.parse(opts.body), auth: opts.headers.Authorization };
    return { ok: true, json: async () => ({ answers: answers('negativity', 0.9, 'low') }) };
  };
  const ai = createClassifier({ jevClient: createJevClient({ apiKey: 'ts_test', fetchImpl }), gate: suspicious, budget: unlimited, ruleClassifier: rules });
  assert.equal(ai.aiAvailable(), true);
  const v = await ai.classify('honestly everyone in this chat is so mid and annoying', { recent: ['a: hi'] });
  assert.equal(v.violation, true);
  assert.equal(v.source, 'jev');
  assert.equal(sent.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(sent.auth, 'Bearer ts_test');
  assert.equal(sent.body.questions.category.type, 'choice');
  assert.deepEqual(sent.body.state.recent_channel_messages_for_context_only, ['a: hi']);

  const down = createJevClient({ apiKey: 'bad', fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }) });
  const broken = createClassifier({ jevClient: down, gate: suspicious, budget: unlimited, ruleClassifier: rules });
  const origError = console.error;
  console.error = () => {};
  try {
    assert.equal((await broken.classify('hello friends')).violation, false);
    assert.equal(broken.aiAvailable(), false, 'bad key disables AI');
    assert.equal((await broken.classify('kys')).violation, true, 'rules still work');
  } finally {
    console.error = origError;
  }
});

test('scams are caught and real links are left alone', async () => {
  const scams = [
    'Free Discord Nitro for 3 months! https://dlscord-gift.com/claim',
    '@everyone steam gift 50$ https://steamcommunlty.ru/gift/123',
    'hey bro check this https://discorcl.gift/xyz',
    'I am giving away my CS skins, im leaving steam, add me',
    '@everyone new update https://bit.ly/abc',
    'crypto airdrop! claim at https://sol-drop.io',
    'Hey, I accidentally reported your account, please contact discord staff at @trust_safety_mod',
  ];
  const fine = [
    'is free nitro real?',
    'beware, there is a free nitro scam going around, dont click links',
    'https://discord.gg/braains join our server',
    'https://store.steampowered.com/app/123',
    'nitro boosted the server, thanks!',
    'I won the giveaway lol',
    'check out https://braains.io',
    'https://discord.com/channels/1/2',
  ];
  for (const t of scams) assert.ok(looksLikeScam(t), t);
  for (const t of fine) assert.equal(looksLikeScam(t), null, t);

  const classifier = createClassifier({ ruleClassifier: rules });
  const v = await classifier.classify(scams[0], { history: [] });
  assert.equal(v.category, 'scam');
  assert.equal(v.severity, 'high', 'scams go straight to the 24 hour mute');
});

test('flooding and repeated messages are spam', () => {
  const now = Date.now();
  const msgs = (texts, gapMs) => texts.map((content, i) => ({ id: String(i), channelId: 'c', content, at: now - (texts.length - i) * gapMs }));

  const flood = checkSpam('6th', msgs(['a', 'b', 'c', 'd', 'e'], 1000), now);
  assert.equal(flood.violation, true);
  assert.equal(flood.severity, 'low');
  assert.equal(flood.duplicates.length, 5, 'the rest of the flood is deleted too');
  assert.equal(checkSpam('6th', msgs(['a', 'b', 'c', 'd', 'e'], 5000), now).violation, false, 'normal chatting pace');

  const ad = 'join my server discord.gg/abc for free stuff';
  const repeated = checkSpam(ad, msgs([ad, ad], 10_000), now);
  assert.equal(repeated.violation, true);
  assert.equal(repeated.severity, 'medium');
  assert.equal(checkSpam('gg', msgs(['gg', 'gg'], 10_000), now).violation, false, 'short replies need more repeats');
  assert.equal(checkSpam('gg', msgs(['gg', 'gg', 'gg', 'gg'], 10_000), now).violation, true);
});

test('quick check bundles messages into one Jev request', async () => {
  const sent = [];
  const gate = createGate({
    delayMs: 20,
    ask: async (body) => {
      sent.push(body);
      return Object.fromEntries(Object.keys(body.questions).map((k, i) => [k, { noul: i === 1 ? 0.8 : 0.05 }]));
    },
  });
  const results = await Promise.all(['hello all', 'you are the worst', 'anyone up for a game'].map((m) => gate.check(m)));
  assert.equal(sent.length, 1, 'one request for all three');
  assert.deepEqual(Object.values(sent[0].state.messages), ['hello all', 'you are the worst', 'anyone up for a game']);
  assert.deepEqual(results, [0.05, 0.8, 0.05]);

  const failing = createGate({ delayMs: 1, ask: async () => null });
  assert.equal(await failing.check('hi'), null, 'no answer means: do the full check');
});

test('Jev is skipped for trivial, recently-clean and quick-cleared messages', async () => {
  let full = 0;
  const jevClient = { decide: async () => { full++; return { answers: { category: { choice: 'none', probabilities: { none: 1 } } } }; } };
  let gateP = 0.05;
  const gate = { check: async () => gateP };
  const classifier = createClassifier({ jevClient, gate, budget: unlimited, ruleClassifier: rules });

  for (const m of ['gg', 'lol', '😂😂', '!rank', 'ok']) assert.equal(isTrivial(m), true, m);
  for (const m of ['you suck', 'nobody asked', 'lol ok whatever loser']) assert.equal(isTrivial(m), false, m);

  await classifier.classify('gg', { guildId: 'g' });
  await classifier.classify('anyone want to trade skins?', { guildId: 'g' });
  assert.equal(full, 0, 'trivial and quick-cleared messages never get the full check');

  gateP = 0.9;
  await classifier.classify('anyone want to trade skins?', { guildId: 'g' });
  assert.equal(full, 0, 'judged clean recently, so not asked again');
  await classifier.classify('is this the zombie skin?', { guildId: 'g' });
  assert.equal(full, 1, 'a suspicious message gets the full check');

  const s = classifier.takeStats();
  assert.deepEqual([s.messages, s.trivial, s.gatedClean, s.cached, s.fullChecks], [4, 1, 1, 1, 1]);
});

test('the daily budget stops Jev until the next day', async () => {
  let now = Date.parse('2026-10-07T12:00:00Z');
  const budget = new DailyBudget({ limit: 1000, now: () => now });
  let calls = 0;
  const classifier = createClassifier({ jevClient: { decide: async () => { calls++; return { answers: {} }; } }, gate: suspicious, budget, ruleClassifier: rules });

  budget.record({ input_tokens: 1000 });
  assert.equal(budget.ok(), false);
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    await classifier.classify('is this message fine?', {});
    assert.equal(calls, 0, 'over budget: no Jev');
    assert.equal((await classifier.classify('kys', {})).violation, true, 'keyword rules still work');
  } finally {
    console.warn = origWarn;
  }
  now = Date.parse('2026-10-08T00:00:01Z');
  assert.equal(budget.ok(), true, 'a new day');
});

test('Jev client caps requests in flight and backs off when rate limited', async () => {
  let inFlight = 0;
  let peak = 0;
  const slow = async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 10));
    inFlight--;
    return { ok: true, status: 200, json: async () => ({ answers: {}, usage: { input_tokens: 5 } }) };
  };
  let used = 0;
  const client = createJevClient({ apiKey: 'k', fetchImpl: slow, maxConcurrent: 2, onUsage: (u) => { used += u.input_tokens; } });
  await Promise.all(Array.from({ length: 6 }, () => client.decide({})));
  assert.equal(peak, 2);
  assert.equal(used, 30);

  let now = 0;
  let hits = 0;
  const limited = createJevClient({
    apiKey: 'k', now: () => now,
    fetchImpl: async () => { hits++; return { ok: false, status: 429, headers: { get: () => '5' }, text: async () => 'slow down' }; },
  });
  await assert.rejects(limited.decide({}), { status: 429 });
  await assert.rejects(limited.decide({}), { status: 429 });
  assert.equal(hits, 1, 'paused: the second call never reached Jev');
  now = 6000;
  await assert.rejects(limited.decide({}), { status: 429 });
  assert.equal(hits, 2, 'tries again after Retry-After');
});

test('server rules: stored per app, asked as their own question, acted on', () => {
  const { db, app } = setupDb();
  const other = db.apps.create({ accountId: app.accountId, name: 'Other', kind: 'discord' });
  const rule = db.rules.add(app.id, 'No asking for or missing old Braains', 'low');
  assert.deepEqual(db.rules.list(app.id).map((r) => [r.id, r.text, r.severity]), [[rule.id, rule.text, 'low']]);
  assert.deepEqual(db.rules.list(other.id), [], 'other apps are unaffected');
  assert.equal(db.apps.update(app.id, { settings: { modLogChannelId: 'c1' } }).settings.modLogChannelId, 'c1');

  const body = jevRequest('bring back old braains', { customRules: [rule] });
  assert.match(body.questions[`custom_${rule.id}`].instructions, /old Braains/);

  const v = jevVerdict({ [`custom_${rule.id}`]: { noul: 0.95 }, category: { choice: 'none', probabilities: { none: 1 } } }, 0.9, [rule]);
  assert.equal(v.violation, true);
  assert.equal(v.category, 'custom');
  assert.equal(v.severity, 'low');
  assert.match(v.reason, /old Braains/);

  const both = jevVerdict({
    [`custom_${rule.id}`]: { noul: 0.95 },
    category: { choice: 'rudeness', probabilities: { rudeness: 0.95 } }, severity: { choice: 'medium' },
  }, 0.9, [rule]);
  assert.equal(both.category, 'rudeness', 'the more severe rule wins');

  assert.equal(db.rules.remove(other.id, rule.id), null, 'only from its own app');
  assert.equal(db.rules.remove(app.id, rule.id).id, rule.id);
  assert.deepEqual(db.rules.list(app.id), []);
});

test('old records are deleted, and a server\'s data is forgotten when the bot leaves', () => {
  const { db, app, clock } = setupDb();
  db.strikes.add(app.id, 'old', { category: 'rudeness', severity: 'low', reason: 'r', cooldownMs: DAY });
  clock.now += 32 * DAY;
  db.strikes.add(app.id, 'new', { category: 'rudeness', severity: 'low', reason: 'r', cooldownMs: DAY });
  db.strikes.prune();
  const users = db.raw.prepare('SELECT DISTINCT user_id FROM strikes').all().map((r) => r.user_id);
  assert.deepEqual(users, ['new'], 'expired over 30 days ago: deleted');

  db.events.add(app.id, { type: 'action', userId: 'new' });
  db.strikes.forgetApp(app.id);
  db.events.forgetApp(app.id);
  assert.equal(db.strikes.count(app.id, 'new'), 0);
  assert.deepEqual(db.events.list(app.id), []);
});
