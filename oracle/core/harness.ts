import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'vitest';
import { openTarget } from '../adapters/index.ts';
import { type BindingUse, type Id, type Reason, Refusal, type Session, type Target } from '../target.ts';

/**
 * Open one fresh installation of the selected target for this file, and record which kinds of
 * binding each case used (results/usage), so the black-box share is measured, not claimed.
 */
export function useTarget(file: string): () => Target {
  let target: Target | undefined;
  const usage: Record<string, BindingUse[]> = {};
  let setup: BindingUse[] = [];
  beforeAll(async () => {
    target = await openTarget();
  });
  // What hooks used before a case (shared fixtures) is charged to every later case of the file.
  beforeEach(() => {
    if (target) setup = [...setup, ...target.drainUsage()];
  });
  afterEach((context) => {
    if (!target) return;
    const names: string[] = [];
    for (let t: { name: string; suite?: unknown } | undefined = context.task; t; t = t.suite as typeof t) {
      if (t.name) names.unshift(t.name);
    }
    // Keyed as the report names cases: the file relative to core/ (or to the oracle), then the titles.
    const filepath = (context.task as { file?: { filepath?: string } }).file?.filepath ?? '';
    const core = fileURLToPath(new URL('./', import.meta.url));
    const base = filepath.startsWith(core) ? relative(core, filepath) : relative(fileURLToPath(new URL('../', import.meta.url)), filepath);
    usage[[base, ...names].join(' > ')] = [...setup, ...target.drainUsage()];
  });
  afterAll(async () => {
    await mkdir(new URL('../results/usage/', import.meta.url), { recursive: true });
    await writeFile(
      new URL(`../results/usage/${process.env.ORACLE_TARGET ?? 'legacy'}.${file}.json`, import.meta.url),
      JSON.stringify(usage, null, 2),
    );
    await target?.close();
  });
  return () => {
    if (!target) throw new Error('the target is not open yet');
    return target;
  };
}

/** Expect a refusal, optionally for one of the oracle's reasons. */
export async function refused(promise: Promise<unknown>, reason?: Reason | Reason[], label?: string): Promise<Refusal> {
  const outcome = await promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  if (outcome.ok) throw new Error(`${label ?? 'the crossing'} was expected to refuse but returned ${JSON.stringify(outcome.value)}`);
  if (!(outcome.error instanceof Refusal)) throw outcome.error;
  if (reason !== undefined) {
    const allowed = Array.isArray(reason) ? reason : [reason];
    expect(allowed, `${label ?? ''} refused for ${outcome.error.reason}: ${outcome.error.detail}`).toContain(outcome.error.reason);
  }
  return outcome.error;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const inAnHour = () => new Date(Date.now() + 3_600_000);

export interface RunHandle {
  task: Id;
  run: Id;
  fence: number;
  secret: string;
  /** The session acting as this run (it holds the run's secret). */
  $: Session;
}

/** A workspace with an owner, the owner's worker, a verifier, a root mandate and a claimed run. */
export interface World extends RunHandle {
  t: Target;
  ws: Id;
  owner: Id;
  system: Id;
  agent: Id;
  verifier: Id;
  mandate: Id;
  owner$: Session;
  agent$: Session;
  verifier$: Session;
  system$: Session;
  /** A worker process: names the workspace and nothing else. */
  worker$: Session;
}

export interface WorldOptions {
  kind?: 'personal' | 'team' | 'company';
  ceiling?: number;
  windowMs?: number;
  maxEffects?: number | null;
  maxTokens?: number | null;
  verifier?: boolean;
}

export async function newWorld(t: Target, name = 'Acme', options: WorldOptions = {}): Promise<World> {
  const made = await t.operator.createWorkspace({
    name,
    kind: options.kind ?? 'team',
    ownerName: `${name} Owner`,
    ownerEmail: 'owner@example.com',
  });
  const ws = made.workspace;
  const at = t.setWorkspace(ws);
  const owner$ = at.asPrincipal(made.owner);
  await owner$.call('workspace.set_delay_window', { ms: options.windowMs ?? 0 });
  const agent = await owner$.call<Id>('agent.create', { name: 'Worker' });
  const verifier = options.verifier === false ? '' : await owner$.call<Id>('agent.create', { name: 'Verifier', role: 'verifier' });
  const mandate = await issue(owner$, agent, {
    ceiling: options.ceiling ?? 4,
    maxEffects: options.maxEffects ?? null,
    maxTokens: options.maxTokens ?? null,
  });
  const run = await startRun(t, ws, owner$, made.owner, mandate, agent);
  return {
    t,
    ws,
    owner: made.owner,
    system: made.system,
    agent,
    verifier,
    mandate,
    ...run,
    owner$,
    agent$: run.$,
    verifier$: at.asPrincipal(verifier),
    system$: at.asPrincipal(made.system),
    worker$: at,
  };
}

export interface MandateTerms {
  parent?: Id | null;
  ceiling?: number | null;
  maxTokens?: number | null;
  maxEffects?: number | null;
  tools?: unknown;
  connections?: unknown;
  operations?: unknown;
  expiresAt?: Date | null;
}

export function issue(issuer$: Session, subject: Id, terms: MandateTerms = {}): Promise<Id> {
  return issuer$.call<Id>('mandate.issue', { subject, ...terms });
}

export async function queueRun(person$: Session, person: Id, mandate: Id, agent: Id): Promise<{ task: Id; run: Id }> {
  const task = await person$.call<Id>('task.create', { requestedBy: person });
  const run = await person$.call<Id>('run.queue', { task, agent, mandate });
  return { task, run };
}

export async function claim(t: Target, ws: Id, run: Id, worker = 'worker-1', leaseMs = 60_000) {
  const claimed = await t.setWorkspace(ws).call<{ fence: number; secret: string } | null>('run.claim', { run, worker, leaseMs });
  if (!claimed) throw new Refusal('not_claimable', 'claim returned no row', 'run.claim');
  return { ...claimed, $: t.setWorkspace(ws).asRun(run, claimed.secret) };
}

export async function startRun(t: Target, ws: Id, person$: Session, person: Id, mandate: Id, agent: Id): Promise<RunHandle> {
  const { task, run } = await queueRun(person$, person, mandate, agent);
  return { task, run, ...(await claim(t, ws, run)) };
}

/** A further claimed run in `w` under `mandate`, requested by the owner. */
export const runIn = (w: World, mandate: Id = w.mandate, agent: Id = w.agent) => startRun(w.t, w.ws, w.owner$, w.owner, mandate, agent);

export interface ProposeOptions {
  operation?: string;
  classHint?: number | null;
  externalHint?: boolean | null;
  key?: string;
  args?: unknown;
  description?: string;
  step?: number;
  connection?: string | null;
  tool?: string;
  run?: Pick<RunHandle, 'run' | 'fence' | '$'>;
  fence?: number;
}

export function proposalArgs(w: World, o: ProposeOptions = {}) {
  const run = o.run ?? w;
  return {
    session: run.$,
    args: {
      run: run.run,
      fence: o.fence ?? run.fence,
      step: o.step ?? 1,
      tool: o.tool,
      operation: o.operation ?? 'crm:update_deal',
      connection: o.connection,
      classHint: o.classHint ?? null,
      externalHint: o.externalHint ?? null,
      args: o.args === undefined ? { field: 'stage', value: 'won' } : o.args,
      description: o.description ?? 'Set the deal stage to won',
      idempotencyKey: o.key ?? `idem-${randomUUID()}`,
    },
  };
}

export function propose(w: World, o: ProposeOptions = {}): Promise<Id> {
  const { session, args } = proposalArgs(w, o);
  return session.call<Id>('effect.propose', args);
}

export interface EffectView {
  id: Id;
  status: string;
  effectClass: number;
  external: boolean;
  decision: Id | null;
  route: string | null;
  routeReason: string | null;
  argsHash: string;
  undoOf: Id | null;
}

export async function effect(w: Pick<World, 'owner$'>, id: Id): Promise<EffectView> {
  const [row] = await w.owner$.observe<EffectView>('effect', { id });
  if (!row) throw new Error(`effect ${id} is not visible to the owner`);
  return row;
}

export interface DecisionView {
  id: Id;
  subjectKind: string;
  subject: Id;
  proposer: Id;
  checkerKind: string;
  checker: Id | null;
  proposalHash: string;
  reason: string | null;
  status: string;
  escalationNote: string | null;
}

export async function decision(w: Pick<World, 'owner$'>, id: Id): Promise<DecisionView> {
  const [row] = await w.owner$.observe<DecisionView>('decision', { id });
  if (!row) throw new Error(`decision ${id} is not visible to the owner`);
  return row;
}

export async function decisionOf(w: Pick<World, 'owner$'>, effectId: Id): Promise<Id> {
  const e = await effect(w, effectId);
  if (!e.decision) throw new Error(`effect ${effectId} has no decision`);
  return e.decision;
}

/** Answer a decision, binding the answer to the exact proposal it was shown. */
export async function answer(session: Session, w: Pick<World, 'owner$'>, id: Id, verdict: 'approved' | 'rejected' = 'approved') {
  const { proposalHash } = await decision(w, id);
  return session.call('decision.answer', { decision: id, proposalHash, verdict });
}

/** A verifier's answer, with whatever proof the target requires of it. */
export function verifierAnswer(
  verifier$: Session,
  w: Pick<World, 'owner' | 'system'>,
  id: Id,
  verdict: 'approved' | 'rejected' = 'approved',
  reason = 'checked',
) {
  return verifier$.call('verifier.answer', { decision: id, verdict, reason, owner: w.owner, system: w.system });
}

/** Claim, begin and observe an effect as the workspace's system principal. */
export async function dispatch(w: Pick<World, 'system$'>, id: Id, outcome = 'succeeded', externalRef = 'crm://deal/42') {
  const claimToken = await w.system$.call<string>('effect.claim', { effect: id, leaseMs: 30_000 });
  const dispatched = await w.system$.call<boolean>('effect.begin_dispatch', { effect: id, claim: claimToken });
  if (dispatched) await w.system$.call('effect.observe', { effect: id, claim: claimToken, outcome, externalRef });
  return { claim: claimToken, dispatched };
}

export async function addPerson(w: Pick<World, 'owner$' | 't' | 'ws'>, name: string, role: 'owner' | 'admin' | 'member' | 'guest' = 'member') {
  const id = await w.owner$.call<Id>('person.add', { name, role });
  return { id, $: w.t.setWorkspace(w.ws).asPrincipal(id) };
}

/** What a source contained, recorded by the system principal. `authoredBy` null means external. */
export function recordSource(
  w: Pick<World, 'system$'>,
  content: string,
  authoredBy: Id | null = null,
  options: { run?: Id; task?: Id; ref?: string } = {},
): Promise<Id> {
  return w.system$.call<Id>('source.record', { content, authoredBy, ...options });
}

/** Have `run` read an outside source (untrusted) and the owner's words in its task (private). */
export async function readUntrustedAndPrivate(
  w: World,
  run: Pick<RunHandle, 'run' | 'task'>,
  which: { untrusted?: boolean; sensitive?: boolean } = { untrusted: true, sensitive: true },
) {
  if (which.untrusted !== false) {
    await recordSource(w, `An email from outside ${randomUUID()}`, null, { run: run.run, ref: 'mail://inbox/1' });
  }
  if (which.sensitive !== false) {
    await recordSource(w, `Salaries ${randomUUID()}`, w.owner, { run: run.run, task: run.task, ref: 'drive://salaries.xlsx' });
  }
}

export function proposeCandidate(proposer$: Session, proposer: Id, statement: string, evidence: { episode: Id; excerpt: string }[], topic?: string): Promise<Id> {
  return proposer$.call<Id>('knowledge.propose_candidate', { statement, evidence, proposedBy: proposer, topic });
}

export async function candidateWithEvidence(w: World, content: string, excerpt: string, authoredBy?: Id) {
  const episode = await recordSource(w, content, authoredBy ?? null);
  const candidate = await proposeCandidate(w.agent$, w.agent, `Statement about: ${content}`, [{ episode, excerpt }]);
  return { episode, candidate };
}

export function requestPromotion(w: World, candidate: Id, by: Session = w.agent$, owner: Id = w.owner): Promise<Id> {
  return by.call<Id>('knowledge.request_promotion', { candidate, owner });
}

export function classify(session: Session, changes: { operation: string; class: number; external: boolean; description?: string }[]) {
  return session.call<{ change: Id; decision: Id | null }>('operations.classify', { changes });
}
