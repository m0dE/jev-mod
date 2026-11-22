// MOD_EFFORT=none: the Claude request carries no effort (Claude Haiku 4.5 refuses the field).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MOD_EFFORT = 'none';
process.env.MOD_MODEL = 'claude-haiku-4-5';
const { createClassifier } = await import('../src/classifier.js');

test('MOD_EFFORT=none sends no effort, and keeps the JSON verdict format', async () => {
  const sent = [];
  const client = { beta: { messages: { create: async (params) => {
    sent.push(params);
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ violation: false, category: 'none', severity: 'none', reason: '' }) }] };
  } } } };
  const classifier = createClassifier({ client, ruleClassifier: () => ({ violation: false }) });
  await classifier.classify('a perfectly ordinary message about the boss fight', { authorName: 'p1' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].model, 'claude-haiku-4-5');
  assert.equal('effort' in sent[0].output_config, false);
  assert.equal(sent[0].output_config.format.type, 'json_schema');
});
