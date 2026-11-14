import { describe, expect, it } from 'vitest';
import { newWorld, propose, useTarget } from '../harness.ts';
import { claimNext } from './fixtures.ts';

// Its own file: this installation's queue holds only this case's runs.
const target = useTarget('ledger.queue-parked-cancel');

describe('the cross-workspace queue', () => {
  it('[O1] a parked run wakes when the change it waits for is cancelled, as it does for an answer', async () => {
    const w = await newWorld(target(), 'ParkedCancel');
    const effect = await propose(w, { classHint: 5 });
    await w.agent$.call('run.park', { run: w.run, fence: w.fence });
    expect(await claimNext(w.t)).toBeNull();
    await w.owner$.call('effect.cancel', { effect, reason: 'not now' });
    expect(await claimNext(w.t)).toMatchObject({ workspace: w.ws, run: w.run, fence: w.fence + 1 });
    expect(await claimNext(w.t, 'w2')).toBeNull();
  });
});
