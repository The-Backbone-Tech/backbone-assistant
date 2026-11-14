import { randomUUID } from 'node:crypto';
import type { Id, Session, Target } from '../../target.ts';
import { claim, newWorld, type RunHandle, type World } from '../harness.ts';

/** A claimed run on a new task of the owner, stated private (the schema's default) for cases about private work. */
export async function privateRun(
  w: Pick<World, 't' | 'ws' | 'owner$' | 'owner' | 'mandate' | 'agent'>,
  mandate = w.mandate,
  agent = w.agent,
) {
  const task = await w.owner$.call<Id>('task.create', { requestedBy: w.owner, visibility: 'private' });
  const run = await w.owner$.call<Id>('run.queue', { task, agent, mandate });
  return { task, run, ...(await claim(w.t, w.ws, run, `private-${randomUUID().slice(0, 8)}`)) };
}

/** An effect as the owner sees it, with its lineage and authority. */
export interface EffectDetail {
  id: Id;
  status: string;
  operation: string;
  connection: string | null;
  proposer: Id;
  run: Id | null;
  mandate: Id | null;
  effectClass: number;
  external: boolean;
  route: string | null;
  routeReason: string | null;
  decision: Id | null;
  undoOf: Id | null;
  repeatOf: Id | null;
  expectedVersion: string | null;
  idempotencyKey: string;
}

export async function detail(w: Pick<World, 'owner$'>, id: Id): Promise<EffectDetail> {
  const [row] = await w.owner$.observe<EffectDetail>('eff.effect_detail', { id });
  if (!row) throw new Error(`effect ${id} is not visible to the owner`);
  return row;
}

// --- the dispatch queue (cross-workspace: only its own file's work is in it) -----------------------

export interface Taken {
  workspace: Id;
  effect: Id;
  claim: string;
  stale: boolean;
  system: Id;
}

/** What the next free dispatcher takes from the cross-workspace queue, from an empty session. */
export const takeNext = (t: Target, leaseMs = 30_000, worker = 'dispatcher-1') =>
  t.setWorkspace(null).call<Taken | null>('effect.claim_next', { worker, leaseMs });

export async function take(t: Target, leaseMs?: number): Promise<Taken> {
  const taken = await takeNext(t, leaseMs);
  if (!taken) throw new Error('the queue handed out nothing');
  return taken;
}

/** The dispatcher acts as the system principal the queue named. */
export const dispatcher = (t: Target, taken: Taken) =>
  t.setWorkspace(taken.workspace).asPrincipal(taken.system);

export const begin = (t: Target, taken: Taken) =>
  dispatcher(t, taken).call<boolean>('effect.begin_dispatch', { effect: taken.effect, claim: taken.claim });

// --- a registered connector and proposals of its changes ---------------------------------------------

export interface Connector {
  id: Id;
  slug: string;
}

const TOOLS = [
  { name: 'update_deal', title: 'Update a deal', input_schema: { type: 'object' } },
  { name: 'read_note', title: 'Read a note', input_schema: { type: 'object' } },
  { name: 'archive_deal', title: 'Archive a deal', input_schema: { type: 'object' } },
];

export async function connector(w: Pick<World, 'owner$' | 'system$'>): Promise<Connector> {
  const slug = `repeat_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const id = await w.owner$.call<Id>('eff.connection.register', { slug });
  await w.system$.call('eff.connection.record_tools', { connection: id, tools: TOOLS });
  return { id, slug };
}

/** A personal (or team) workspace with one registered connector. */
export async function connectedWorld(t: Target, kind: 'personal' | 'team' = 'personal') {
  const w = await newWorld(t, `Connector repeat ${randomUUID().slice(0, 8)}`, { kind, verifier: false });
  return { w, c: await connector(w) };
}

type Run = Pick<RunHandle, 'run' | 'fence' | '$'>;

export interface ConnectedOptions {
  step: number;
  key?: string;
  tool?: string;
  operation?: string;
  connection?: string;
  project?: string | null;
  args?: Record<string, unknown>;
  expectedVersion?: string | null;
  classHint?: number | null;
}

export function connectedArgs(run: Run, c: Connector, o: ConnectedOptions) {
  const operation = o.operation ?? `mcp.${c.slug}.update_deal`;
  return {
    run: run.run,
    fence: run.fence,
    step: o.step,
    tool: o.tool ?? `${c.slug}__${operation.split('.').slice(2).join('.')}`,
    operation,
    connection: o.connection ?? c.slug,
    project: o.project ?? null,
    classHint: o.classHint ?? null,
    args: o.args ?? { deal: 'D-42', stage: 'won' },
    expectedVersion: o.expectedVersion ?? null,
    idempotencyKey: o.key ?? `idem-${randomUUID()}`,
  };
}

export const proposeConnected = (run: Run, c: Connector, o: ConnectedOptions) =>
  run.$.call<Id>('eff.propose_connected', connectedArgs(run, c, o));

/** A further claimed run on an existing task (a second root of authority working the same task). */
export async function runOnTask(t: Target, ws: Id, person$: Session, task: Id, mandate: Id, agent: Id) {
  const run = await person$.call<Id>('run.queue', { task, agent, mandate });
  return { task, run, ...(await claim(t, ws, run, `repeat-${randomUUID().slice(0, 8)}`)) };
}
