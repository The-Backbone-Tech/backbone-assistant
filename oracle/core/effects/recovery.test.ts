import { describe, expect, it } from 'vitest';
import {
  answer,
  decisionOf,
  dispatch,
  effect,
  issue,
  newWorld,
  propose,
  refused,
  runIn,
  sleep,
  useTarget,
} from '../harness.ts';

const target = useTarget('effects.recovery');

describe('recovery semantics', () => {
  it('[S8] once dispatch has begun, an effect cannot be cancelled', async () => {
    const w = await newWorld(target(), 'NoCancel');
    const id = await propose(w);
    const claim = await w.system$.call<string>('effect.claim', { effect: id, leaseMs: 30_000 });
    expect(await w.system$.call('effect.begin_dispatch', { effect: id, claim })).toBe(true);
    await refused(w.owner$.call('effect.cancel', { effect: id, reason: 'too late' }), 'too_late');
    expect((await effect(w, id)).status).toBe('dispatching');
  });

  it('[S8] an unknown outcome is reconciled by the dispatcher or an admin, never by the proposer, and never re-claimed', async () => {
    const w = await newWorld(target(), 'Unknown');
    const id = await propose(w);
    await dispatch(w, id, 'unknown', '');
    expect((await effect(w, id)).status).toBe('unknown');
    await refused(w.system$.call('effect.claim', { effect: id, leaseMs: 30_000 }), 'not_claimable');
    for (const session of [w.agent$, w.t.setWorkspace(w.ws).asPrincipal(w.agent)]) {
      await refused(
        session.call('effect.reconcile', {
          effect: id,
          outcome: 'succeeded',
          externalRef: 'x',
          observationHash: 'y',
          note: 'trust me',
        }),
        'reconciler',
      );
    }
    expect((await effect(w, id)).status).toBe('unknown');
    await w.system$.call('effect.reconcile', {
      effect: id,
      outcome: 'succeeded',
      externalRef: 'crm://deal/7',
      observationHash: 'obs',
      note: 'found by idempotency key',
    });
    expect((await effect(w, id)).status).toBe('succeeded');
  });

  it('[O1] a dispatcher that lost its claim cannot begin dispatch', async () => {
    const w = await newWorld(target(), 'StaleClaim');
    const id = await propose(w);
    const first = await w.system$.call<string>('effect.claim', { effect: id, leaseMs: 1 });
    await sleep(20);
    const second = await w.system$.call<string>('effect.claim', { effect: id, leaseMs: 30_000 });
    expect(second).not.toBe(first);
    await refused(w.system$.call('effect.begin_dispatch', { effect: id, claim: first }), 'stale');
    expect((await effect(w, id)).status).toBe('claimed');
    expect(await w.system$.call('effect.begin_dispatch', { effect: id, claim: second })).toBe(true);
    expect((await effect(w, id)).status).toBe('dispatching');
  });

  it('[S5] authority is re-checked when it is spent: revoked after approval means cancelled, not dispatched', async () => {
    const w = await newWorld(target(), 'Recheck');
    const id = await propose(w, { classHint: 5 });
    await answer(w.owner$, w, await decisionOf(w, id));
    const claim = await w.system$.call<string>('effect.claim', { effect: id, leaseMs: 30_000 });
    await w.owner$.call('mandate.revoke', { mandate: w.mandate });
    expect((await effect(w, id)).status).toBe('cancelled');
    await refused(w.system$.call('effect.begin_dispatch', { effect: id, claim }), 'stale');
    expect((await effect(w, id)).status).toBe('cancelled');
  });

  it('[S5] an effect whose mandate expired after it was claimed is cancelled when dispatch would begin', async () => {
    const w = await newWorld(target(), 'ExpiredAtDispatch');
    const brief = await issue(w.owner$, w.agent, {
      parent: w.mandate,
      expiresAt: new Date(Date.now() + 1_500),
    });
    const run = await runIn(w, brief);
    const id = await propose(w, { run });
    const claim = await w.system$.call<string>('effect.claim', { effect: id, leaseMs: 30_000 });
    await sleep(1_600);
    expect(await w.system$.call('effect.begin_dispatch', { effect: id, claim })).toBe(false);
    expect((await effect(w, id)).status).toBe('cancelled');
  });

  it('[S5] revoking a mandate cancels effects that have not been dispatched and withdraws their questions', async () => {
    const w = await newWorld(target(), 'RevokeEffects', { windowMs: 60_000 });
    const delayed = await propose(w, { operation: 'email.send' });
    const asked = await propose(w, { classHint: 5 });
    await w.owner$.call('mandate.revoke', { mandate: w.mandate });
    expect((await effect(w, delayed)).status).toBe('cancelled');
    expect((await effect(w, asked)).status).toBe('cancelled');
    const questions = await w.owner$.observe<{ status: string }>('decision', { subject: asked });
    expect(questions.map((q) => q.status)).toEqual(['withdrawn']);
  });
});
