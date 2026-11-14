import { describe, expect, it } from 'vitest';
import { effect, newWorld, propose, refused, sleep, useTarget } from '../harness.ts';
import { begin, dispatcher, take, takeNext } from './fixtures.ts';

// Takes work from the cross-workspace dispatch queue: this file's installation holds only this case's work.
const target = useTarget('effects.queue-stale-dispatch');

/** The legacy queue waits this long beyond a lost dispatch lease before calling it stale (migration 0002). */
const GRACE_MS = 30_000;

describe('the dispatch queue', () => {
  it('[O1] a dispatching effect whose dispatcher went silent comes back as stale, to be inspected and never re-sent', async () => {
    const t = target();
    const w = await newWorld(t, 'StaleDispatch');
    const id = await propose(w);
    const taken = await take(t, 500);
    expect(await begin(t, taken)).toBe(true);
    expect(await takeNext(t)).toBeNull(); // while the lease holds, nobody else looks at it
    await sleep(600);
    expect(await takeNext(t)).toBeNull(); // nor during the grace period after it
    // The legacy suite skips the grace period with the administrator; here it is waited out.
    await sleep(GRACE_MS);
    const stale = await take(t);
    expect(stale).toMatchObject({ effect: id, stale: true, system: w.system });
    expect(stale.claim).toBe(taken.claim);
    expect((await effect(w, id)).status).toBe('dispatching');
    // It cannot be dispatched again; it can only be observed.
    await refused(begin(t, stale), 'stale');
    expect((await effect(w, id)).status).toBe('dispatching');
    await dispatcher(t, stale).call('effect.observe', {
      effect: id,
      claim: stale.claim,
      outcome: 'succeeded',
      externalRef: 'crm://deal/9',
      observationHash: 'inspected',
      note: 'found by key',
    });
    expect((await effect(w, id)).status).toBe('succeeded');
    expect(await takeNext(t)).toBeNull();
  });
});
