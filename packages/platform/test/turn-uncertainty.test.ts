import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Turn } from '../src/api.ts';
import { turnUnresolved } from '../src/composition/turn-uncertainty.ts';

const turn = (unknownEvidence?: Turn['unknownEvidence']) => ({ id: 'turn', unknownOutcome: true, unknownEvidence } as Turn);
test('only every exact connector receipt clears a known connector-only uncertainty', async () => {
  const seen: string[] = [];
  const check = async (thread: string, id: string, effect: string) => { seen.push([thread, id, effect].join(':')); return effect === 'first'; };
  assert.equal(await turnUnresolved('thread', turn({ connectorEffects: ['first', 'second'] }), check), true);
  assert.deepEqual(seen, ['thread:turn:first', 'thread:turn:second']);
  assert.equal(await turnUnresolved('thread', turn({ connectorEffects: ['first'] }), check), false);
  assert.equal(await turnUnresolved('thread', turn({ connectorEffects: ['first'], other: true }), check), true);
  assert.equal(await turnUnresolved('thread', turn(), check), true);
  assert.equal(await turnUnresolved('thread', turn({ connectorEffects: [] }), check), true);
  assert.equal(await turnUnresolved('thread', turn({ connectorEffects: ['first'] }), async () => { throw Error('unavailable'); }), true);
});

test('durable connector holds survive a missing turn marker and require exact reconciliation', async () => {
  const sample = { id: 'turn' } as Turn;
  for (const state of ['waiting', 'unknown'] as const) {
    const held = [{ threadId: 'thread', turnId: 'turn', effect: 'lost', state }];
    assert.equal(await turnUnresolved('thread', sample, async () => false, held), true);
    const seen: string[] = [];
    assert.equal(await turnUnresolved('thread', sample, async (...ids) => { seen.push(ids.join(':')); return true; }, held), false);
    assert.deepEqual(seen, ['thread:turn:lost']);
    assert.equal(await turnUnresolved('thread', sample, async () => { throw Error('Core unavailable'); }, held), true);
    assert.equal(await turnUnresolved('other', sample, async () => false, held), false, 'another thread is independent');
  }
});
