import { describe, expect, it } from 'vitest';
import { effect, newWorld, propose, useTarget } from '../harness.ts';
import { take, takeNext } from './fixtures.ts';

// Takes work from the cross-workspace dispatch queue: this file's installation holds only this case's work.
const target = useTarget('effects.queue-not-due');

describe('the dispatch queue', () => {
  it('[S13] effects that are waiting for a checker, denied or cancelled never reach a dispatcher', async () => {
    const t = target();
    const w = await newWorld(t, 'NotDue', { maxEffects: 2 });
    const asked = await propose(w, { classHint: 5 });
    const cancelled = await propose(w);
    await w.owner$.call('effect.cancel', { effect: cancelled, reason: 'not needed' });
    const allowed = await propose(w, { args: { field: 'stage', value: 'lost' } });
    const overBudget = await propose(w, { args: { field: 'stage', value: 'open' } });
    const statuses = await Promise.all(
      [asked, cancelled, allowed, overBudget].map(async (id) => (await effect(w, id)).status),
    );
    expect(statuses).toEqual(['awaiting_checker', 'cancelled', 'allowed', 'denied']);
    // The queue hands out the allowed effect and nothing else.
    expect((await take(t)).effect).toBe(allowed);
    expect(await takeNext(t)).toBeNull();
    // Cancelled before dispatch, it never comes back.
    await w.owner$.call('effect.cancel', { effect: allowed, reason: 'not needed either' });
    expect((await effect(w, allowed)).status).toBe('cancelled');
    expect(await takeNext(t, 30_000, 'dispatcher-2')).toBeNull();
  });
});
