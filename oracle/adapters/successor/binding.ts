import type pg from 'pg';
import type { Actor, BindingKind, Session } from '../../target.ts';

export type Client = pg.PoolClient;

/** What a composite binding may use besides its own transaction: other sessions of the same target. */
export interface BindingContext {
  session(actor: Actor): Session;
}

/** One oracle crossing or view, as the successor's core states it, inside the session's transaction. */
export interface Binding {
  readonly kind: BindingKind;
  readonly run: (client: Client, args: Record<string, unknown>, actor: Actor, context: BindingContext) => Promise<unknown>;
}

export type Bindings = Record<string, Binding>;

export async function first<T>(client: Client, sql: string, params: unknown[] = []): Promise<T | undefined> {
  const { rows } = await client.query(sql, params);
  return rows[0] as T | undefined;
}

export async function scalar<T>(client: Client, sql: string, params: unknown[] = []): Promise<T> {
  const row = await first<Record<string, unknown>>(client, sql, params);
  if (!row) throw new Error(`no row from: ${sql}`);
  return Object.values(row)[0] as T;
}

/** A named crossing returning one value. */
export const fn = (sql: string, params: (args: Record<string, unknown>, actor: Actor) => unknown[]): Binding => ({
  kind: 'crossing',
  run: (c, args, actor) => scalar(c, sql, params(args, actor)),
});

/** A named crossing whose rows are returned whole. */
export const fnRows = (sql: string, params: (args: Record<string, unknown>, actor: Actor) => unknown[]): Binding => ({
  kind: 'crossing',
  run: async (c, args, actor) => (await c.query(sql, params(args, actor))).rows,
});

/** A named crossing whose first row (or null) is returned. */
export const fnRow = (sql: string, params: (args: Record<string, unknown>, actor: Actor) => unknown[]): Binding => ({
  kind: 'crossing',
  run: async (c, args, actor) => (await first(c, sql, params(args, actor))) ?? null,
});

/** A read: the rows the session may see. */
export const view = (sql: string, params: (args: Record<string, unknown>, actor: Actor) => unknown[] = () => []): Binding => ({
  kind: 'view',
  run: async (c, args, actor) => (await c.query(sql, params(args, actor))).rows,
});

/** A crossing made of other crossings and reads. */
export const composite = (run: Binding['run']): Binding => ({ kind: 'crossing', run });

/**
 * A write straight into a store, past every crossing. The successor grants the service no such
 * write, so each of these is expected to be refused; they state what an attacker with the service's
 * credentials would try.
 */
export const direct = (run: Binding['run']): Binding => ({ kind: 'governed-write', run });

export const json = (value: unknown) => (value === undefined ? null : JSON.stringify(value));

export const ws = (actor: Actor) => {
  if (!actor.workspace) throw new Error('this binding needs a workspace in the session');
  return actor.workspace;
};

export function merge<T>(families: Record<string, Record<string, T>>): Record<string, T> {
  const all: Record<string, T> = {};
  for (const [family, entries] of Object.entries(families)) {
    for (const [name, entry] of Object.entries(entries)) {
      if (name in all) throw new Error(`${name} is bound twice (again in ${family})`);
      all[name] = entry;
    }
  }
  return all;
}
