import { mkdir, writeFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Session } from '../../target.ts';
import {
  addPerson,
  candidateWithEvidence,
  classify,
  dispatch,
  propose,
  newWorld,
  refused,
  requestPromotion,
  useTarget,
  verifierAnswer,
  type World,
} from '../harness.ts';

const target = useTarget('isolation.wall');
let a: World;
let b: World;

interface Store {
  store: string;
  readable: boolean;
}

/** Put rows in the core stores of a workspace, through the crossings the product uses. */
async function populate(w: World) {
  await classify(w.owner$, [{ operation: 'crm:update_deal', class: 3, external: true, description: 'CRM' }]);
  await dispatch(w, await propose(w));
  await propose(w, { classHint: 5 }); // an open decision
  const { candidate } = await candidateWithEvidence(w, 'Launch moved to 3 November.', 'Launch moved to 3 November.');
  await verifierAnswer(w.verifier$, w, await requestPromotion(w, candidate));
  await w.owner$.call('memory.write', { owner: w.owner, agent: w.agent, content: 'Prefers a Monday summary.' });
  await w.owner$.call('iso.message.post', { task: w.task, author: w.owner, content: 'Where are we?' });
  await w.agent$.call('run.step.write', { run: w.run, fence: w.fence, kind: 'tool', input: { q: 1 } });
  const document = await w.owner$.call<string>('iso.document.create', { task: w.task, content: 'v1', by: w.owner });
  await w.owner$.call('iso.document.revise', { document, content: 'v2', by: w.owner });
  await addPerson(w, `Colleague ${w.ws.slice(-6)}`);
}

let stores: Store[];

beforeAll(async () => {
  a = await newWorld(target(), 'Alpha');
  b = await newWorld(target(), 'Beta');
  await populate(a);
  await populate(b);
  stores = await a.owner$.observe<Store>('catalog.stores');
});

const rows = (session: Session, store: string, workspace: string | null) =>
  session.observe<{ mine: number; others: number; total: number }>('catalog.rows', { store, workspace }).then((r) => r[0]);

describe('the tenant wall', () => {
  it('[S1] the fixture puts rows in both workspaces, in every core store it reaches', async () => {
    const populated: string[] = [];
    for (const { store } of stores.filter((s) => s.readable)) {
      const counts = await Promise.all([rows(a.owner$, store, a.ws), rows(b.owner$, store, b.ws)]);
      if (counts.every((c) => (c?.mine ?? 0) > 0)) populated.push(store);
    }
    await mkdir(new URL('../../results/', import.meta.url), { recursive: true });
    await writeFile(
      new URL('../../results/isolation-populated-stores.json', import.meta.url),
      JSON.stringify({ readable: stores.filter((s) => s.readable).length, populated }, null, 2),
    );
    // Without rows on both sides the next case would hold vacuously for that store.
    expect(populated).toEqual(
      expect.arrayContaining(['workspaces', 'principals', 'mandates', 'decisions', 'tasks', 'runs', 'run_steps']),
    );
    expect(populated).toEqual(
      expect.arrayContaining(['effects', 'ledger', 'episodes', 'knowledge_candidates', 'knowledge', 'messages', 'memory']),
    );
    expect(populated).toEqual(expect.arrayContaining(['operations', 'documents', 'document_versions']));
  });

  it('[S1] a workspace sees none of another workspace’s rows, in any store it may read', async () => {
    for (const w of [a, b]) {
      for (const { store } of stores.filter((s) => s.readable)) {
        expect((await rows(w.owner$, store, w.ws))?.others, `${store} seen from ${w.ws}`).toBe(0);
        expect((await rows(w.system$, store, w.ws))?.others, `${store} seen by the system from ${w.ws}`).toBe(0);
      }
    }
  });

  it('[S1] without a workspace in the session, every store reads as empty', async () => {
    const nobody = target().setWorkspace(null);
    for (const { store } of stores.filter((s) => s.readable)) {
      expect((await rows(nobody, store, null))?.total, store).toBe(0);
    }
  });

  it('[S1] a store the service may not read directly refuses it', async () => {
    const closed = stores.filter((s) => !s.readable);
    expect(closed.length).toBeGreaterThan(0);
    for (const w of [a, b]) {
      for (const { store } of closed) await refused(rows(w.owner$, store, w.ws), 'denied', store);
    }
  });

  it('[S1] such a store stays closed to people, the system, a run and an empty session', async () => {
    for (const { store } of stores.filter((s) => !s.readable)) {
      for (const session of [a.owner$, b.owner$, a.system$, a.agent$, target().setWorkspace(null)]) {
        await refused(rows(session, store, a.ws), 'denied', store);
      }
    }
  });

  it('[S1] cannot update or insert into another workspace', async () => {
    expect(await a.owner$.call('iso.task.retitle', { workspace: b.ws, title: 'hijacked' })).toBe(0);
    expect(await a.owner$.call('iso.task.retitle', { task: b.task, title: 'hijacked' })).toBe(0);
    const [task] = await b.owner$.observe<{ title: string }>('task', { id: b.task });
    expect(task?.title).not.toBe('hijacked');
    await refused(a.owner$.call('task.create', { workspace: b.ws, requestedBy: b.owner }), 'denied', 'task');
    await refused(a.owner$.call('iso.message.post', { workspace: b.ws, task: b.task, author: a.owner, content: 'x' }), 'denied', 'message');
    await refused(a.owner$.call('iso.document.create', { workspace: b.ws, content: 'x', by: a.owner }), 'denied', 'document');
    await refused(a.owner$.call('memory.write', { workspace: b.ws, owner: a.owner, agent: a.agent, content: 'x' }), 'denied', 'memory');
    expect(await b.owner$.observe('memory')).toHaveLength(1);
  });

  it('[S1] a reference cannot cross workspaces, even when the row is written in the right workspace', async () => {
    // The system principal files tasks for others; only the reference stands between it and another workspace's person.
    await refused(a.system$.call('task.create', { requestedBy: a.owner, onBehalfOf: b.owner }), 'not_found');
  });

  it('[S1] crossings cannot reach another workspace’s rows', async () => {
    await refused(a.owner$.call('mandate.revoke', { mandate: b.mandate }), 'not_found');
    expect((await b.owner$.observe<{ revoked: boolean }>('mandate', { id: b.mandate }))[0]?.revoked).toBe(false);
    await refused(a.worker$.call('run.claim', { run: b.run, worker: 'thief', leaseMs: 1000 }), 'not_found');
    const [open] = await b.owner$.observe<{ id: string }>('decision', { status: 'open' });
    if (!open) throw new Error('the fixture has no open decision in the other workspace');
    await refused(a.owner$.call('decision.answer', { decision: open.id, proposalHash: 'x', verdict: 'approved', note: null }), 'not_open');
    const [done] = (await b.owner$.observe<{ id: string; status: string }>('effect')).filter((e) => e.status === 'succeeded');
    if (!done) throw new Error('the fixture has no succeeded effect in the other workspace');
    await refused(a.owner$.call('effect.propose_undo', { effect: done.id, idempotencyKey: 'idem-cross-undo' }), 'not_found');
    expect((await b.owner$.observe<{ status: string }>('decision', { id: open.id }))[0]?.status).toBe('open');
  });

  it('[S1] a principal of one workspace cannot act in another by naming it', async () => {
    await refused(target().setWorkspace(b.ws).asPrincipal(a.owner).call('agent.create', { name: 'Spy' }), 'no_identity');
  });

  it('[S1] a run of one workspace, even with its secret, gives no identity in another', async () => {
    const elsewhere = target().setWorkspace(b.ws).asRun(a.run, a.secret);
    await refused(elsewhere.call('agent.create', { name: 'Spy' }), 'no_identity');
    expect(await elsewhere.observe('memory')).toEqual([]);
  });
});
