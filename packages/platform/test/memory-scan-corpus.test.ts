import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanMemory } from '../src/memory/scan.ts';
import { MemoryStore } from '../src/memory/store.ts';
import { freshHome } from './helpers.ts';
import { additionalAttacks, benignMemories, caughtAttacks } from './memory-scan-corpus.ts';

const live = () => 'current' as const;
test('the ordinary corpus including all 16 reviewer examples has zero refusals and preserves Unicode', () => {
  assert.ok(benignMemories.length >= 50);
  const store = new MemoryStore(freshHome());
  for (const text of benignMemories) {
    assert.equal(scanMemory(text), undefined, text);
    assert.equal(store.add({ topic: 'notes', text, origin: { kind: 'person' }, sources: [] }, live)!.text, text);
  }
  const reopened = new MemoryStore(store.root.slice(0, -'/memory'.length));
  assert.deepEqual(reopened.list(live).map(e => e.text), benignMemories);
});
for (const { rule, reason, text, kind } of caughtAttacks) {
  test(`high-confidence rule ${rule}: ${reason}`, () => {
    assert.equal(scanMemory(text), kind);
  });
}
test('attack corpus records caught normalization and URL cases and deliberately uncaught bypasses', () => {
  for (const { text, expected, reason } of additionalAttacks) assert.equal(scanMemory(text), expected, reason);
});
