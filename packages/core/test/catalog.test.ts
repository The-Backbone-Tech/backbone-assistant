import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baselineFiles, buildBaseline, serviceClient } from '../src/db/index.ts';
import { CORE_SCHEMA_UPGRADES } from '../src/db/schema-migrations.ts';
import { startTestPostgres, type TestPostgres } from '../src/db/testing.ts';

/**
 * The core's own pinned lists (SG-ISO-02): what the service may execute, which stores exist and are
 * walled, which roles exist. A change to any of them is a reviewed change to this file.
 */
const pinned = JSON.parse(readFileSync(new URL('./pinned.json', import.meta.url), 'utf8')) as {
  roles: string[];
  stores: string[];
  closedStores: string[];
  published: string[];
};

let postgres: TestPostgres;
let admin: pg.Client;

beforeAll(async () => {
  postgres = await startTestPostgres();
  await postgres.clone('catalog');
  admin = new pg.Client({ connectionString: postgres.adminUrl('catalog') });
  await admin.connect();
});

afterAll(async () => {
  await admin?.end();
  await postgres?.stop();
});

const rows = async (sql: string) => (await admin.query(sql)).rows.map((r) => Object.values(r)[0] as string);

describe('the baseline', () => {
  it('is made of one file per object, each defining what its name says', () => {
    for (const file of baselineFiles()) {
      if (!/^(sec|gov|operator)\//.test(file)) continue;
      const name = file.replace(/\.sql$/, '').replace('/', '.');
      const text = readFileSync(new URL(`../schema/${file}`, import.meta.url), 'utf8');
      expect([...text.matchAll(/CREATE FUNCTION ([\w.]+)\(/g)].map((m) => m[1]), file).toEqual([name]);
    }
  });

  it('records the installed baseline and each reviewed additive template step', async () => {
    expect((await admin.query('SELECT version, checksum FROM ops.schema_migrations ORDER BY version')).rows).toEqual(
      [{ version: 'baseline', checksum: buildBaseline().checksum }, ...CORE_SCHEMA_UPGRADES].sort((a, b) => a.version.localeCompare(b.version)),
    );
  });
});

describe('the pinned lists', () => {
  it('roles: none is a superuser or bypasses row-level security', async () => {
    const roles = (await admin.query(`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname LIKE 'backbone\\_%' ORDER BY 1`)).rows;
    expect(roles.map((r) => r.rolname)).toEqual(pinned.roles);
    expect(roles.filter((r) => r.rolsuper || r.rolbypassrls)).toEqual([]);
  });

  it('stores: exactly the pinned tenant stores, each with forced row-level security and the tenant wall', async () => {
    expect(await rows(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                       WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p') ORDER BY 1`)).toEqual(pinned.stores);
    expect(
      await rows(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'app' AND c.relkind = 'r' AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity
                    OR NOT EXISTS (SELECT FROM pg_policies p WHERE p.schemaname = 'app' AND p.tablename = c.relname
                                   AND p.policyname = 'tenant_wall' AND p.permissive = 'RESTRICTIVE'))`),
    ).toEqual([]);
    expect(await rows(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                       WHERE n.nspname = 'app' AND c.relkind = 'r' AND NOT has_table_privilege('backbone_app', c.oid, 'SELECT') ORDER BY 1`))
      .toEqual(pinned.closedStores);
  });

  it('published: the service executes exactly the pinned crossings and helpers, and no internal one', async () => {
    expect(
      await rows(`SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname IN ('app', 'sec', 'gov', 'ops', 'auth', 'operator', 'crypto')
                    AND has_function_privilege('backbone_app', p.oid, 'EXECUTE') ORDER BY 1`),
    ).toEqual(pinned.published);
  });

  it('the service writes no tenant store directly', async () => {
    expect(await rows(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                       WHERE n.nspname = 'app' AND c.relkind = 'r'
                         AND has_table_privilege('backbone_app', c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')`)).toEqual([]);
  });
});

describe('the service role (I-2)', () => {
  it('connects as backbone_app, and refuses a superuser', async () => {
    const service = await serviceClient(postgres.appUrl('catalog'));
    await service.end();
    await expect(serviceClient(postgres.adminUrl('catalog'))).rejects.toThrow(/refuses to run as a superuser/);
  });
});

describe('spec gaps the core closes', () => {
  it('SG-LED-01: an owner tests words against an entry digest without the key; SG-LED-02: the operator sees queue depth', async () => {
    const operator = new pg.Client({ connectionString: postgres.operatorUrl('catalog') });
    await operator.connect();
    const { rows: [made] } = await operator.query('SELECT * FROM operator.create_workspace($1, $2, $3, $4)', ['Gaps', 'team', 'Owner', 'o@example.com']);
    expect((await operator.query('SELECT * FROM operator.queue_depth()')).rows).toEqual([]);
    await operator.end();
    const service = await serviceClient(postgres.appUrl('catalog'));
    const as = async <T>(sql: string, params: unknown[] = []) => {
      await service.query('BEGIN');
      await service.query(`SELECT set_config('backbone.workspace', $1, true), set_config('backbone.principal', $2, true)`, [made.workspace_id, made.owner_id]);
      try {
        return (await service.query(sql, params)).rows as T[];
      } finally {
        await service.query('COMMIT');
      }
    };
    const [task] = await as<{ id: string }>('SELECT gov.create_task($1, $1, $2, NULL, NULL) AS id', [made.owner_id, 'Plan']);
    await as('SELECT gov.rewrite_task($1, $2, NULL, NULL)', [task?.id, 'Salary review for Ana']);
    const [entry] = await as<{ seq: string }>(`SELECT seq FROM app.ledger WHERE entry_type = 'task.changed'`);
    const match = (words: string) => as<{ m: boolean }>('SELECT gov.ledger_words_match($1, $2, $3) AS m', [entry?.seq, 'title', words]);
    expect((await match('Salary review for Ana'))[0]?.m).toBe(true);
    expect((await match('Salary review for Joan'))[0]?.m).toBe(false);
    await service.end();
  });
});
