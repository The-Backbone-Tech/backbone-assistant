import { describe, expect, it } from 'vitest';
import { claim, newWorld, queueRun, refused, useTarget } from '../harness.ts';
import { claimNext } from './fixtures.ts';

// Its own file: this installation's queue holds only this case's runs.
const target = useTarget('ledger.queue-revoked');

describe('the cross-workspace queue', () => {
  it('[S5] a queued run whose mandate was revoked is cancelled and leaves the queue', async () => {
    const w = await newWorld(target(), 'RevokedQueue');
    const { run } = await queueRun(w.owner$, w.owner, w.mandate, w.agent);
    await w.owner$.call('mandate.revoke', { mandate: w.mandate });
    // No worker is handed it, from the queue or by name.
    expect(await claimNext(w.t)).toBeNull();
    await refused(claim(w.t, w.ws, run, 'worker-2'), ['not_claimable', 'revoked']);
    const [queued] = await w.owner$.observe<{ status: string }>('run', { id: run });
    expect(queued?.status).toBe('cancelled');
  });
});
