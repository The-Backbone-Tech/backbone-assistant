import { describe, expect, it } from 'vitest';
import { answer, decisionOf, newWorld, propose, useTarget } from '../harness.ts';
import { claimNext } from './fixtures.ts';

// Its own file: this installation's queue holds only this case's runs.
const target = useTarget('ledger.queue-parked-answer');

describe('the cross-workspace queue', () => {
  it('[O1] a parked run is not claimable until the decision it waits for wakes it', async () => {
    const w = await newWorld(target(), 'Parked');
    const question = await decisionOf(w, await propose(w, { classHint: 5 }));
    await w.agent$.call('run.park', { run: w.run, fence: w.fence });
    expect(await claimNext(w.t)).toBeNull();
    await answer(w.owner$, w, question);
    expect(await claimNext(w.t)).toMatchObject({ workspace: w.ws, run: w.run, fence: w.fence + 1 });
    // Woken once: it is not handed out a second time.
    expect(await claimNext(w.t, 'w2')).toBeNull();
  });
});
