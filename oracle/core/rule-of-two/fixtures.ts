import { randomUUID } from 'node:crypto';
import type { Id, Session, Target } from '../../target.ts';
import {
  claim,
  dispatch,
  newWorld,
  propose,
  type RunHandle,
  type World,
  type WorldOptions,
} from '../harness.ts';

/**
 * Fixtures the rule-of-two cases share. Every task here is created private, as a person's new task
 * is: the private material the rule of two counts is a person's words in a private task.
 */

/** A new private task of `person`'s. */
export function newTask(
  person$: Session,
  person: Id,
  title = 'Find out where the rollout stands',
): Promise<Id> {
  return person$.call<Id>('task.create', { requestedBy: person, title, visibility: 'private' });
}

/** Queue a run of `agent` under `mandate` in an existing task, as the person in `person$`. */
export function queueIn(person$: Session, task: Id, agent: Id, mandate: Id): Promise<Id> {
  return person$.call<Id>('run.queue', { task, agent, mandate });
}

/** A claimed run in an existing task. */
export async function runInTask(
  w: Pick<World, 't' | 'ws'>,
  person$: Session,
  task: Id,
  agent: Id,
  mandate: Id,
): Promise<RunHandle> {
  const run = await queueIn(person$, task, agent, mandate);
  return { task, run, ...(await claim(w.t, w.ws, run)) };
}

/** A new private task of the owner's and a claimed run of the workspace's worker in it. */
export async function anotherRun(w: World, mandate: Id = w.mandate, agent: Id = w.agent): Promise<RunHandle> {
  return runInTask(w, w.owner$, await newTask(w.owner$, w.owner), agent, mandate);
}

/** A world whose run works in a private task of the owner's (the harness's own run is in a shared one). */
export async function privateWorld(t: Target, name: string, options: WorldOptions = {}): Promise<World> {
  const w = await newWorld(t, name, options);
  const run = await anotherRun(w);
  return { ...w, ...run, agent$: run.$ };
}

export interface Marks {
  untrusted: boolean;
  sensitive: boolean;
  untrustedSource: string | null;
  sensitiveSource: string | null;
}

/** A run's marks and why, as the workspace's system principal reads them. */
export async function marks(w: Pick<World, 'system$'>, run: Id): Promise<Marks> {
  const [row] = await w.system$.observe<{ taintedUntrusted: boolean; taintedSensitive: boolean }>('run', {
    id: run,
  });
  const [why] = await w.system$.observe<{ untrusted: string | null; sensitive: string | null }>(
    'r2.run.reasons',
    { run },
  );
  if (!row || !why) throw new Error(`run ${run} is not visible to the system`);
  return {
    untrusted: row.taintedUntrusted,
    sensitive: row.taintedSensitive,
    untrustedSource: why.untrusted,
    sensitiveSource: why.sensitive,
  };
}

/** Private material the run holds from beyond its own conversation, in plain words, or null. */
export async function elsewhere(w: Pick<World, 'system$'>, run: Id): Promise<string | null> {
  const [why] = await w.system$.observe<{ elsewhere: string | null }>('r2.run.reasons', { run });
  return why?.elsewhere ?? null;
}

export function writeDocument(
  person$: Session,
  task: Id | null,
  title: string,
  content: string,
): Promise<Id> {
  return person$.call<Id>('r2.document.write', { task, title, content });
}

/** What reading the current version of a document records for `run`. */
export function readDocument(w: Pick<World, 'system$'>, run: Id, document: Id): Promise<Id> {
  return w.system$.call<Id>('r2.source.read_document', { run, document });
}

export interface Carried {
  wordsUntrusted: boolean;
  wordsSensitive: boolean;
  imported: boolean;
}

/** What a document's words carry now. */
export async function carried(w: Pick<World, 'owner$'>, document: Id): Promise<Carried> {
  const [d] = await w.owner$.observe<Carried & Record<string, unknown>>('r2.document', { id: document });
  if (!d) throw new Error(`document ${document} is not visible to the owner`);
  return { wordsUntrusted: d.wordsUntrusted, wordsSensitive: d.wordsSensitive, imported: d.imported };
}

export async function documentOf(session: Session, document: Id) {
  const [d] = await session.observe<{
    title: string;
    content: string;
    version: number;
    task: Id | null;
    contentAuthor: Id;
    sensitive: boolean;
  }>('r2.document', { id: document });
  return d;
}

/** The worker's run writes a document through the gateway, as the dispatcher does. */
export async function agentWrites(
  w: World,
  run: Pick<RunHandle, 'run' | 'fence' | '$'>,
  step: number,
  document: Id,
  content: string,
  create: boolean,
  title = 'Vendor notes',
  task: Id | null = null,
): Promise<Id> {
  const id = await propose(w, {
    run,
    step,
    operation: 'workspace.write_document',
    args: { document_id: document, title, content, task_id: task },
    description: `Write “${title}”`,
  });
  const claimToken = await w.system$.call<string>('effect.claim', { effect: id, leaseMs: 30_000 });
  await w.system$.call('effect.begin_dispatch', { effect: id, claim: claimToken });
  await w.system$.call('r2.document.dispatch_write', { document, title, content, effect: id, create, task });
  await w.system$.call('effect.observe', {
    effect: id,
    claim: claimToken,
    outcome: 'succeeded',
    externalRef: null,
    observationHash: 'obs',
  });
  return id;
}

/** What the dispatcher records when a connected server answers a run's call. */
export function serverAnswer(
  w: Pick<World, 'system$'>,
  run: Id,
  connection: Id,
  slug: string,
  content: string,
): Promise<Id> {
  return w.system$.call<Id>('r2.source.server_answer', { run, connection, slug, content });
}

export function connect(
  person$: Session,
  name: string,
  slug: string,
  scope: 'workspace' | 'person',
): Promise<Id> {
  return person$.call<Id>('r2.connection.add', { name, slug, scope });
}

/** A task the owner starts by writing in it, private unless shared, and a queued run that answers them. */
export async function conversation(w: World, words: string, visibility: 'private' | 'workspace' = 'private') {
  const task = await newTask(w.owner$, w.owner, 'Ask');
  if (visibility === 'workspace') await w.owner$.call('r2.task.share', { task });
  await w.owner$.call('r2.conversation.say', { task, content: words });
  const run = await queueIn(w.owner$, task, w.agent, w.mandate);
  return { task, run };
}

/** What importing another agent's store records for `person`: a task private to them, and its document. */
export async function importFor(w: World, person: Id, title: string, content: string) {
  const task = await w.system$.call<Id>('r2.material.import', { person, documents: [{ title, content }] });
  const [d] = await w.owner$.observe<{ id: Id }>('r2.document', { task });
  if (!d) throw new Error('the imported document is not visible to its person');
  return { task, document: d.id };
}

/** Fire a routine by hand and claim the run. */
export async function fire(w: World, person$: Session, routine: Id): Promise<RunHandle & { routine: Id }> {
  const run = await person$.call<Id>('r2.routine.run_now', { routine });
  const [row] = await w.system$.observe<{ task: Id }>('run', { id: run });
  return { routine, task: row?.task ?? '', run, ...(await claim(w.t, w.ws, run)) };
}

/** Finish a run as itself. */
export const finish = (r: Pick<RunHandle, 'run' | 'fence' | '$'>) =>
  r.$.call('run.finish', { run: r.run, fence: r.fence, outcome: 'succeeded' });

/** A question about an effect or subject, as `session` reads it (or undefined). */
export async function asked(session: Session, subject: Id) {
  const [d] = await session.observe<{
    id: Id;
    checkerKind: string;
    checker: Id | null;
    reason: string;
    question: string;
    status: string;
    answeredBy: Id | null;
  }>('r2.decision.asked', { subject });
  return d;
}

export const uuid = () => randomUUID();
export { dispatch };
