import { describe, expect, it } from 'vitest';
import type { Id } from '../../target.ts';
import { claim, newWorld, propose, refused, sleep, useTarget } from '../harness.ts';

const target = useTarget('ledger.runs');

interface RunView {
  id: Id;
  task: Id;
  status: string;
  fence: number;
  tokensUsed: number;
}
interface StepView {
  seq: number;
  kind: string;
  status: string;
  fence: number;
}

describe('runs: leases and fencing', () => {
  it('[O1] a run held under a valid lease cannot be claimed by another worker', async () => {
    const w = await newWorld(target(), 'Lease');
    await refused(claim(w.t, w.ws, w.run, 'worker-2'), 'not_claimable');
    // The holder is undisturbed: same fence, and its secret still acts.
    const [run] = await w.owner$.observe<RunView>('run', { id: w.run });
    expect(run?.fence).toBe(w.fence);
    await w.agent$.call('run.renew_lease', { run: w.run, fence: w.fence, leaseMs: 60_000 });
  });

  it('[O1] after the lease expires, a new worker takes over and the old one can no longer act', async () => {
    const x = await newWorld(target(), 'Fencing');
    await x.agent$.call('run.renew_lease', { run: x.run, fence: x.fence, leaseMs: 1 });
    await sleep(20);
    const next = await claim(x.t, x.ws, x.run, 'worker-2');
    expect(next.fence).toBe(x.fence + 1);
    expect(next.secret).not.toBe(x.secret);
    // The old worker cannot finish, park, renew or record usage...
    const stale = { run: x.run, fence: x.fence };
    await refused(x.agent$.call('run.finish', { ...stale, outcome: 'succeeded' }), 'stale', 'finish');
    await refused(x.agent$.call('run.park', stale), 'stale', 'park');
    await refused(x.agent$.call('run.renew_lease', { ...stale, leaseMs: 60_000 }), 'stale', 'renew');
    await refused(x.agent$.call('run.record_usage', { ...stale, tokensIn: 1 }), 'stale', 'usage');
    // ...nor write steps or propose effects...
    await refused(x.agent$.call('run.step.write', { ...stale, seq: 3, kind: 'model' }), 'denied', 'step');
    await refused(propose(x), ['stale', 'not_in_run'], 'propose with the old secret');
    // ...and even the new secret does not revive the old fence.
    await refused(
      propose(x, { run: { run: x.run, fence: x.fence, $: next.$ } }),
      'stale',
      'propose at the old fence',
    );
    // None of it landed: the run is still running at the new fence, with no steps, usage or effects.
    const [run] = await x.owner$.observe<RunView>('run', { id: x.run });
    expect(run).toMatchObject({ status: 'running', fence: next.fence, tokensUsed: 0 });
    expect(await x.owner$.observe('step', { run: x.run })).toEqual([]);
    expect(await x.owner$.observe('effect')).toEqual([]);
    await next.$.call('run.finish', { run: x.run, fence: next.fence, outcome: 'succeeded' });
    expect((await x.owner$.observe<RunView>('run', { id: x.run }))[0]?.status).toBe('succeeded');
  });

  it('[O1] a step left pending by an earlier holder is completed by the current holder; the stale secret cannot', async () => {
    const w = await newWorld(target(), 'Resume');
    await w.agent$.call('run.step.write', {
      run: w.run,
      fence: w.fence,
      seq: 1,
      kind: 'tool',
      input: { q: 1 },
    });
    await w.agent$.call('run.park', { run: w.run, fence: w.fence });
    const next = await claim(w.t, w.ws, w.run, 'worker-2');
    expect(next.fence).toBe(w.fence + 1);
    expect(await w.agent$.call('run.step.complete', { run: w.run, seq: 1 })).toBe(0);
    expect((await w.owner$.observe<StepView>('step', { run: w.run }))[0]?.status).not.toBe('done');
    expect(await next.$.call('run.step.complete', { run: w.run, seq: 1 })).toBe(1);
    const steps = await w.owner$.observe<StepView>('step', { run: w.run });
    expect(steps.map(({ seq, status, fence }) => ({ seq, status, fence }))).toEqual([
      { seq: 1, status: 'done', fence: w.fence },
    ]);
    // New steps are written only at the current fence.
    await refused(
      next.$.call('run.step.write', { run: w.run, fence: w.fence, seq: 2, kind: 'wait' }),
      'denied',
    );
    expect(await w.owner$.observe('step', { run: w.run })).toHaveLength(1);
    await next.$.call('run.step.write', { run: w.run, fence: next.fence, seq: 2, kind: 'wait' });
    expect(
      (await w.owner$.observe<StepView>('step', { run: w.run })).map(({ seq, fence }) => ({ seq, fence })),
    ).toEqual([
      { seq: 1, fence: w.fence },
      { seq: 2, fence: next.fence },
    ]);
  });

  it('[S4] a run cannot act under a mandate held by another agent', async () => {
    const w = await newWorld(target(), 'WrongMandate');
    await refused(
      w.owner$.call('run.queue', { task: w.task, agent: w.verifier, mandate: w.mandate }),
      'mandate_holder',
    );
    expect((await w.owner$.observe<RunView>('run')).map((r) => r.id)).toEqual([w.run]);
  });

  it('[O1] the service queues runs but never writes their state', async () => {
    const w = await newWorld(target(), 'RunState');
    await refused(
      w.owner$.call('led.run_queue_with_state', {
        task: w.task,
        agent: w.agent,
        mandate: w.mandate,
        status: 'running',
        fence: 7,
      }),
      'denied',
      'queue a run already running',
    );
    await w.agent$.call('run.finish', { run: w.run, fence: w.fence, outcome: 'succeeded' });
    await refused(
      w.owner$.call('led.run_set_status', { run: w.run, status: 'running' }),
      'denied',
      'set a run’s status',
    );
    // Neither landed: one run, finished as its holder said.
    const runs = await w.owner$.observe<RunView>('run');
    expect(runs.map(({ id, status, fence }) => ({ id, status, fence }))).toEqual([
      { id: w.run, status: 'succeeded', fence: w.fence },
    ]);
  });
});
