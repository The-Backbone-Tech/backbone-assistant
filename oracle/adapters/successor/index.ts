import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { enter, reasonOf } from '../../../packages/core/src/db/session.ts';
import { type Actor, type BindingUse, Refusal, type RaceItem, type Session, type Settled, type Target } from '../../target.ts';
import { attacks } from './attacks.ts';
import type { Binding, Bindings, Client } from './binding.ts';
import { crossings } from './crossings.ts';
import { views } from './views.ts';

/** A database error is a refusal, in the oracle's words; anything else (a bug in a binding) stays itself. */
export function refusal(error: unknown, name: string): unknown {
  if (error instanceof Refusal) return error;
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    const e = error as { code: string; message: string };
    return new Refusal(reasonOf(e), e.message, name);
  }
  return error;
}

/**
 * The successor adapter: a fresh installation of packages/core, cloned from the baselined
 * template, reached as the service role backbone_app. The operator port connects as
 * backbone_operator (no superuser, SG-CORE-01); only the adversary port uses the installer.
 */
export async function openSuccessor(): Promise<Target> {
  const urls = inject('successor');
  const database = `oracle_${randomBytes(6).toString('hex')}`;
  const at = (template: string) => template.replace('{db}', database);
  const bootstrap = new pg.Client({ connectionString: urls.admin.replace('{db}', 'postgres') });
  await bootstrap.connect();
  try {
    await bootstrap.query(`CREATE DATABASE ${database} TEMPLATE backbone_template`);
  } finally {
    await bootstrap.end();
  }
  const app = new pg.Pool({ connectionString: at(urls.app), max: 16 });
  const operator = new pg.Pool({ connectionString: at(urls.operator), max: 2 });
  const admin = new pg.Pool({ connectionString: at(urls.admin), max: 4 });
  let usage: BindingUse[] = [];
  const all: Bindings = { ...crossings, ...views };

  const binding = (name: string, family: 'crossing' | 'view'): Binding => {
    const found = all[name];
    if (!found || (family === 'view') !== (found.kind === 'view')) throw new Error(`the successor adapter has no ${family} named ${name}`);
    return found;
  };

  async function within<T>(actor: Actor, name: string, b: Binding, args: Record<string, unknown>) {
    usage.push({ name, kind: b.kind });
    const client = await app.connect();
    try {
      await enter(client, actor);
      const value = (await b.run(client, args, actor, context)) as T;
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw refusal(error, name);
    } finally {
      client.release();
    }
  }

  const context = { session: (actor: Actor) => session(actor) };
  const session = (actor: Actor): Session => ({
    actor,
    asPrincipal: (principal) => session({ workspace: actor.workspace, principal }),
    asRun: (id, secret) => session({ ...actor, run: { id, secret } }),
    call: (name, args = {}) => within(actor, name, binding(name, 'crossing'), args),
    observe: (name, args = {}) => within(actor, name, binding(name, 'view'), args),
    hold(name, args = {}) {
      const b = binding(name, 'crossing');
      usage.push({ name, kind: b.kind });
      let release = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let resolveResult: (value: never) => void = () => {};
      let rejectResult: (error: unknown) => void = () => {};
      const result = new Promise<never>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      });
      const committed = (async () => {
        const client = await app.connect();
        try {
          await enter(client, actor);
          try {
            resolveResult((await b.run(client, args, actor, context)) as never);
          } catch (error) {
            rejectResult(refusal(error, name));
            await client.query('ROLLBACK');
            return;
          }
          await released;
          await client.query('COMMIT');
        } finally {
          client.release();
        }
      })();
      return { result, release, committed };
    },
  });

  return {
    name: 'successor',
    setWorkspace: (workspace) => session(workspace ? { workspace } : {}),
    operator: {
      async createWorkspace({ name, kind, ownerName, ownerEmail }) {
        usage.push({ name: 'operator.create_workspace', kind: 'operator' });
        const { rows } = await operator.query<{ workspace_id: string; owner_id: string; system_id: string }>(
          'SELECT * FROM operator.create_workspace($1, $2, $3, $4)',
          [name, kind, ownerName, ownerEmail],
        );
        const row = rows[0];
        if (!row) throw new Error('no workspace was created');
        return { workspace: row.workspace_id, owner: row.owner_id, system: row.system_id };
      },
    },
    adversary: {
      async attack(name, args = {}) {
        usage.push({ name, kind: 'adversary' });
        const run = attacks[name];
        if (!run) throw new Error(`the successor adapter has no attack named ${name}`);
        const client = await admin.connect();
        try {
          return (await run(client, args)) as never;
        } finally {
          client.release();
        }
      },
    },
    async race<T>(items: readonly RaceItem[]): Promise<Settled<T>[]> {
      let open = 0;
      let start = () => {};
      const started = new Promise<void>((resolve) => {
        start = resolve;
      });
      return Promise.all(
        items.map(async ({ session: s, crossing, args = {} }): Promise<Settled<T>> => {
          const b = binding(crossing, 'crossing');
          usage.push({ name: crossing, kind: b.kind });
          const client: Client = await app.connect();
          try {
            await enter(client, s.actor);
            open += 1;
            if (open === items.length) start();
            await started;
            const value = (await b.run(client, args, s.actor, context)) as T;
            await client.query('COMMIT');
            return { ok: true, value };
          } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            const r = refusal(error, crossing);
            if (r instanceof Refusal) return { ok: false, refusal: r };
            throw r;
          } finally {
            client.release();
          }
        }),
      );
    },
    drainUsage() {
      const drained = usage;
      usage = [];
      return drained;
    },
    async close() {
      await app.end();
      await operator.end();
      await admin.end();
      const c = new pg.Client({ connectionString: urls.admin.replace('{db}', 'postgres') });
      await c.connect();
      try {
        await c.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      } finally {
        await c.end();
      }
    },
  };
}
