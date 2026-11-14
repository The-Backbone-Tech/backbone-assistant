import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordCompaction } from '../src/composition/conversation-compaction.ts';
import type { Turn } from '../src/api.ts';

test('compaction is linked to original turns, patched in place and redacted without replacing history', () => {
  const turn = { work: { steps: [] } } as unknown as Turn;
  const redact = (text: string) => text.replaceAll('secret-canary', '[redacted]');
  recordCompaction(turn, { id: 'c', engine: 'acp', status: 'in_progress' }, ['original'], redact);
  recordCompaction(turn, { id: 'c', engine: 'acp', status: 'completed', summary: 'A decision secret-canary', contextBefore: 10_000, contextAfter: 100 }, ['original'], redact);
  assert.equal(turn.work.compactions?.length, 1);
  assert.deepEqual(turn.work.compactions?.[0].historyTurnIds, ['original']);
  assert.equal(turn.work.compactions?.[0].summary, 'A decision [redacted]');
  assert.equal(turn.work.compactions?.[0].status, 'completed');
  assert.deepEqual(turn.work.steps, []);
});

test('opaque engine identifiers still patch the right compaction when credentials cannot be shown', () => {
  const turn = { work: { steps: [] } } as unknown as Turn;
  const clean = () => '[withheld]';
  recordCompaction(turn, { id: 'first', engine: 'acp', status: 'in_progress' }, [], clean);
  recordCompaction(turn, { id: 'second', engine: 'acp', status: 'in_progress' }, [], clean);
  recordCompaction(turn, { id: 'first', engine: 'acp', status: 'completed' }, [], clean);
  assert.equal(turn.work.compactions?.length, 2);
  assert.notEqual(turn.work.compactions?.[0].recordKey, turn.work.compactions?.[1].recordKey);
});

test('persisted compaction metadata cannot retain unrecognised engine payload fields', () => {
  const turn = { work: { steps: [] } } as unknown as Turn;
  const usage = { input: 10, output: 2, unrecognised: 'secret-canary' };
  const replay = { messages: 2, sha256: 'a'.repeat(64), unrecognised: 'secret-canary' };
  recordCompaction(turn, { id: 'c', engine: 'pi', status: 'completed', usage, replay }, [], text => text.replaceAll('secret-canary', '[redacted]'));
  assert.deepEqual(turn.work.compactions?.[0].usage, { input: 10, output: 2 });
  assert.deepEqual(turn.work.compactions?.[0].replay, { messages: 2, sha256: 'a'.repeat(64) });
  assert.ok(!JSON.stringify(turn.work.compactions).includes('secret-canary'));
});

test('a clipped summary keeps its original-history link and cannot be reused as complete context', () => {
  const turn = { work: { steps: [] } } as unknown as Turn;
  recordCompaction(turn, { id: 'large', engine: 'pi', status: 'completed', summary: 'x'.repeat(200_001), replay: { messages: 2, sha256: 'a'.repeat(64) } }, ['original'], text => text);
  const saved = turn.work.compactions![0];
  assert.ok(saved.summary!.length <= 200_000);
  assert.equal(saved.replay, undefined, 'a retained prefix of the summary cannot replace the complete covered history');
  assert.equal(saved.summaryTruncated, true);
  assert.deepEqual(saved.historyTurnIds, ['original']);
});
