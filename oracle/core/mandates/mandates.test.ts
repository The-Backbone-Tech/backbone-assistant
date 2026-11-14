import { beforeAll, describe, expect, it } from 'vitest';
import {
  addPerson,
  dispatch,
  effect,
  issue,
  newWorld,
  propose,
  proposalArgs,
  queueRun,
  refused,
  runIn,
  sleep,
  useTarget,
  type World,
} from '../harness.ts';
import { attenuate, fc, isWithin, type MandateTerms, normalizeTerms } from '../reference.ts';

const target = useTarget('mandates.mandates');
let w: World;

beforeAll(async () => {
  w = await newWorld(target(), 'Mandates', { ceiling: 3 });
});

interface MandateView {
  ceiling: number;
  tools: unknown;
  connections: unknown;
  operations: unknown;
  maxEffects: number | null;
  expiresAt: Date;
  issuer: string;
  onBehalfOf: string;
  revoked: boolean;
}
const mandate = async (x: Pick<World, 'owner$'>, id: string) => {
  const [row] = await x.owner$.observe<MandateView>('mandate', { id });
  if (!row) throw new Error(`mandate ${id} is not visible`);
  return row;
};
const runRow = async (x: World, id: string) => (await x.owner$.observe<{ status: string; stopReason: string }>('run', { id }))[0];

const ids = fc.constantFrom('a', 'b', 'c', 'd');
const setSpec = fc.oneof(fc.constant<'*'>('*'), fc.uniqueArray(ids, { maxLength: 4 }));
const limit = fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 1_000 }));
const terms: fc.Arbitrary<MandateTerms> = fc.record({
  projects: setSpec,
  connections: setSpec,
  tools: setSpec,
  operations: setSpec,
  ceiling: fc.constantFrom(1, 2, 3, 4),
  budget: fc.record({ maxTokens: limit, maxCostMicros: limit, maxDurationMs: limit, maxEffects: limit }),
  expiresAt: fc.integer({ min: 1_000_000, max: 2_000_000 }),
});

describe('attenuation: a delegated mandate never exceeds its parent', () => {
  it('[S4] the target and the reference kernel compute exactly the same delegated mandate', async () => {
    await fc.assert(
      fc.asyncProperty(terms, terms, async (parent, requested) => {
        const computed = await w.owner$.call<MandateTerms>('policy.attenuate', { parent, requested });
        expect(normalizeTerms(computed)).toEqual(normalizeTerms(attenuate(parent, requested)));
      }),
      { numRuns: 200 },
    );
  });

  it('[S4] even a writer below every grant cannot store a child that exceeds its parent, exactly when the kernel says so', async () => {
    const scaled = (t: MandateTerms) => ({ ...t, expiresAt: t.expiresAt * 1000 });
    await fc.assert(
      fc.asyncProperty(terms, terms, async (parent, child) => {
        const stored = await target().adversary.attack<{ accepted: boolean; reason: string | null }>('storage.store_child_mandate', {
          workspace: w.ws,
          issuer: w.owner,
          subject: w.agent,
          parent,
          child,
        });
        if (!stored.accepted) expect(stored.reason).toBe('exceeds_parent');
        expect(stored.accepted).toBe(isWithin(scaled(child), scaled(parent)));
      }),
      { numRuns: 150 },
    );
  });

  it('[S4] delegating with a greedy request stores only what the parent holds', async () => {
    const child = await issue(w.owner$, w.agent, {
      parent: w.mandate,
      tools: ['search'],
      ceiling: 4,
      maxEffects: 10,
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    });
    const stored = await mandate(w, child);
    const parent = await mandate(w, w.mandate);
    expect(stored.ceiling).toBe(3);
    expect(stored.tools).toEqual(['search']);
    expect(stored.maxEffects).toBe(10);
    expect(new Date(stored.expiresAt).getTime()).toBeLessThanOrEqual(new Date(parent.expiresAt).getTime());
  });

  it('[S4] a child may leave its ceiling and expiry to the parent', async () => {
    const child = await mandate(w, await issue(w.owner$, w.agent, { parent: w.mandate, ceiling: null, expiresAt: null }));
    const parent = await mandate(w, w.mandate);
    expect(child.ceiling).toBe(3);
    const gap = new Date(parent.expiresAt).getTime() - new Date(child.expiresAt).getTime();
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThan(1);
  });
});

describe('who may grant a mandate, and to whom', () => {
  it('[S4] an agent cannot grant itself a root mandate, from inside a run or outside it', async () => {
    for (const session of [target().setWorkspace(w.ws).asPrincipal(w.agent), w.agent$]) {
      await refused(issue(session, w.agent), 'role');
    }
  });

  it('[S4] a root mandate states its ceiling and its expiry', async () => {
    await refused(issue(w.owner$, w.agent, { ceiling: null }), 'invalid');
    await refused(issue(w.owner$, w.agent, { expiresAt: null }), 'invalid');
  });

  it('[S4] a person grants root mandates only to their own workers', async () => {
    const colleague = await addPerson(w, 'Root Colleague', 'admin');
    const theirs = await colleague.$.call<string>('agent.create', { name: 'Their worker' });
    await refused(issue(w.owner$, theirs), 'role');
    await refused(issue(w.owner$, w.verifier), 'role');
    await refused(issue(w.owner$, w.system), 'role');
  });

  it('[S4] work for a person is delegated only to that person’s workers, never to a verifier', async () => {
    const colleague = await addPerson(w, 'Child Colleague');
    const theirs = await colleague.$.call<string>('agent.create', { name: 'Their helper' });
    const mine = await w.owner$.call<string>('agent.create', { name: 'My second worker' });
    await refused(issue(w.owner$, w.verifier, { parent: w.mandate }), 'role');
    await refused(issue(w.agent$, w.verifier, { parent: w.mandate }), 'role');
    await refused(issue(w.owner$, theirs, { parent: w.mandate }), 'role');
    await refused(issue(w.agent$, theirs, { parent: w.mandate }), 'role');
    // The colleague cannot delegate from the owner's mandate at all.
    await refused(issue(colleague.$, theirs, { parent: w.mandate }), 'role');
    const child = await mandate(w, await issue(w.agent$, mine, { parent: w.mandate, ceiling: 2 }));
    expect({ issuer: child.issuer, onBehalfOf: child.onBehalfOf }).toEqual({ issuer: w.agent, onBehalfOf: w.owner });
  });

  it('[S4] a root mandate is bounded by the issuer’s role: members delegate at most class 3', async () => {
    const member = await addPerson(w, 'Member');
    const agent = await member.$.call<string>('agent.create', { name: 'Helper' });
    expect((await mandate(w, await issue(member.$, agent, { ceiling: 4 }))).ceiling).toBe(3);
    await refused(member.$.call('agent.create', { name: 'Judge', role: 'verifier' }), 'role');
    const guest = await addPerson(w, 'Guest', 'guest');
    await refused(guest.$.call('agent.create', { name: 'Guest worker' }), 'role');
  });
});

describe('budgets', () => {
  it('[S13] delegating to oneself cannot reset a limit: effects are charged to every ancestor', async () => {
    const x = await newWorld(target(), 'Budgets', { maxEffects: 2 });
    await dispatch(x, await propose(x));
    const child = await issue(x.owner$, x.agent, { parent: x.mandate, maxEffects: 5 });
    const run = await runIn(x, child);
    const second = await effect(x, await propose(x, { run }));
    const third = await effect(x, await propose(x, { run }));
    expect([second.status, third.routeReason]).toEqual(['allowed', 'budget_exhausted']);
  });

  it('[S13] concurrent proposals under one root are counted exactly: with one effect left, one is allowed', async () => {
    const x = await newWorld(target(), 'Serialised', { maxEffects: 1 });
    const sibling = await runIn(x, await issue(x.owner$, x.agent, { parent: x.mandate }));
    // The first proposal stays uncommitted while seven more, from both runs, are proposed at once.
    const first = proposalArgs(x, { step: 1 });
    const held = first.session.hold<string>('effect.propose', first.args);
    await held.result;
    const rest = target().race<string>(
      Array.from({ length: 7 }, (_, i) => {
        const p = proposalArgs(x, { run: i % 2 === 0 ? sibling : x, step: i + 2 });
        return { session: p.session, crossing: 'effect.propose', args: p.args };
      }),
    );
    await sleep(300);
    held.release();
    await held.committed;
    const settled = await rest;
    const ids = [await held.result, ...settled.map((s) => (s.ok ? s.value : ''))];
    const outcomes = await Promise.all(ids.map((id) => effect(x, id)));
    expect(outcomes.map((e) => e.status)).toEqual(['allowed', ...Array.from({ length: 7 }, () => 'denied')]);
    expect(outcomes.filter((e) => e.routeReason === 'budget_exhausted')).toHaveLength(7);
  });

  it('[S13] recorded model usage is charged against the token limit, and the run learns its standing', async () => {
    const x = await newWorld(target(), 'Tokens');
    const run = await runIn(x, await issue(x.owner$, x.agent, { parent: x.mandate, maxTokens: 1000 }));
    const record = (tokensIn: number) => run.$.call('run.record_usage', { run: run.run, fence: run.fence, tokensIn });
    expect(await record(400)).toBe('ok');
    expect(await record(600)).toBe('budget_exhausted');
    expect(await run.$.call('run.standing', { run: run.run })).toBe('budget_exhausted');
    // A run that spent its tokens can take no new step and gets no effect.
    await refused(run.$.call('run.step.write', { run: run.run, seq: 1, kind: 'model', input: {}, fence: run.fence }), 'denied');
    expect(await x.owner$.observe('step', { run: run.run })).toEqual([]);
    expect(await effect(x, await propose(x, { run }))).toMatchObject({ status: 'denied', routeReason: 'budget_exhausted' });
    // The limit is the child's: the root's other runs are unaffected, since the root has no limit.
    expect((await effect(x, await propose(x))).status).toBe('allowed');
    await refused(record(-5), 'invalid');
  });

  it('[S13] a waiting run whose budget is spent is stopped, not claimed, when claimed by id', async () => {
    const x = await newWorld(target(), 'SpentById', { maxTokens: 10 });
    await x.agent$.call('run.record_usage', { run: x.run, fence: x.fence, tokensIn: 10 });
    await x.agent$.call('run.park', { run: x.run, fence: x.fence });
    expect(await x.worker$.call('run.claim', { run: x.run, worker: 'worker-2', leaseMs: 60_000 })).toBeNull();
    expect(await runRow(x, x.run)).toMatchObject({ status: 'failed', stopReason: 'budget exhausted' });
  });
});

describe('revocation', () => {
  it('[S5] revoking a mandate revokes its whole delegation tree in one operation', async () => {
    const x = await newWorld(target(), 'Revocation');
    const asAgent = target().setWorkspace(x.ws).asPrincipal(x.agent);
    const child = await issue(x.owner$, x.agent, { parent: x.mandate, ceiling: 2 });
    const grandchild = await issue(asAgent, x.agent, { parent: child, ceiling: 1 });
    expect(await x.owner$.call('mandate.revoke', { mandate: x.mandate })).toBe(3);
    for (const id of [x.mandate, child, grandchild]) expect((await mandate(x, id)).revoked).toBe(true);
    await refused(issue(asAgent, x.agent, { parent: child }), 'revoked');
  });

  it('[S5] only the grantor, the person it acts for, or an admin revokes a mandate', async () => {
    const x = await newWorld(target(), 'WhoRevokes');
    const member = await addPerson(x, 'Member');
    await refused(member.$.call('mandate.revoke', { mandate: x.mandate }), 'role');
    expect((await mandate(x, x.mandate)).revoked).toBe(false);
    const second = await addPerson(x, 'Second admin', 'admin');
    await second.$.call('mandate.revoke', { mandate: x.mandate });
    expect((await mandate(x, x.mandate)).revoked).toBe(true);
  });

  it('[S5] a run is not claimed under an expired mandate', async () => {
    const x = await newWorld(target(), 'ExpiredClaim');
    const brief = await issue(x.owner$, x.agent, { parent: x.mandate, expiresAt: new Date(Date.now() + 300) });
    const { run } = await queueRun(x.owner$, x.owner, brief, x.agent);
    await sleep(400);
    expect(await x.worker$.call('run.claim', { run, worker: 'worker-1', leaseMs: 60_000 })).toBeNull();
    expect(await runRow(x, run)).toMatchObject({ status: 'cancelled', stopReason: 'mandate expired' });
  });
});

/** A mandate is read by every member: it never names a person's own connection, whose name is that person's. */
describe('a mandate names no person’s own connection', () => {
  it('[S4] refused in its connections, a tool’s model name or an operation, whoever issues it; the workspace’s are named as before', async () => {
    const x = await newWorld(target(), 'MandateNames');
    const pau = await addPerson(x, 'Pau');
    const pauWorker = await pau.$.call<string>('agent.create', { name: 'Pau worker' });
    await x.owner$.call('man.connection_register', { name: 'Marta’s bank', slug: 'marta_bank', scope: 'person' });
    await x.owner$.call('man.connection_register', { name: 'CRM', slug: 'team_crm', scope: 'workspace' });
    const named = (connections: unknown, tools: unknown, operations: unknown) => ({
      projects: '*',
      connections,
      tools,
      operations,
      ceiling: 2,
    });
    for (const t of [named(['marta_bank'], '*', '*'), named('*', ['marta_bank__list_transfers'], '*'), named('*', '*', ['mcp.marta_bank.list_transfers'])]) {
      for (const [session, agent] of [
        [x.owner$, x.agent],
        [pau.$, pauWorker],
      ] as const) {
        await refused(issue(session, agent, t), 'invalid', JSON.stringify(t));
      }
    }
    await issue(x.owner$, x.agent, named(['team_crm'], ['team_crm__get_deal'], ['mcp.team_crm.get_deal']));
    await issue(x.owner$, x.agent, named('*', '*', '*'));
    const read = JSON.stringify(await pau.$.observe('mandate'));
    expect(read).toContain('team_crm');
    expect(read).not.toContain('marta_bank');
  });
});
