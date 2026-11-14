import { describe, expect, it } from 'vitest';
import type { Id } from '../../target.ts';
import { newWorld, queueRun, useTarget } from '../harness.ts';
import type { Claimed } from './fixtures.ts';

// Its own file: this installation's queue holds only this case's runs.
const target = useTarget('ledger.queue-concurrent');

describe('the cross-workspace queue', () => {
  it('[O1] concurrent workers never claim the same run, and each claim’s secret acts as its run', async () => {
    const t = target();
    const a = await newWorld(t, 'QueueA');
    const b = await newWorld(t, 'QueueB');
    for (const w of [a, b])
      await w.agent$.call('run.finish', { run: w.run, fence: w.fence, outcome: 'succeeded' });
    const queued: Id[] = [];
    for (const w of [a, b, a, b]) queued.push((await queueRun(w.owner$, w.owner, w.mandate, w.agent)).run);
    // Eight workers ask at the same instant. One may come back empty while another holds the rows it
    // looked at; it simply asks again.
    const claimed: Claimed[] = [];
    for (let round = 0; round < 6 && claimed.length < queued.length; round++) {
      const batch = await t.race<Claimed | null>(
        Array.from({ length: 8 }, (_, i) => ({
          session: t.setWorkspace(null),
          crossing: 'run.claim_next',
          args: { worker: `worker-${round}-${i}`, leaseMs: 60_000 },
        })),
      );
      for (const settled of batch) {
        if (!settled.ok) throw settled.refusal;
        if (settled.value) claimed.push(settled.value);
      }
    }
    expect(new Set(claimed.map((c) => c.run)).size).toBe(claimed.length);
    expect(claimed.map((c) => c.run).sort()).toEqual([...queued].sort());
    for (const c of claimed) {
      expect(c.workspace).toBe(queued.indexOf(c.run) % 2 === 0 ? a.ws : b.ws);
      const who = await t
        .setWorkspace(c.workspace)
        .asRun(c.run, c.secret)
        .call<{ run: Id | null }>('identity.whoami');
      expect(who.run).toBe(c.run);
    }
  });
});
