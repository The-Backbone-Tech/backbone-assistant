import { describe, expect, it } from 'vitest';
import { issue, newWorld, queueRun, refused, runIn, useTarget } from '../harness.ts';

// Its own installation: the cross-workspace run queue holds only this case's work.
const target = useTarget('mandates.queue-revoke');

describe('revocation', () => {
  it('[S5] revocation cancels queued, waiting and running runs alike, and none is handed out again', async () => {
    const x = await newWorld(target(), 'RevokeRuns');
    const child = await issue(x.owner$, x.agent, { parent: x.mandate });
    const queued = (await queueRun(x.owner$, x.owner, child, x.agent)).run;
    const waiting = await runIn(x, child);
    await waiting.$.call('run.park', { run: waiting.run, fence: waiting.fence });
    const running = await runIn(x, child);
    await x.owner$.call('mandate.revoke', { mandate: x.mandate });
    const runs = await x.owner$.observe<{ status: string; stopReason: string }>('run', { ids: [queued, waiting.run, running.run, x.run] });
    expect(runs.map((r) => [r.status, r.stopReason])).toEqual(Array.from({ length: 4 }, () => ['cancelled', 'mandate revoked']));
    // The queue hands none of them out, and none can be claimed by name.
    expect(await target().setWorkspace(null).call('run.claim_next', { worker: 'worker-9', leaseMs: 60_000 })).toBeNull();
    await refused(x.worker$.call('run.claim', { run: waiting.run, worker: 'worker-9', leaseMs: 60_000 }), 'not_claimable');
  });
});
