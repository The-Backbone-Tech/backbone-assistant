import { describe, expect, it } from 'vitest';
import { effect, newWorld, propose, useTarget } from '../harness.ts';
import { begin, dispatcher, take, takeNext } from './fixtures.ts';

// Takes work from the cross-workspace dispatch queue: this file's installation holds only this case's work.
const target = useTarget('effects.queue-handoff');

describe('the dispatch queue', () => {
  it('[S8] an allowed effect goes to the next dispatcher, as the workspace’s system principal, and leaves once observed', async () => {
    const t = target();
    const w = await newWorld(t, 'Queue');
    const id = await propose(w);
    const taken = await take(t);
    expect(taken).toMatchObject({ workspace: w.ws, effect: id, stale: false, system: w.system });
    expect((await effect(w, id)).status).toBe('claimed');
    expect(await begin(t, taken)).toBe(true);
    await dispatcher(t, taken).call('effect.observe', {
      effect: id,
      claim: taken.claim,
      outcome: 'succeeded',
      externalRef: 'crm://deal/1',
      observationHash: 'obs',
    });
    expect((await effect(w, id)).status).toBe('succeeded');
    expect(await takeNext(t)).toBeNull();
  });
});
