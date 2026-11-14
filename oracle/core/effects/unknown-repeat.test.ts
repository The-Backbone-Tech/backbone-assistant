import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Id } from '../../target.ts';
import {
  addPerson,
  claim,
  classify,
  dispatch,
  issue,
  newWorld,
  refused,
  runIn,
  sleep,
  useTarget,
} from '../harness.ts';
import {
  connectedArgs,
  connectedWorld,
  connector,
  detail,
  privateRun,
  proposeConnected,
  runOnTask,
} from './fixtures.ts';

const target = useTarget('effects.unknown-repeat');

/**
 * The legacy "phase-A connected effect repeat guard": a change through a registered connector whose
 * earlier exact copy (same task, beneficiary, connector, operation, arguments and expected version)
 * is still unresolved is recorded as a denied receipt linked to that original, under any new key.
 */
describe('an unclear outcome is never re-sent, not under a new key either', () => {
  it('[S8] the service reaches the effect record only through the gateway: it cannot insert, change or delete an effect row', async () => {
    const { w, c } = await connectedWorld(target());
    const original = await proposeConnected(w, c, { step: 1 });
    await refused(
      w.agent$.call('eff.direct_write', { op: 'insert', run: w.run, proposer: w.agent, mandate: w.mandate }),
      'denied',
    );
    await refused(
      w.owner$.call('eff.direct_write', { op: 'insert', run: w.run, proposer: w.agent, mandate: w.mandate }),
      'denied',
    );
    await refused(w.system$.call('eff.direct_write', { op: 'update', effect: original }), 'denied');
    await refused(w.owner$.call('eff.direct_write', { op: 'delete', effect: original }), 'denied');
    const all = await w.owner$.observe<{ id: Id; status: string }>('eff.effect_detail');
    expect(all.map((e) => [e.id, e.status])).toEqual([[original, 'allowed']]);
  });

  it('[S8] an exact copy of an unknown change is a durable denied receipt under any key, and its own key replays it after reconciliation', async () => {
    const { w, c } = await connectedWorld(target());
    const original = await proposeConnected(w, c, { step: 1 });
    await dispatch(w, original, 'unknown');
    const key = `copy-${randomUUID()}`;
    const blocked = await proposeConnected(w, c, { step: 2, key });
    expect(await detail(w, blocked)).toMatchObject({
      status: 'denied',
      route: 'denied',
      routeReason: 'repeat_unknown_blocked',
      repeatOf: original,
      decision: null,
    });
    expect((await detail(w, original)).status).toBe('unknown');
    const proposed = (
      await w.owner$.observe<{ type: string; payload: Record<string, unknown> }>('ledger', {
        subject: blocked,
      })
    ).filter((e) => e.type === 'effect.proposed');
    expect(proposed.map((e) => e.payload.repeat_of)).toEqual([original]);

    await w.system$.call('effect.reconcile', {
      effect: original,
      outcome: 'succeeded',
      externalRef: 'synthetic',
      observationHash: 'observed',
      note: 'owner check',
    });
    // The copy's own key returns the copy, still denied: reconciling never turns it into a send.
    expect(await proposeConnected(w, c, { step: 2, key })).toBe(blocked);
    expect((await detail(w, blocked)).status).toBe('denied');
    const fresh = await proposeConnected(w, c, { step: 3 });
    expect(await detail(w, fresh)).toMatchObject({ repeatOf: null, status: 'allowed' });
    const blockedFreshCopy = await proposeConnected(w, c, { step: 4 });
    expect(await detail(w, blockedFreshCopy)).toMatchObject({ repeatOf: fresh, status: 'denied' });
    await dispatch(w, fresh, 'succeeded');
    const afterFreshSettled = await proposeConnected(w, c, { step: 5 });
    expect(await detail(w, afterFreshSettled)).toMatchObject({ repeatOf: null, status: 'allowed' });
  });

  it('[S8] pending custody blocks an exact copy in every unresolved state, and a denied copy is never the original', async () => {
    const t = target();
    const { w, c } = await connectedWorld(t);
    const pending = await proposeConnected(w, c, { step: 1 });
    const copies: Id[] = [];
    const copy = async (reason: string) => {
      const id = await proposeConnected(w, c, { step: 10 + copies.length });
      copies.push(id);
      expect(await detail(w, id)).toMatchObject({
        status: 'denied',
        repeatOf: pending,
        routeReason: reason,
        decision: null,
      });
    };
    await copy('repeat_pending'); // allowed
    await copy('repeat_pending'); // a later copy links to the original, not to the denied copy
    const token = await w.system$.call<string>('effect.claim', { effect: pending, leaseMs: 30_000 });
    await copy('repeat_pending'); // claimed
    expect(await w.system$.call('effect.begin_dispatch', { effect: pending, claim: token })).toBe(true);
    await copy('repeat_pending'); // dispatching
    await w.system$.call('effect.observe', {
      effect: pending,
      claim: token,
      outcome: 'unknown',
      externalRef: null,
    });
    await copy('repeat_unknown_blocked'); // unknown
    expect((await detail(w, pending)).status).toBe('unknown');
    // A copy awaiting a checker is custody too.
    const asked = await proposeConnected(w, c, {
      step: 30,
      args: { deal: 'D-43', stage: 'won' },
      classHint: 5,
    });
    expect((await detail(w, asked)).status).toBe('awaiting_checker');
    const askedCopy = await proposeConnected(w, c, {
      step: 31,
      args: { deal: 'D-43', stage: 'won' },
      classHint: 5,
    });
    expect(await detail(w, askedCopy)).toMatchObject({
      status: 'denied',
      repeatOf: asked,
      routeReason: 'repeat_pending',
      decision: null,
    });
  });

  it('[O1] independent roots for the same task and beneficiary are serialised: of two simultaneous copies exactly one is allowed', async () => {
    const t = target();
    const { w, c } = await connectedWorld(t);
    const agent2 = await w.owner$.call<Id>('agent.create', {
      name: `Second worker ${randomUUID().slice(0, 8)}`,
    });
    const mandate2 = await issue(w.owner$, agent2);
    const second = await runOnTask(t, w.ws, w.owner$, w.task, mandate2, agent2);
    const runs = await w.owner$.observe<{ id: Id; task: Id; mandate: Id }>('run', {
      ids: [w.run, second.run],
    });
    expect(runs.map((r) => r.task)).toEqual([w.task, w.task]);
    expect(new Set(runs.map((r) => r.mandate)).size).toBe(2);
    const mandates = await w.owner$.observe<{ id: Id; onBehalfOf: Id }>('mandate');
    const beneficiaries = mandates
      .filter((m) => m.id === w.mandate || m.id === mandate2)
      .map((m) => m.onBehalfOf);
    expect(beneficiaries).toEqual([w.owner, w.owner]);
    const settled = await t.race<Id>(
      [w, second].map((held, i) => ({
        session: held.$,
        crossing: 'eff.propose_connected',
        args: connectedArgs(held, c, { step: 1, key: `race-${i}-${randomUUID()}` }),
      })),
    );
    const ids = settled.map((s) => {
      if (!s.ok) throw s.refusal;
      return s.value;
    });
    const rows = await Promise.all(ids.map((id) => detail(w, id)));
    expect(rows.filter((r) => r.status === 'allowed')).toHaveLength(1);
    const denied = rows.filter((r) => r.status === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]?.repeatOf).toBe(rows.find((r) => r.status === 'allowed')?.id);
  });

  it('[O1] a copy proposed while a different root’s original is uncommitted sees the original once it commits', async () => {
    const t = target();
    const { w, c } = await connectedWorld(t);
    const agent2 = await w.owner$.call<Id>('agent.create', {
      name: `Barrier worker ${randomUUID().slice(0, 8)}`,
    });
    const second = await runOnTask(t, w.ws, w.owner$, w.task, await issue(w.owner$, agent2), agent2);
    const held = w.$.hold<Id>('eff.propose_connected', connectedArgs(w, c, { step: 1 }));
    const first = await held.result;
    const waiting = second.$.call<Id>('eff.propose_connected', connectedArgs(second, c, { step: 1 }));
    await sleep(300);
    held.release();
    await held.committed;
    const copy = await waiting;
    expect(await detail(w, first)).toMatchObject({ status: 'allowed', repeatOf: null, decision: null });
    expect(await detail(w, copy)).toMatchObject({ status: 'denied', repeatOf: first, decision: null });
  });

  it('[O1] a denied copy commits while the original’s dispatch waits for it, and the dispatch then goes ahead once', async () => {
    const t = target();
    const { w, c } = await connectedWorld(t);
    const agent2 = await w.owner$.call<Id>('agent.create', {
      name: `Lock-order worker ${randomUUID().slice(0, 8)}`,
    });
    const second = await runOnTask(t, w.ws, w.owner$, w.task, await issue(w.owner$, agent2), agent2);
    const original = await proposeConnected(w, c, { step: 1 });
    const token = await w.system$.call<string>('effect.claim', { effect: original, leaseMs: 30_000 });
    const held = second.$.hold<Id>('eff.propose_connected', connectedArgs(second, c, { step: 1 }));
    const copy = await held.result;
    const dispatching = w.system$.call<boolean>('effect.begin_dispatch', { effect: original, claim: token });
    await sleep(300);
    held.release();
    await held.committed;
    expect(await dispatching).toBe(true);
    expect(await detail(w, copy)).toMatchObject({ status: 'denied', repeatOf: original });
    expect((await detail(w, original)).status).toBe('dispatching');
    expect(await w.owner$.call('ledger.verify')).toBeNull();
  });

  it('[S8] another task, and a read the catalogue makes class 1, are outside the exact-change block', async () => {
    const t = target();
    const { w, c } = await connectedWorld(t);
    const read = { operation: `mcp.${c.slug}.read_note`, tool: `${c.slug}__read_note`, classHint: 1 };
    const original = await proposeConnected(w, c, { step: 1, ...read });
    await dispatch(w, original, 'unknown');
    // A hint cannot lower an unclassified read below class 3, so its copy is blocked.
    const class3Copy = await proposeConnected(w, c, { step: 2, ...read });
    expect(await detail(w, class3Copy)).toMatchObject({
      effectClass: 3,
      repeatOf: original,
      routeReason: 'repeat_unknown_blocked',
    });

    await classify(w.owner$, [{ operation: `mcp.${c.slug}.read_note`, class: 1, external: true }]);
    const classified = await proposeConnected(w, c, { step: 3, ...read });
    expect(await detail(w, classified)).toMatchObject({ effectClass: 1, repeatOf: null, status: 'allowed' });

    const change = await proposeConnected(w, c, { step: 4 });
    await dispatch(w, change, 'unknown');
    const other = await runIn(w);
    const independentTask = await proposeConnected(other, c, { step: 1 });
    expect(await detail(w, independentTask)).toMatchObject({ repeatOf: null, status: 'allowed' });
  });

  it('[S8] a different connector, operation, payload or expected version is a different intent', async () => {
    const { w, c } = await connectedWorld(target());
    const original = await proposeConnected(w, c, { step: 1, expectedVersion: 'v1' });
    await dispatch(w, original, 'unknown');
    const otherConnection = await connector(w);
    const candidates = [
      await proposeConnected(w, otherConnection, { step: 2, expectedVersion: 'v1' }),
      await proposeConnected(w, c, {
        step: 3,
        operation: `mcp.${c.slug}.archive_deal`,
        expectedVersion: 'v1',
      }),
      await proposeConnected(w, c, { step: 4, args: { deal: 'D-42', stage: 'lost' }, expectedVersion: 'v1' }),
      await proposeConnected(w, c, { step: 5, expectedVersion: 'v2' }),
    ];
    for (const id of candidates)
      expect(await detail(w, id)).toMatchObject({ status: 'allowed', repeatOf: null });
    // The control: the exact copy is blocked.
    expect(await detail(w, await proposeConnected(w, c, { step: 6, expectedVersion: 'v1' }))).toMatchObject({
      status: 'denied',
      repeatOf: original,
    });
  });

  it('[S8] an unknown change made for another beneficiary on the same task does not block this one', async () => {
    const t = target();
    const { w, c } = await connectedWorld(t, 'team');
    const run = await privateRun(w);
    const other = await addPerson(w, `Other beneficiary ${randomUUID().slice(0, 8)}`);
    const otherAgent = await other.$.call<Id>('agent.create', {
      name: `Other worker ${randomUUID().slice(0, 8)}`,
    });
    const otherMandate = await issue(other.$, otherAgent);
    // Another person cannot work on a task that is not shared with them.
    await refused(
      other.$.call('run.queue', { task: run.task, agent: otherAgent, mandate: otherMandate }),
      'not_found',
    );
    await refused(
      other.$.call('run.queue', { task: randomUUID(), agent: otherAgent, mandate: otherMandate }),
      'not_found',
    );
    await w.owner$.call('eff.task.share', { task: run.task });
    const priorRun = await other.$.call<Id>('run.queue', {
      task: run.task,
      agent: otherAgent,
      mandate: otherMandate,
    });
    const prior$ = { run: priorRun, ...(await claim(t, w.ws, priorRun, 'other-worker')) };
    const prior = await proposeConnected(prior$, c, { step: 1 });
    await dispatch(w, prior, 'unknown');
    expect((await detail(w, prior)).status).toBe('unknown');
    const candidate = await proposeConnected(run, c, { step: 1 });
    expect(await detail(w, candidate)).toMatchObject({ status: 'allowed', repeatOf: null });
    expect(candidate).not.toBe(prior);
  });

  it('[S8] a change naming the wrong connector is refused, and a project does not partition the block', async () => {
    const { w, c } = await connectedWorld(target());
    const original = await proposeConnected(w, c, { step: 1 });
    await dispatch(w, original, 'unknown');
    const key = `wrong-connection-${randomUUID()}`;
    await refused(proposeConnected(w, c, { step: 2, key, connection: 'another_slug' }), 'invalid');
    expect(await w.owner$.observe('effect', { idempotencyKey: key })).toEqual([]);
    const withProject = await proposeConnected(w, c, {
      step: 2,
      project: 'does-not-partition-repeat-identity',
    });
    expect(await detail(w, withProject)).toMatchObject({ repeatOf: original, status: 'denied' });
  });
});

describe('the record of an unknown outcome and its blocked copies cannot be erased, even below every grant', () => {
  it('[S8] lineage is immutable: unlinking, deleting, re-keying, truncating or forging a mismatched copy is refused', async () => {
    const t = target();
    const { w, c } = await connectedWorld(t);
    const original = await proposeConnected(w, c, { step: 1 });
    await dispatch(w, original, 'unknown');
    const blocked = await proposeConnected(w, c, { step: 2 });
    const before = await w.owner$.observe('eff.effect_detail');
    const outcome = await t.adversary.attack<Record<string, { code: string | null; message: string | null }>>(
      'eff.rewrite_lineage',
      {
        workspace: w.ws,
        blocked,
        original,
        run: w.run,
        agent: w.agent,
        mandate: w.mandate,
        slug: c.slug,
      },
    );
    expect(Object.keys(outcome).sort()).toEqual(
      [
        'deleteOriginal',
        'mismatchedCopy',
        'moveOriginal',
        'rekeyOriginal',
        'selfCopy',
        'truncate',
        'truncateCascade',
        'unlinkCopy',
      ].sort(),
    );
    for (const [attempt, result] of Object.entries(outcome))
      expect(result.code, `${attempt} was not refused`).not.toBeNull();
    expect(await w.owner$.observe('eff.effect_detail')).toEqual(before);
    expect(await detail(w, blocked)).toMatchObject({ status: 'denied', repeatOf: original });
    expect((await detail(w, original)).status).toBe('unknown');
  });

  it('[S8] forged lineage is refused at commit: a missing or foreign original, a cycle, or a copy without a route', async () => {
    const t = target();
    const { w, c } = await connectedWorld(t);
    const foreign = await newWorld(t, `Foreign repeat ${randomUUID().slice(0, 8)}`, {
      kind: 'personal',
      verifier: false,
    });
    const foreignConnector = await connector(foreign);
    const before = await w.owner$.observe('eff.effect_detail');
    const outcome = await t.adversary.attack<Record<string, { code: string | null; message: string | null }>>(
      'eff.forge_lineage',
      {
        workspace: w.ws,
        run: w.run,
        agent: w.agent,
        mandate: w.mandate,
        slug: c.slug,
        foreign: {
          workspace: foreign.ws,
          run: foreign.run,
          agent: foreign.agent,
          mandate: foreign.mandate,
          slug: foreignConnector.slug,
        },
      },
    );
    for (const attempt of ['missingOriginal', 'crossWorkspace', 'twoNodeCycle', 'nullRoute']) {
      expect(outcome[attempt]?.code, `${attempt} was not refused`).toBeTruthy();
    }
    // The control: a well-formed row of the same shape without lineage goes through, so the refusals are about lineage.
    expect(outcome.wellFormedRoot).toEqual({ code: null, message: null });
    expect(await w.owner$.observe('eff.effect_detail')).toEqual(before);
    expect(await foreign.owner$.observe('eff.effect_detail')).toEqual([]);
  });
});
