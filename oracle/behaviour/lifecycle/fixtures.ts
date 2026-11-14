import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { dispatch, effect, newWorld, propose, refused } from '../../core/harness.ts';
import type { Id, Target } from '../../target.ts';
import { type Ids, sessionsIn } from './harness.ts';

/** Work under way in a workspace, in every state a lifecycle step must keep from being done twice. */
export interface HeldWork extends Ids {
  name: string;
  task: Id;
  run: Id;
  mandate: Id;
  /** Dispatched, its outcome unknown: the outside may or may not have it. */
  unknown: Id;
  /** Its sending had begun (dispatching) when the instance stopped: a lost acknowledgement. */
  inFlight: Id;
  /** Allowed and queued, never sent. */
  waiting: Id;
  /** A change inside the workspace (a message posted in the task) whose sending had begun. */
  internalInFlight: Id;
  routine: Id;
}

/**
 * A workspace (the operator's, SG-CORE-01) whose worker holds a running run and three outward
 * changes to a CRM deal: one whose outcome came back unknown, one whose sending began and never
 * returned, and one allowed and waiting; and an active weekly routine. All through crossings.
 */
export async function heldWork(t: Target, label: string): Promise<HeldWork> {
  const name = `${label} ${randomUUID().slice(0, 6)}`;
  const w = await newWorld(t, name, { kind: 'team', verifier: false });
  const unknown = await propose(w, { step: 1, args: { deal: 'D-1', stage: 'won' } });
  await dispatch(w, unknown, 'unknown', '');
  const inFlight = await propose(w, { step: 2, args: { deal: 'D-2', stage: 'won' } });
  const claim = await w.system$.call<string>('effect.claim', { effect: inFlight, leaseMs: 600_000 });
  expect(await w.system$.call('effect.begin_dispatch', { effect: inFlight, claim })).toBe(true);
  const waiting = await propose(w, { step: 3, args: { deal: 'D-3', stage: 'won' } });
  const internalInFlight = await propose(w, {
    step: 4,
    tool: 'workspace',
    operation: 'workspace.post_message',
    args: { taskId: w.task, content: 'The deals are updated' },
  });
  const internalClaim = await w.system$.call<string>('effect.claim', {
    effect: internalInFlight,
    leaseMs: 600_000,
  });
  expect(
    await w.system$.call('effect.begin_dispatch', { effect: internalInFlight, claim: internalClaim }),
  ).toBe(true);
  const routine = await w.owner$.call<Id>('lif.routine.create', { agent: w.agent });
  const held: HeldWork = {
    name,
    ws: w.ws,
    owner: w.owner,
    system: w.system,
    agent: w.agent,
    task: w.task,
    run: w.run,
    mandate: w.mandate,
    unknown,
    inFlight,
    waiting,
    internalInFlight,
    routine,
  };
  // The fixture is what it says: the deal changes are outward, the message is not, each in its state.
  expect(await states(t, held)).toEqual(HELD_AT_SOURCE);
  for (const id of [unknown, inFlight, waiting]) expect((await effect(w, id)).external).toBe(true);
  expect((await effect(w, internalInFlight)).external).toBe(false);
  return held;
}

/** The held work's states where it was made. */
export const HELD_AT_SOURCE = {
  unknown: 'unknown',
  inFlight: 'dispatching',
  waiting: 'allowed',
  internalInFlight: 'dispatching',
  run: 'running',
  routine: 'active',
} as const;

/** The states of the held work, as the workspace's owner reads them. */
export async function states(t: Target, h: HeldWork) {
  const { owner$ } = sessionsIn(t, h);
  const status = async (id: Id) => (await effect({ owner$ }, id)).status;
  const [run] = await owner$.observe<{ status: string }>('run', { id: h.run });
  const [routine] = await owner$.observe<{ status: string }>('lif.routine', { id: h.routine });
  return {
    unknown: await status(h.unknown),
    inFlight: await status(h.inFlight),
    waiting: await status(h.waiting),
    internalInFlight: await status(h.internalInFlight),
    run: run?.status,
    routine: routine?.status,
  };
}

/** A change whose sending had begun is still in doubt: never taken for done, never back in the queue to send. */
export const IN_DOUBT = ['dispatching', 'unknown'];

/**
 * Nothing of the held work can be sent again from this instance: no change of it can be claimed by
 * the workspace's dispatcher, and the cross-workspace queue hands out none of it to send — only, at
 * most, a change in doubt for inspection (stale), which cannot be dispatched again.
 */
export async function nothingSendable(t: Target, h: HeldWork) {
  const { system$, nobody$ } = sessionsIn(t, h);
  for (const id of [h.unknown, h.inFlight, h.waiting, h.internalInFlight]) {
    await refused(
      system$.call('effect.claim', { effect: id, leaseMs: 30_000 }),
      'not_claimable',
      `claiming ${id}`,
    );
  }
  for (let i = 0; i < 4; i++) {
    const next = await nobody$.call<{ effect: Id; claim: string; stale: boolean } | null>(
      'effect.claim_next',
      {
        worker: 'oracle-dispatcher',
        leaseMs: 30_000,
      },
    );
    if (next === null) return;
    expect(next, 'the queue handed out held work to send').toMatchObject({ stale: true });
    expect([h.inFlight, h.internalInFlight]).toContain(next.effect);
    await refused(
      system$.call('effect.begin_dispatch', { effect: next.effect, claim: next.claim }),
      undefined,
      'dispatching it again',
    );
  }
  throw new Error('the queue keeps handing out work');
}
