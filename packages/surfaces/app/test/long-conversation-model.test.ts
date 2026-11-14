import assert from 'node:assert/strict';
import { test } from 'node:test';
import { longConversationStep } from '../e2e/fixtures/long-conversation-model.ts';

for (const content of ['Continue after compaction', [{ type: 'text', text: 'Continue after compaction' }]]) test(`the long-conversation fixture recognizes continuation in ${typeof content === 'string' ? 'string' : 'text-part'} API content`, () => {
  const result = longConversationStep([{ role: 'assistant', content: 'The earlier decision was amber.' }, { role: 'user', content }]);
  assert.ok('text' in result);
  assert.match(result.text, /Continued.*amber/);
  assert.doesNotMatch(result.text, /Ledger evidence remains readable/);
});

test('the long-conversation fixture distinguishes summarization, ledger growth and the final current request', () => {
  const summary = longConversationStep([{ role: 'user', content: [{ type: 'text', text: '<conversation>Earlier ledger</conversation>' }] }]);
  assert.ok('text' in summary); assert.match(summary.text, /Keep the original evidence/);
  const ledger = longConversationStep([{ role: 'user', content: 'Continue after compaction' }, { role: 'user', content: [{ type: 'text', text: 'Add ledger evidence 7' }] }]);
  assert.ok('text' in ledger); assert.ok(ledger.text.length > 40_000, 'the provider fixture must still grow beyond the context limit');
});
