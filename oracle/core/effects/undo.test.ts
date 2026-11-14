import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Id, Session } from '../../target.ts';
import {
  addPerson,
  answer,
  classify,
  decisionOf,
  dispatch,
  effect,
  newWorld,
  propose,
  refused,
  useTarget,
  type World,
} from '../harness.ts';
import { detail, privateRun } from './fixtures.ts';

const target = useTarget('effects.undo');

const proposeUndo = (
  session: Session,
  of: Id,
  key = `idem-undo-${randomUUID()}`,
  args: Record<string, unknown> = { of },
) =>
  session.call<Id>('effect.propose_undo', {
    effect: of,
    args,
    description: 'Put it back as it was',
    idempotencyKey: key,
  });

/** Dispatch an effect as the system principal, running `write` while the effect is being dispatched. */
async function dispatchWith(w: World, id: Id, write: () => Promise<unknown>) {
  const claim = await w.system$.call<string>('effect.claim', { effect: id, leaseMs: 30_000 });
  expect(await w.system$.call('effect.begin_dispatch', { effect: id, claim })).toBe(true);
  await write();
  await w.system$.call('effect.observe', {
    effect: id,
    claim,
    outcome: 'succeeded',
    externalRef: null,
    observationHash: 'obs',
  });
}

const writeDocument = (w: World, document: Id, content: string, via: Id) =>
  w.system$.call('eff.document.write', { document, content, via });

/** Undo effects that name `of`, as the owner sees them. */
const undosOf = (w: World, of: Id) =>
  w.owner$.observe<{ id: Id; status: string }>('eff.effect_detail', { undoOf: of });

describe('undo: a person reverses a completed effect through the gateway', () => {
  it('[S8] the agent’s change to a document is undone by the person it was for, and the dispatcher restores it', async () => {
    const w = await newWorld(target(), 'Undo');
    const doc = await w.owner$.call<Id>('eff.document.create', { title: 'Plan', content: 'Launch in May.' });
    const change = await propose(w, {
      operation: 'workspace.write_document',
      args: { document_id: doc, content: 'Launch in June.' },
    });
    expect(await effect(w, change)).toMatchObject({ effectClass: 2, external: false, status: 'allowed' });
    await dispatchWith(w, change, () => writeDocument(w, doc, 'Launch in June.', change));

    const undo = await proposeUndo(w.owner$, change, undefined, { document_id: doc, restore_version: 1 });
    expect(await detail(w, undo)).toMatchObject({
      operation: 'workspace.restore_document',
      undoOf: change,
      proposer: w.owner,
      run: null,
      mandate: null,
      effectClass: 2,
      status: 'allowed',
    });
    await dispatchWith(w, undo, () => writeDocument(w, doc, 'Launch in May.', undo));
    const [document] = await w.owner$.observe('eff.document', { id: doc });
    expect(document).toMatchObject({ content: 'Launch in May.', version: 3, viaEffect: undo });
    const receipts = (
      await w.owner$.observe<{ type: string; payload: Record<string, unknown> }>('ledger', { subject: undo })
    ).filter((e) => e.type === 'effect.observed');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.payload).toMatchObject({
      operation: 'workspace.restore_document',
      undo_of: change,
      outcome: 'succeeded',
    });
  });

  it('[S8] only a completed effect with a way back can be undone', async () => {
    const w = await newWorld(target(), 'UndoWhat');
    const pending = await propose(w, { operation: 'workspace.write_document', args: { document: 'd1' } });
    await refused(proposeUndo(w.owner$, pending), 'not_undoable');
    const crm = await propose(w);
    await dispatch(w, crm);
    await refused(proposeUndo(w.owner$, crm), 'not_undoable');
    await refused(proposeUndo(w.owner$, randomUUID()), 'not_found');
    expect(await undosOf(w, pending)).toEqual([]);
    expect(await undosOf(w, crm)).toEqual([]);
  });

  it('[S4] an undo is asked for by the person the effect was for, or an admin — never by a run or another member', async () => {
    const w = await newWorld(target(), 'UndoWho');
    const member = await addPerson(w, 'Member');
    const admin = await addPerson(w, 'Admin', 'admin');
    // The legacy fixture's task is private; a new document of the task is then the owner's alone until it is shared.
    const run = await privateRun(w);
    const change = await propose(w, {
      run,
      operation: 'workspace.write_document',
      args: { document_id: randomUUID(), title: 'D2', content: 'd2', task_id: run.task },
    });
    await dispatch(w, change);
    await refused(proposeUndo(member.$, change), 'not_found');
    await refused(proposeUndo(member.$, randomUUID()), 'not_found');
    for (const session of [run.$, w.t.setWorkspace(w.ws).asPrincipal(w.agent), w.system$]) {
      await refused(proposeUndo(session, change), 'role');
    }
    expect(await undosOf(w, change)).toEqual([]);
    // An admin undoes what they can see: here, once the task is shared.
    await w.owner$.call('eff.task.share', { task: run.task });
    const undo = await proposeUndo(admin.$, change);
    expect((await effect(w, undo)).status).toBe('allowed');
  });

  it('[O1] one undo at a time: the same key returns the same undo, and another is refused while one stands', async () => {
    const w = await newWorld(target(), 'UndoOnce');
    const change = await propose(w, { operation: 'workspace.write_document', args: { document: 'd3' } });
    await dispatch(w, change);
    const key = `idem-undo-${randomUUID()}`;
    const undo = await proposeUndo(w.owner$, change, key);
    expect(await proposeUndo(w.owner$, change, key)).toBe(undo);
    await refused(proposeUndo(w.owner$, change), 'conflict');
    const other = await propose(w, { operation: 'workspace.write_document', args: { document: 'd4' } });
    await dispatch(w, other);
    await refused(proposeUndo(w.owner$, other, key), 'reused_key');
    expect((await undosOf(w, change)).map((u) => u.id)).toEqual([undo]);
    expect(await undosOf(w, other)).toEqual([]);
    // Once the undo is cancelled, the effect may be undone again.
    await w.owner$.call('effect.cancel', { effect: undo, reason: 'not now' });
    expect((await effect(w, await proposeUndo(w.owner$, change))).status).toBe('allowed');
  });

  it('[S4] an undo above the person’s role goes to another owner or admin', async () => {
    const w = await newWorld(target(), 'UndoAboveRole');
    const second = await addPerson(w, 'Second admin', 'admin');
    await classify(w.owner$, [
      { operation: 'crm:close_deal', class: 3, external: true, undo: 'crm:reopen_deal' } as never,
      { operation: 'crm:reopen_deal', class: 5, external: true },
    ]);
    const close = await propose(w, { operation: 'crm:close_deal' });
    await dispatch(w, close);
    const undo = await proposeUndo(w.owner$, close);
    expect(await effect(w, undo)).toMatchObject({
      effectClass: 5,
      status: 'awaiting_checker',
      route: 'needs_checker',
      routeReason: 'above_role',
    });
    const decision = await decisionOf(w, undo);
    await refused(answer(w.owner$, w, decision), 'own_proposal');
    expect((await effect(w, undo)).status).toBe('awaiting_checker');
    await answer(second.$, w, decision);
    expect((await effect(w, undo)).status).toBe('allowed');
  });
});
