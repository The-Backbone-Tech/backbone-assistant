import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { type KernelCluster, startKernelCluster } from '../src/testing.ts';

let cluster: KernelCluster;
before(async () => { cluster = await startKernelCluster(); });
after(async () => { await cluster?.stop(); });

const as = async <T>(url: string, f: (c: pg.Client) => Promise<T>) => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try { return await f(c); } finally { await c.end(); }
};

test('each login holds exactly its role', async () => {
  const held = (url: string) => as(url, async (c) => (await c.query(
    "SELECT r.rolname FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'MEMBER') AND r.rolname = ANY($1) ORDER BY 1",
    [['backbone_app', 'planes_observer', 'planes_identity', 'backbone_gov']],
  )).rows.map((r) => r.rolname));
  assert.deepEqual(await held(cluster.appUrl), ['backbone_app']);
  assert.deepEqual(await held(cluster.observerUrl), ['planes_observer']);
  assert.deepEqual(await held(cluster.identityUrl), ['planes_identity']);
});

test('the application role reaches no table directly', async () => {
  await as(cluster.appUrl, async (c) => {
    await assert.rejects(c.query('SELECT 1 FROM app.runs LIMIT 1'), /permission denied/);
  });
});

test('the kernel functions are installed', async () => {
  const n = await as(cluster.adminUrl, async (c) => (await c.query("SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('land','admit_reservation') AND pronamespace = 'gov'::regnamespace")).rows[0].n);
  assert.equal(n, 2);
});
