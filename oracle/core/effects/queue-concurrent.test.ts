import { describe, expect, it } from 'vitest';
import { newWorld, propose, useTarget } from '../harness.ts';
import type { Taken } from './fixtures.ts';

// Takes work from the cross-workspace dispatch queue: this file's installation holds only this case's work.
const target = useTarget('effects.queue-concurrent');

describe('the dispatch queue', () => {
  it('[O1] concurrent dispatchers never take the same effect, and together they take every one', async () => {
    const t = target();
    const a = await newWorld(t, 'QueueA');
    const b = await newWorld(t, 'QueueB');
    const ids: string[] = [];
    for (const w of [a, b, a, b, a, b]) ids.push(await propose(w));
    // Ten dispatchers ask at the same instant. One may come back empty while another holds the rows
    // it looked at; it simply asks again.
    const taken: Taken[] = [];
    for (let round = 0; round < 6 && taken.length < ids.length; round++) {
      const batch = await t.race<Taken | null>(
        Array.from({ length: 10 }, (_, i) => ({
          session: t.setWorkspace(null),
          crossing: 'effect.claim_next',
          args: { worker: `dispatcher-${round}-${i}`, leaseMs: 30_000 },
        })),
      );
      for (const s of batch) {
        if (!s.ok) throw s.refusal;
        if (s.value) taken.push(s.value);
      }
    }
    expect(new Set(taken.map((x) => x.effect)).size).toBe(taken.length);
    expect(taken.map((x) => x.effect).sort()).toEqual([...ids].sort());
  });
});
