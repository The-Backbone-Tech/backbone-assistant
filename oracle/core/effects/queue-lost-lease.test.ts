import { describe, expect, it } from 'vitest';
import { effect, newWorld, propose, refused, sleep, useTarget } from '../harness.ts';
import { begin, take } from './fixtures.ts';

// Takes work from the cross-workspace dispatch queue: this file's installation holds only this case's work.
const target = useTarget('effects.queue-lost-lease');

describe('the dispatch queue', () => {
  it('[O1] a claimed effect whose dispatcher lost its lease is claimed again under a new claim; the old one is dead', async () => {
    const t = target();
    const w = await newWorld(t, 'LostClaim');
    const id = await propose(w);
    const first = await take(t, 1);
    await sleep(20);
    const second = await take(t);
    expect(second).toMatchObject({ effect: id, stale: false });
    expect(second.claim).not.toBe(first.claim);
    await refused(begin(t, first), 'stale');
    expect((await effect(w, id)).status).toBe('claimed');
    expect(await begin(t, second)).toBe(true);
    expect((await effect(w, id)).status).toBe('dispatching');
  });
});
