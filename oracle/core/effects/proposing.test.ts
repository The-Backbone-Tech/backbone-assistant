import { beforeAll, describe, expect, it } from 'vitest';
import {
  answer,
  decision,
  decisionOf,
  dispatch,
  effect,
  issue,
  newWorld,
  proposalArgs,
  propose,
  readUntrustedAndPrivate,
  refused,
  runIn,
  useTarget,
  type World,
} from '../harness.ts';
import { privateRun } from './fixtures.ts';

const target = useTarget('eff.proposing');

describe('proposing and dispatching', () => {
  let w: World;
  beforeAll(async () => {
    w = await newWorld(target(), 'Dispatch', { ceiling: 3 });
  });

  it('[S8] a reversible external change inside the mandate is allowed, dispatched by the system and receipted', async () => {
    const id = await propose(w);
    expect((await effect(w, id)).status).toBe('allowed');
    await dispatch(w, id);
    const done = await effect(w, id);
    expect(done.status).toBe('succeeded');
    const receipts = (
      await w.owner$.observe<{ type: string; payload: Record<string, unknown> }>('ledger', { subject: id })
    ).filter((e) => e.type === 'effect.observed');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.payload).toMatchObject({
      outcome: 'succeeded',
      external_ref: 'crm://deal/42',
      dispatcher: w.system,
      args_hash: done.argsHash,
    });
  });

  it('[S14] the database hashes the arguments, and a checker approves exactly those arguments', async () => {
    const args = { to: 'acct-7', amount: 120 };
    const id = await propose(w, { operation: 'payment.send', args });
    const e = await effect(w, id);
    expect((e as unknown as { args: unknown }).args).toEqual(args);
    expect(e.argsHash).toMatch(/^[0-9a-f]{64}$/);
    const question = await decision(w, e.decision ?? '');
    expect(question.proposalHash).toBe(e.argsHash);
    // The hash of other arguments, as the gateway itself computes it, does not answer this question.
    const other = await effect(
      w,
      await propose(w, { operation: 'payment.send', args: { ...args, to: 'acct-9' } }),
    );
    expect(other.argsHash).not.toBe(e.argsHash);
    await refused(
      w.owner$.call('decision.answer', {
        decision: question.id,
        proposalHash: other.argsHash,
        verdict: 'approved',
      }),
      'different_proposal',
    );
    expect((await effect(w, id)).status).toBe('awaiting_checker');
    expect((await decision(w, question.id)).status).toBe('open');
  });

  it('[S8] the proposing agent cannot dispatch its own effect', async () => {
    const id = await propose(w);
    for (const session of [w.agent$, w.t.setWorkspace(w.ws).asPrincipal(w.agent), w.owner$]) {
      await refused(session.call('effect.claim', { effect: id, leaseMs: 30_000 }), 'system_dispatches');
    }
    expect((await effect(w, id)).status).toBe('allowed');
  });

  it('[S8] effects are proposed only from inside their run, by the worker holding its fence and secret', async () => {
    const outside = w.t.setWorkspace(w.ws).asPrincipal(w.agent);
    const keys: string[] = [];
    const attempt = (o: Parameters<typeof proposalArgs>[1], session?: typeof outside) => {
      const p = proposalArgs(w, o);
      keys.push(p.args.idempotencyKey);
      return (session ?? p.session).call('effect.propose', p.args);
    };
    const noSecret = { run: w.run, fence: w.fence, $: w.t.setWorkspace(w.ws).asRun(w.run, '') };
    // The legacy text for a session outside the run (no secret, or a principal) is the stale-fence
    // one; either reason is a refusal to act outside the run.
    await refused(attempt({ run: noSecret }), ['not_in_run', 'stale']);
    await refused(attempt({ operation: 'crm:x' }, outside), ['not_in_run', 'stale']);
    await refused(attempt({ fence: w.fence - 1 }), 'stale');
    await refused(attempt({ operation: 'crm:x', args: null }), 'invalid');
    for (const key of keys) expect(await w.owner$.observe('effect', { idempotencyKey: key })).toEqual([]);
  });

  it('[O1] the same idempotency key returns the same effect, even under concurrency', async () => {
    const key = `idem-concurrent-${Date.now()}`;
    const { session, args } = proposalArgs(w, { key });
    const settled = await w.t.race<string>(
      Array.from({ length: 6 }, () => ({ session, crossing: 'effect.propose', args })),
    );
    const ids = settled.map((s) => (s.ok ? s.value : `refused: ${s.refusal.message}`));
    expect(new Set(ids).size).toBe(1);
    expect(await w.owner$.observe('effect', { idempotencyKey: key })).toHaveLength(1);
    await refused(propose(w, { key, args: { different: true } }), 'reused_key');
    await refused(propose(w, { key, operation: 'crm:other' }), 'reused_key');
    expect(await w.owner$.observe('effect', { idempotencyKey: key })).toHaveLength(1);
  });

  it('[S4] something above the ceiling goes to the person the work is for', async () => {
    const id = await propose(w, { classHint: 4 }); // ceiling is 3
    const e = await effect(w, id);
    expect(e).toMatchObject({ status: 'awaiting_checker', routeReason: 'above_ceiling' });
    expect(await decision(w, e.decision ?? '')).toMatchObject({ checkerKind: 'person', checker: w.owner });
  });

  it('[S8] untrusted input, sensitive data and an external effect together go to a verifier', async () => {
    const x = await newWorld(w.t, 'RuleOfTwo');
    const run = await privateRun(x);
    await readUntrustedAndPrivate(x, run);
    const external = await effect(x, await propose(x, { run }));
    expect(external).toMatchObject({ status: 'awaiting_checker', routeReason: 'rule_of_two' });
    expect(await decision(x, external.decision ?? '')).toMatchObject({
      checkerKind: 'verifier',
      checker: x.owner,
    });
    expect((await effect(x, await propose(x, { run, operation: 'workspace.update_task' }))).status).toBe(
      'allowed',
    );
  });

  it('[S8] the cancellation window is the workspace’s, not the proposer’s', async () => {
    const x = await newWorld(w.t, 'Window', { windowMs: 60_000 });
    const id = await propose(x, { operation: 'email.send' });
    expect((await effect(x, id)).status).toBe('allowed');
    await refused(x.system$.call('effect.claim', { effect: id, leaseMs: 30_000 }), 'window');
    await refused(x.agent$.call('workspace.set_delay_window', { ms: 0 }), 'role');
    // The window still holds: the agent could not shorten it.
    await refused(x.system$.call('effect.claim', { effect: id, leaseMs: 30_000 }), 'window');
    await x.owner$.call('effect.cancel', { effect: id, reason: 'changed my mind' });
    expect((await effect(x, id)).status).toBe('cancelled');
  });
});

describe('a rejected proposal is not asked again under the same authority', () => {
  it('[S4] the same payment with a new idempotency key is denied as already rejected; other arguments ask anew', async () => {
    const w = await newWorld(target(), 'Rejected');
    const args = { to: 'acct-7', amount: 120 };
    const first = await propose(w, { operation: 'payment.send', args });
    await answer(w.owner$, w, await decisionOf(w, first), 'rejected');
    expect((await effect(w, first)).status).toBe('denied');

    const again = await propose(w, { operation: 'payment.send', args });
    expect(await effect(w, again)).toMatchObject({
      status: 'denied',
      route: 'denied',
      routeReason: 'already_rejected',
      decision: null,
    });
    // Not from another run under a delegated mandate of the same root either.
    const child = await issue(w.owner$, w.agent, { parent: w.mandate });
    const sibling = await runIn(w, child);
    expect(
      await effect(w, await propose(w, { run: sibling, operation: 'payment.send', args })),
    ).toMatchObject({
      routeReason: 'already_rejected',
    });
    // Different arguments are a different question.
    const smaller = await propose(w, { operation: 'payment.send', args: { ...args, amount: 80 } });
    expect((await effect(w, smaller)).status).toBe('awaiting_checker');
    // A new grant of authority by the person is a new authority.
    const fresh = await runIn(w, await issue(w.owner$, w.agent));
    expect((await effect(w, await propose(w, { run: fresh, operation: 'payment.send', args }))).status).toBe(
      'awaiting_checker',
    );
  });
});
