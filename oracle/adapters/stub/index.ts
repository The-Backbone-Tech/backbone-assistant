import { createHash, randomUUID } from 'node:crypto';
import {
  type Actor,
  type BindingUse,
  type Id,
  Refusal,
  type RaceItem,
  type Reason,
  type Session,
  type Settled,
  type Target,
} from '../../target.ts';

/**
 * A deliberately small in-memory target for the lessons register. With no flaw it keeps each
 * lesson's promise, so a lesson case passes on it; with one flaw switched on it makes exactly the
 * naive mistake the lesson records, so the case must fail. That pair is the "failing first" proof:
 * the case fails because of the flaw, not because the stub is incomplete.
 */
export type Flaw =
  /** Duplicates are detected by idempotency key only, not by what the change means. */
  | 'L7-key-only-dedupe'
  /** Authority is checked when an effect is proposed, never again before it is sent. */
  | 'L8-no-recheck-before-send'
  /** An unknown outcome is just a status: no one answers for it and it has no deadline. */
  | 'L9-ownerless-unknown'
  /** A store added later has no tenant wall. */
  | 'L10-unwalled-store';

interface Mandate {
  id: Id;
  ws: Id;
  subject: Id;
  onBehalfOf: Id;
  parent: Id | null;
  ceiling: number;
  expiresAt: number;
  revoked: boolean;
}
interface Run {
  id: Id;
  ws: Id;
  task: Id;
  agent: Id;
  mandate: Id;
  fence: number;
  secret: string | null;
}
interface Effect {
  id: Id;
  ws: Id;
  run: Id;
  mandate: Id;
  operation: string;
  connection: string | null;
  args: unknown;
  expectedVersion: string | null;
  key: string;
  effectClass: number;
  status: string;
  claim: string | null;
  person: Id;
  unknownSince: number | null;
}

const refuse = (reason: Reason, detail: string, crossing: string) => new Refusal(reason, detail, crossing);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function openStub(flaw: Flaw | null = null): Target {
  const principals = new Map<Id, { ws: Id; kind: 'person' | 'system' | 'agent'; role: string }>();
  const workspaces = new Set<Id>();
  const mandates = new Map<Id, Mandate>();
  const tasks = new Map<Id, { ws: Id; person: Id }>();
  const runs = new Map<Id, Run>();
  const effects = new Map<Id, Effect>();
  let usage: BindingUse[] = [];

  const alive = (m: Mandate | undefined): boolean => {
    if (!m || m.revoked || m.expiresAt <= Date.now()) return false;
    return m.parent === null || alive(mandates.get(m.parent));
  };
  /** Who the session acts as: a person or system principal, or the agent of the run whose secret it holds. */
  const caller = (actor: Actor, crossing: string) => {
    if (actor.run) {
      const run = runs.get(actor.run.id);
      if (!run || run.ws !== actor.workspace || run.secret !== actor.run.secret || !alive(mandates.get(run.mandate))) {
        throw refuse('not_in_run', 'not inside a live run', crossing);
      }
      return { id: run.agent, run };
    }
    const p = actor.principal ? principals.get(actor.principal) : undefined;
    if (!p || p.ws !== actor.workspace) throw refuse('no_identity', 'no active principal', crossing);
    return { id: actor.principal as Id, run: undefined };
  };

  const crossings: Record<string, (actor: Actor, a: Record<string, unknown>) => unknown> = {
    'workspace.set_delay_window': () => null,
    'agent.create': (actor, a) => {
      const me = caller(actor, 'agent.create');
      const id = randomUUID();
      principals.set(id, { ws: actor.workspace as Id, kind: 'agent', role: String(a.role ?? 'worker') });
      void me;
      return id;
    },
    'mandate.issue': (actor, a) => {
      const me = caller(actor, 'mandate.issue');
      const parent = a.parent ? mandates.get(String(a.parent)) : undefined;
      if (a.parent && !alive(parent)) throw refuse('revoked', 'parent revoked or expired', 'mandate.issue');
      const id = randomUUID();
      const expiresAt = a.expiresAt instanceof Date ? a.expiresAt.getTime() : Date.now() + 3_600_000;
      mandates.set(id, {
        id,
        ws: actor.workspace as Id,
        subject: String(a.subject),
        onBehalfOf: parent?.onBehalfOf ?? me.id,
        parent: parent?.id ?? null,
        ceiling: Math.min(Number(a.ceiling ?? 4), parent?.ceiling ?? 4),
        expiresAt: Math.min(expiresAt, parent?.expiresAt ?? Number.POSITIVE_INFINITY),
        revoked: false,
      });
      return id;
    },
    'mandate.revoke': (_actor, a) => {
      let n = 0;
      const revoke = (id: Id) => {
        const m = mandates.get(id);
        if (!m || m.revoked) return;
        m.revoked = true;
        n += 1;
        for (const child of mandates.values()) if (child.parent === id) revoke(child.id);
      };
      revoke(String(a.mandate));
      return n;
    },
    'task.create': (actor, a) => {
      const id = randomUUID();
      tasks.set(id, { ws: actor.workspace as Id, person: String(a.onBehalfOf ?? a.requestedBy) });
      return id;
    },
    'run.queue': (actor, a) => {
      const id = randomUUID();
      runs.set(id, { id, ws: actor.workspace as Id, task: String(a.task), agent: String(a.agent), mandate: String(a.mandate), fence: 0, secret: null });
      return id;
    },
    'run.claim': (actor, a) => {
      const run = runs.get(String(a.run));
      if (!run || run.ws !== actor.workspace) throw refuse('not_found', 'run not found', 'run.claim');
      if (actor.principal || actor.run) throw refuse('workers_only', 'claimed by workers', 'run.claim');
      if (!alive(mandates.get(run.mandate))) return null;
      run.fence += 1;
      run.secret = randomUUID();
      return { fence: run.fence, secret: run.secret };
    },
    'eff.connection.register': () => randomUUID(),
    'eff.connection.record_tools': () => null,
    'effect.propose': (actor, a) => propose(actor, a, 'effect.propose'),
    'eff.propose_connected': (actor, a) => propose(actor, a, 'eff.propose_connected'),
    'effect.claim': (actor, a) => {
      const e = effects.get(String(a.effect));
      if (!e || e.ws !== actor.workspace) throw refuse('not_found', 'effect not found', 'effect.claim');
      if (principals.get(actor.principal ?? '')?.kind !== 'system') throw refuse('system_dispatches', 'system principal', 'effect.claim');
      if (e.status !== 'allowed') throw refuse('not_claimable', `effect is ${e.status}`, 'effect.claim');
      e.claim = randomUUID();
      return e.claim;
    },
    'effect.begin_dispatch': (_actor, a) => {
      const e = effects.get(String(a.effect));
      if (!e || e.claim !== a.claim || e.status !== 'allowed') throw refuse('stale', 'stale claim', 'effect.begin_dispatch');
      if (flaw !== 'L8-no-recheck-before-send' && !alive(mandates.get(e.mandate))) {
        e.status = 'cancelled';
        return false;
      }
      e.status = 'dispatching';
      return true;
    },
    'effect.observe': (_actor, a) => {
      const e = effects.get(String(a.effect));
      if (!e || e.claim !== a.claim || e.status !== 'dispatching') throw refuse('stale', 'stale claim', 'effect.observe');
      e.status = String(a.outcome);
      if (e.status === 'unknown') e.unknownSince = Date.now();
      return null;
    },
  };

  function propose(actor: Actor, a: Record<string, unknown>, crossing: string): Id {
    const me = caller(actor, crossing);
    if (!me.run || me.run.id !== a.run) throw refuse('not_in_run', 'effects are proposed from inside their run', crossing);
    if (me.run.fence !== a.fence) throw refuse('stale', 'stale fence', crossing);
    const key = String(a.idempotencyKey);
    const same = [...effects.values()].find((e) => e.ws === actor.workspace && e.key === key);
    if (same) {
      if (digest([same.operation, same.args]) !== digest([a.operation, a.args])) throw refuse('reused_key', 'key reused', crossing);
      return same.id;
    }
    const meaning = digest([a.connection ?? null, a.operation, a.args, a.expectedVersion ?? null]);
    const unknownCopy =
      flaw === 'L7-key-only-dedupe'
        ? undefined
        : [...effects.values()].find(
            (e) =>
              e.ws === actor.workspace &&
              e.status === 'unknown' &&
              digest([e.connection, e.operation, e.args, e.expectedVersion]) === meaning,
          );
    const id = randomUUID();
    const task = tasks.get(me.run.task);
    effects.set(id, {
      id,
      ws: actor.workspace as Id,
      run: me.run.id,
      mandate: me.run.mandate,
      operation: String(a.operation),
      connection: (a.connection as string | null | undefined) ?? null,
      args: a.args,
      expectedVersion: (a.expectedVersion as string | null | undefined) ?? null,
      key,
      effectClass: 3,
      status: unknownCopy ? 'denied' : 'allowed',
      claim: null,
      person: task?.person ?? '',
      unknownSince: null,
    });
    return id;
  }

  const views: Record<string, (actor: Actor, a: Record<string, unknown>) => unknown[]> = {
    effect: (actor, a) =>
      [...effects.values()]
        .filter((e) => e.ws === actor.workspace && (a.id === undefined || e.id === a.id))
        .map((e) => ({ id: e.id, status: e.status, effectClass: e.effectClass, external: true, decision: null, route: e.status, routeReason: null })),
    'lesson.unknowns': (actor) =>
      [...effects.values()]
        .filter((e) => e.ws === actor.workspace && e.status === 'unknown')
        .map((e) =>
          flaw === 'L9-ownerless-unknown'
            ? { effect: e.id, resolver: null, evidence: null, deadline: null }
            : { effect: e.id, resolver: e.person, evidence: `receipt:${e.id}`, deadline: new Date((e.unknownSince ?? 0) + 86_400_000) },
        ),
    'catalog.stores': () => [
      ...['workspaces', 'principals', 'mandates', 'tasks', 'runs', 'effects'].map((store) => ({ store, readable: true, forced: true, wall: 'exact' })),
      ...(flaw === 'L10-unwalled-store' ? [{ store: 'later_notes', readable: true, forced: false, wall: 'missing' }] : []),
    ],
  };

  const session = (actor: Actor): Session => {
    const run = <T>(table: Record<string, (actor: Actor, a: Record<string, unknown>) => unknown>, name: string, args: Record<string, unknown>) => {
      const f = table[name];
      if (!f) return Promise.reject(new Error(`the stub has no ${table === views ? 'view' : 'crossing'} named ${name}`));
      usage.push({ name, kind: table === views ? 'view' : 'crossing' });
      try {
        return Promise.resolve(f(actor, args) as T);
      } catch (error) {
        return Promise.reject(error);
      }
    };
    return {
      actor,
      asPrincipal: (principal) => session({ workspace: actor.workspace, principal }),
      asRun: (id, secret) => session({ ...actor, run: { id, secret } }),
      call: (name, args = {}) => run(crossings, name, args),
      observe: (name, args = {}) => run(views, name, args) as never,
      hold: (name, args = {}) => {
        const result = run(crossings, name, args);
        return { result: result as never, release: () => {}, committed: result.then(() => {}) };
      },
    };
  };

  return {
    name: flaw ? `stub (${flaw})` : 'stub',
    setWorkspace: (workspace) => session(workspace ? { workspace } : {}),
    operator: {
      async createWorkspace() {
        const workspace = randomUUID();
        const owner = randomUUID();
        const system = randomUUID();
        workspaces.add(workspace);
        principals.set(owner, { ws: workspace, kind: 'person', role: 'owner' });
        principals.set(system, { ws: workspace, kind: 'system', role: 'system' });
        return { workspace, owner, system };
      },
    },
    adversary: {
      attack: (name) => Promise.reject(new Error(`the stub has no attack named ${name}`)),
    },
    race<T>(items: readonly RaceItem[]): Promise<Settled<T>[]> {
      return Promise.all(
        items.map((i) =>
          i.session.call<T>(i.crossing, i.args).then(
            (value): Settled<T> => ({ ok: true, value }),
            (refusal: Refusal): Settled<T> => ({ ok: false, refusal }),
          ),
        ),
      );
    },
    drainUsage() {
      const drained = usage;
      usage = [];
      return drained;
    },
    close: async () => {},
  };
}
