import { describe, expect, it } from 'vitest';
import { effect, newWorld, propose, refused, useTarget } from '../harness.ts';
import { take } from './fixtures.ts';

// Takes work from the cross-workspace dispatch queue: this file's installation holds only this case's work.
const target = useTarget('effects.queue-claim-only');

describe('the dispatch queue', () => {
  it('[S8] the claim is worthless to anyone but the system principal', async () => {
    const t = target();
    const w = await newWorld(t, 'ClaimOnly');
    const id = await propose(w);
    const taken = await take(t);
    expect(taken.effect).toBe(id);
    for (const session of [w.owner$, w.agent$, t.setWorkspace(w.ws).asPrincipal(w.agent)]) {
      await refused(
        session.call('effect.begin_dispatch', { effect: id, claim: taken.claim }),
        'system_dispatches',
      );
    }
    expect((await effect(w, id)).status).toBe('claimed');
  });
});
