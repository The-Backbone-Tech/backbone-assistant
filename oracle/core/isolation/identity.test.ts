import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Refusal, type Session } from '../../target.ts';
import {
  addPerson,
  issue,
  newWorld,
  propose,
  queueRun,
  readUntrustedAndPrivate,
  refused,
  runIn,
  sleep,
  useTarget,
  type World,
} from '../harness.ts';

const target = useTarget('isolation.identity');

const reasonOf = (error: unknown) => (error instanceof Refusal ? error.reason : Promise.reject(error));

/** Everything a session may do as the run it names, observed from that session. */
async function actingAs(w: World, session: Session) {
  const identity = await session.call<{ principal: string | null; onBehalfOf: string | null }>('identity.whoami');
  // A run reads memory only through the crossing that marks it; a session that is not the run gets none.
  const memories = await session.call<unknown[]>('memory.recall', { run: w.run, limit: 200 }).then(
    (rows) => rows.length,
    () => 0,
  );
  const step = await session.call('run.step.write', { run: w.run, kind: 'wait', input: {}, fence: w.fence }).then(() => 'written', reasonOf);
  const proposal = await session
    .call('effect.propose', { run: w.run, fence: w.fence, args: { a: 1 }, description: 'x', idempotencyKey: `idem-${randomUUID()}` })
    .then(() => 'proposed', reasonOf);
  return { principal: identity.principal, onBehalfOf: identity.onBehalfOf, memories, step, proposal };
}

const remember = (w: World) => w.owner$.call('memory.write', { owner: w.owner, agent: w.agent, content: 'Private: prefers calls after 16:00.' });
// The legacy schema gives one refusal for "not inside the run" and "an old fence" when proposing.
const NOBODY = { principal: null, onBehalfOf: null, memories: 0, step: 'denied', proposal: expect.stringMatching(/^(not_in_run|stale)$/) };
const runRow = async (w: World, id = w.run) => (await w.owner$.observe<{ status: string; stopReason: string; tokensUsed: number }>('run', { id }))[0];

describe('a run acts only while running under a live mandate, and only for the session holding its secret', () => {
  it('[S3] the session holding the secret acts as the run’s agent, for the person its mandate serves', async () => {
    const w = await newWorld(target(), 'Secret');
    await remember(w);
    expect(await actingAs(w, w.agent$)).toEqual({ principal: w.agent, onBehalfOf: w.owner, memories: 1, step: 'written', proposal: 'proposed' });
  });

  it('[S6] naming the run without its secret gives no identity at all, not even the session’s principal', async () => {
    const w = await newWorld(target(), 'NoSecret');
    await remember(w);
    const colleague = await addPerson(w, 'Colleague');
    const at = target().setWorkspace(w.ws);
    // A colleague who learnt the run's id cannot borrow it to read the owner's memory.
    expect(await actingAs(w, at.asRun(w.run, ''))).toEqual(NOBODY);
    expect(await actingAs(w, at.asRun(w.run, 'not-the-secret'))).toEqual(NOBODY);
    expect(await actingAs(w, colleague.$.asRun(w.run, ''))).toEqual(NOBODY);
    expect(await actingAs(w, w.owner$.asRun(w.run, ''))).toEqual(NOBODY);
    await refused(colleague.$.asRun(w.run, '').call('agent.create', { name: 'Borrowed' }), 'no_identity');
  });

  it('[S5] a finished run’s id and secret grant nothing', async () => {
    const w = await newWorld(target(), 'Finished');
    await remember(w);
    await w.agent$.call('run.finish', { run: w.run, fence: w.fence, outcome: 'succeeded' });
    expect(await actingAs(w, w.agent$)).toEqual(NOBODY);
    await refused(w.agent$.call('memory.recall', { run: w.run, limit: 10 }), 'not_in_run');
    expect(await w.agent$.call('run.standing', { run: w.run })).toBe('stopped');
  });

  it('[S5] revocation stops a running run at once; its holder can still record what it already spent', async () => {
    const w = await newWorld(target(), 'RevokedRunning');
    await remember(w);
    const colleague = await addPerson(w, 'Colleague');
    expect((await actingAs(w, w.agent$)).step).toBe('written');
    expect(await w.agent$.call('run.record_usage', { run: w.run, fence: w.fence, tokensIn: 100 })).toBe('ok');

    await w.owner$.call('mandate.revoke', { mandate: w.mandate });

    expect(await runRow(w)).toMatchObject({ status: 'cancelled', stopReason: 'mandate revoked' });
    expect(await actingAs(w, w.agent$)).toEqual(NOBODY);
    // Spending that already happened is recorded, and the answer tells the worker to stop.
    expect(await w.agent$.call('run.record_usage', { run: w.run, fence: w.fence, tokensIn: 25 })).toBe('mandate_revoked');
    expect(await w.agent$.call('run.standing', { run: w.run })).toBe('mandate_revoked');
    expect((await runRow(w))?.tokensUsed).toBe(125);
    // Only the holder records: the id alone, or a stale fence, is refused.
    const borrowed = colleague.$.asRun(w.run, '');
    await refused(borrowed.call('run.record_usage', { run: w.run, fence: w.fence, tokensIn: 1 }), 'stale');
    await refused(w.agent$.call('run.record_usage', { run: w.run, fence: w.fence - 1, tokensIn: 1 }), 'stale');
    expect((await runRow(w))?.tokensUsed).toBe(125);
    expect(await actingAs(w, borrowed)).toEqual(NOBODY);
  });

  it('[S5] a run whose mandate expired no longer acts, though it can still record its spending', async () => {
    const w = await newWorld(target(), 'Expired');
    const brief = await issue(w.owner$, w.agent, { parent: w.mandate, expiresAt: new Date(Date.now() + 1_500) });
    const run = await runIn(w, brief);
    await sleep(1_600);
    expect((await run.$.call<{ principal: string | null }>('identity.whoami')).principal).toBeNull();
    await refused(propose(w, { run }), ['not_in_run', 'stale']);
    expect(await run.$.call('run.record_usage', { run: run.run, fence: run.fence, tokensIn: 5 })).toBe('mandate_expired');
  });

  it('[O1] runs are claimed by worker processes, never by a principal or from inside a run', async () => {
    const w = await newWorld(target(), 'WorkerClaims');
    const { run } = await queueRun(w.owner$, w.owner, w.mandate, w.agent);
    const claimAs = (s: Session) => s.call<{ fence: number; secret: string } | null>('run.claim', { run, worker: 'w2', leaseMs: 60_000 });
    await refused(claimAs(w.owner$), 'workers_only');
    await refused(claimAs(target().setWorkspace(w.ws).asPrincipal(w.agent)), 'workers_only');
    await refused(claimAs(w.agent$), 'workers_only');
    await refused(claimAs(target().setWorkspace(null)), 'no_identity');
    const claimed = await claimAs(w.worker$);
    expect(claimed?.fence).toBe(1);
    expect(claimed?.secret).toMatch(/^[0-9a-f-]{36}\.[0-9a-f-]{36}$/);
  });

  it('[S6] no session marks a run, the run itself included: marks come from what it read, and only rise', async () => {
    const w = await newWorld(target(), 'Taint');
    const other = await runIn(w);
    const marks = async () => {
      const r = (await w.owner$.observe<{ taintedUntrusted: boolean; taintedSensitive: boolean }>('run', { id: w.run }))[0];
      return { untrusted: r?.taintedUntrusted, sensitive: r?.taintedSensitive };
    };
    for (const session of [w.owner$, w.worker$, w.agent$, other.$, w.system$]) {
      await refused(session.call('iso.run.set_marks', { run: w.run, untrusted: true, source: 'x' }), 'denied');
    }
    expect(await marks()).toEqual({ untrusted: false, sensitive: false });
    await readUntrustedAndPrivate(w, w, { untrusted: true, sensitive: false });
    expect(await marks()).toEqual({ untrusted: true, sensitive: false });
    // Not even a writer below every grant lowers a mark or rewrites why it was set.
    for (const name of ['storage.lower_run_mark', 'storage.rewrite_run_mark_source']) {
      expect(await target().adversary.attack(name, { workspace: w.ws, run: w.run })).toMatchObject({ refused: true, reason: 'frozen' });
    }
    expect(await marks()).toEqual({ untrusted: true, sensitive: false });
  });
});

describe('crossings that choose a workspace start from an empty session and leave none behind', () => {
  const nonEmpty = (w: World): [string, Session][] => [
    ['a workspace and a principal', w.owner$],
    ['a workspace', w.worker$],
    ['a run', w.agent$],
    ['a principal alone', w.t.setWorkspace(null).asPrincipal(w.owner)],
  ];

  it('[S1] invitations are read and accepted only from an empty session', async () => {
    const w = await newWorld(target(), 'EmptyInvite');
    for (const [label, session] of nonEmpty(w)) {
      await refused(session.call('iso.invitation.info', { tokenHash: '0'.repeat(64) }), 'empty_session_only', label);
      await refused(session.call('iso.invitation.accept', { tokenHash: '0'.repeat(64), user: 'user-x' }), 'empty_session_only', label);
    }
    expect(await target().setWorkspace(null).observe('workspace')).toEqual([]);
  });
});
