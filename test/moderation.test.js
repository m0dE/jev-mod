import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRuleClassifier, normalize } from '../src/rules.js';
import { StrikeStore } from '../src/strikes.js';
import { stepFor, enforce } from '../src/enforce.js';
import { createClassifier } from '../src/classifier.js';

const rules = createRuleClassifier({ blockedWords: ['badword'] });
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-mod-')), 'strikes.json');

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

test('ladder: warn, timeout, final timeout, ban', () => {
  assert.deepEqual([1, 2, 3, 4, 7].map((n) => stepFor(n).action), ['warn', 'timeout', 'timeout', 'ban', 'ban']);
  assert.equal(stepFor(2).timeoutMs, 10 * 60_000);
  assert.equal(stepFor(3).timeoutMs, 24 * 60 * 60_000);
});

test('strikes persist, expire and can be pardoned', () => {
  const file = tmpFile();
  let now = Date.now();
  const store = new StrikeStore(file, { expiryDays: 30, now: () => now });
  store.add('g', 'u', { category: 'rudeness', reason: 'r' });
  assert.equal(store.add('g', 'u', { category: 'threat', reason: 'r', weight: 2 }), 3);

  const reloaded = new StrikeStore(file, { expiryDays: 30, now: () => now });
  assert.equal(reloaded.count('g', 'u'), 3);

  now += 31 * 24 * 60 * 60 * 1000;
  assert.equal(reloaded.count('g', 'u'), 0, 'old strikes expire');

  now -= 31 * 24 * 60 * 60 * 1000;
  assert.equal(reloaded.pardon('g', 'u', 1), 1);
  assert.equal(reloaded.count('g', 'u'), 1);
  assert.equal(reloaded.pardon('g', 'u'), 1);
  assert.equal(reloaded.count('g', 'u'), 0);
});

function fakeMessage(content) {
  const calls = [];
  const author = { id: 'u1', tag: 'griefer#0001', toString: () => '<@u1>',
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

test('enforce walks a member to a ban on the 4th offense', async () => {
  const store = new StrikeStore(tmpFile());
  const verdict = { violation: true, category: 'rudeness', severity: 'medium', reason: 'Insult', source: 'rules' };
  const quiet = { warn() {} };
  const actions = [];
  for (let i = 0; i < 4; i++) {
    const msg = fakeMessage('you are an idiot');
    const { step } = await enforce({ message: msg, verdict, store, log: quiet });
    actions.push(step.action);
    assert.ok(msg.calls.includes('delete'), 'message deleted every time');
    assert.ok(msg.calls.includes('dm'), 'member warned by DM every time');
    if (i === 3) assert.ok(msg.calls.includes('ban:u1'));
  }
  assert.deepEqual(actions, ['warn', 'timeout', 'timeout', 'ban']);
});

test('a severe offense adds two strikes', async () => {
  const store = new StrikeStore(tmpFile());
  const msg = fakeMessage('kys');
  const { strikes, step } = await enforce({ message: msg, store, log: { warn() {} },
    verdict: { violation: true, category: 'toxicity', severity: 'high', reason: 'Self-harm', source: 'rules' } });
  assert.equal(strikes, 2);
  assert.equal(step.action, 'timeout');
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
