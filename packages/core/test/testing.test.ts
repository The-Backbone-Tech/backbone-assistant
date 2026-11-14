import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { openPersonalDatabase } from '../src/db/personal.ts';
import { buildBaseline } from '../src/db/baseline.ts';
import { CORE_SCHEMA_UPGRADES } from '../src/db/schema-migrations.ts';
import { prepareDataHome, startTestPostgres, TEST_CLUSTER_ENV } from '../src/db/testing.ts';

/**
 * The test support itself: a run has one cluster (macOS allows 32 System V shared-memory segments
 * per machine, one per server), every file and data home takes its own database from the template.
 */
const homes: string[] = [];
const home = () => {
  const dir = mkdtempSync(join(tmpdir(), 'backbone-prepared-'));
  homes.push(dir);
  return dir;
};
const query = async (url: string, sql: string) => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(sql)).rows;
  } finally {
    await c.end();
  }
};
const databases = async (postgres: Awaited<ReturnType<typeof startTestPostgres>>) =>
  (await query(postgres.adminUrl('postgres'), 'SELECT datname FROM pg_database')).map((r) => r.datname as string);
const port = (url: string) => new URL(url).port;

afterAll(() => {
  for (const dir of homes) rmSync(dir, { recursive: true, force: true });
});

describe('the run\'s shared cluster', () => {
  it('is started by the runner and used by every file', async () => {
    expect(process.env[TEST_CLUSTER_ENV], 'vitest\'s globalSetup told this file where the cluster is').toBeTruthy();
    const a = await startTestPostgres();
    const b = await startTestPostgres();
    expect(port(a.adminUrl('postgres'))).toBe(port(b.adminUrl('postgres')));
  });

  it('gives each file databases of its own, even under the same name, and takes only those back', async () => {
    const a = await startTestPostgres();
    const b = await startTestPostgres();
    await a.clone('same');
    await b.clone('same');
    await query(a.adminUrl('same'), 'CREATE TABLE only_in_a (id int)');
    expect(await query(a.adminUrl('same'), `SELECT to_regclass('only_in_a') AS found`)).toEqual([{ found: 'only_in_a' }]);
    expect(await query(b.adminUrl('same'), `SELECT to_regclass('only_in_a') AS found`)).toEqual([{ found: null }]);
    expect(await query(a.adminUrl('same'), 'SELECT version, checksum FROM ops.schema_migrations ORDER BY version')).toEqual(
      [{ version: 'baseline', checksum: buildBaseline().checksum }, ...CORE_SCHEMA_UPGRADES].sort((a, b) => a.version.localeCompare(b.version)),
    );
    expect(await query(a.appUrl('same'), 'SELECT current_user AS who')).toEqual([{ who: 'backbone_app' }]);
    expect(await databases(a)).toEqual(expect.arrayContaining([expect.stringMatching(/^t[0-9a-f]{8}_same$/)]));
    await a.stop();
    const left = await databases(b);
    expect(left.filter((d) => d.endsWith('_same'))).toHaveLength(1);
    await b.stop();
    expect((await databases(b)).filter((d) => d.endsWith('_same'))).toEqual([]);
  });
});

describe('a prepared data home', () => {
  it('opens its own database in that cluster and starts no server', async () => {
    const dir = home();
    expect(prepareDataHome(dir)).toBe(true);
    const db = await openPersonalDatabase({ dir: join(dir, 'pg'), baselineSql: 'SELECT 1/0; -- never run: the database already holds the baseline' });
    expect(existsSync(join(dir, 'pg', 'data'))).toBe(false);
    // The baseline is there: the operator can make a workspace.
    expect(await query(db.operatorUrl, `SELECT workspace_id FROM operator.create_workspace('Prepared', 'personal', 'You', 'you@this.computer')`)).toHaveLength(1);
    await db.stop();
    // Stopping a home's connection to a cluster it does not own leaves the cluster running.
    expect(await query(db.appUrl, 'SELECT 1 AS up')).toEqual([{ up: 1 }]);
  });

  it('is a database no other home shares', async () => {
    const [one, other] = [home(), home()];
    prepareDataHome(one);
    prepareDataHome(other);
    const first = await openPersonalDatabase({ dir: join(one, 'pg'), baselineSql: '' });
    const second = await openPersonalDatabase({ dir: join(other, 'pg'), baselineSql: '' });
    const name = (url: string) => new URL(url).pathname.slice(1);
    expect(name(first.appUrl)).not.toBe(name(second.appUrl));
    await query(first.operatorUrl, `SELECT * FROM operator.create_workspace('One', 'personal', 'You', 'you@this.computer')`);
    const postgres = await startTestPostgres();
    const count = 'SELECT count(*)::int AS n FROM app.workspaces';
    expect(await query(postgres.adminUrl(name(first.appUrl)), count)).toEqual([{ n: 1 }]);
    expect(await query(postgres.adminUrl(name(second.appUrl)), count)).toEqual([{ n: 0 }]);
  });

  it('refuses a home that already has a cluster of its own', () => {
    const dir = home();
    prepareDataHome(dir);
    rmSync(join(dir, 'pg', 'external.json'));
    mkdirSync(join(dir, 'pg', 'data'));
    expect(() => prepareDataHome(dir)).toThrow();
  });
});
