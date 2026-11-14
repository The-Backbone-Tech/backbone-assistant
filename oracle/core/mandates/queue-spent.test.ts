import { describe, expect, it } from 'vitest';
import { newWorld, sleep, useTarget } from '../harness.ts';

// Its own installation: the cross-workspace run queue holds only this case's work.
const target = useTarget('mandates.queue-spent');

describe('budgets', () => {
  it('[S13] a run whose tokens are spent is stopped when claimed, not handed out', async () => {
    const x = await newWorld(target(), 'SpentClaim', { maxTokens: 50 });
    await x.agent$.call('run.record_usage', { run: x.run, fence: x.fence, tokensIn: 50 });
    await x.agent$.call('run.renew_lease', { run: x.run, fence: x.fence, leaseMs: 1 });
    await sleep(20);
    expect(await target().setWorkspace(null).call('run.claim_next', { worker: 'worker-2', leaseMs: 60_000 })).toBeNull();
    expect((await x.owner$.observe('run', { id: x.run }))[0]).toMatchObject({ status: 'failed', stopReason: 'budget exhausted' });
    // The last holder can still report what it spent, and learns why it stopped.
    expect(await x.agent$.call('run.record_usage', { run: x.run, fence: x.fence, tokensIn: 7 })).toBe('budget_exhausted');
    // Claiming it by id is refused as well.
    expect(await x.worker$.call('run.claim', { run: x.run, worker: 'worker-3', leaseMs: 60_000 }).catch((e) => e.reason)).toBe('not_claimable');
  });
});
