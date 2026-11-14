import { waitFor, hangDetector } from '../../../scripts/lib/test-hang.ts';
// Disposable Core contracts for typed material preparation, not Host authority or model delivery.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import pg from 'pg';
import { enter, reasonOf, type Actor } from '@backbone/core/db';
import { dataHomeAdminUrl } from '@backbone/core/testing';
import { CoreLink } from '../src/composition/core.ts';
import { withHomeLock } from '../src/composition/home-lock.ts';
import { MaterialStore } from '../src/stub/material.ts';
import { freshHome } from './helpers.ts';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const READ = 'SELECT * FROM gov.record_material_source_read($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15)';
const WITHDRAW = 'SELECT gov.withdraw_material_source($1,$2,$3,$4,$5,$6)';
const AT = '2026-11-09T12:00:00.000Z';
const STORES = ['material_source_identities', 'material_source_withdrawals', 'material_source_reads'] as const;
interface ReadInput {
  project: string; material: string; version: number; generation: number; key: string;
  original: string; transformation: Record<string, unknown>; kind: 'file' | 'mcp';
  episode: string; prepared: string; author: string | null; run: string | null; task: string | null;
  connection: string | null; tool: string | null;
}
interface Prepared { episode_id: string; receipt_id: string }
const params = (r: ReadInput) => [r.project, r.material, r.version, r.generation, r.key, r.original,
  JSON.stringify(r.transformation), r.kind, r.episode, r.prepared, r.author, r.run, r.task, r.connection, r.tool];

async function context(t: TestContext) {
  const home = freshHome();
  const link = await CoreLink.open({ home });
  const admin = new pg.Client({ connectionString: dataHomeAdminUrl(home) });
  await admin.connect();
  t.after(async () => { await link.close(); await CoreLink.whenClosed(home); await admin.end(); });
  const task = await link.createTask('Synthetic material link');
  const handle = await link.startRun(task);
  const input = (overrides: Partial<ReadInput> = {}): ReadInput => ({
    project: 'project:opaque/not-a-uuid', material: 'material:opaque/not-a-uuid', version: 1, generation: 0,
    key: digest('synthetic read'), original: digest('immutable material bytes'),
    transformation: { kind: 'synthetic-text', version: '1', mode: 'initial' }, kind: 'file',
    episode: 'Synthetic episode envelope', prepared: 'Synthetic adapter text',
    author: null, run: handle.run, task: null, connection: null, tool: null, ...overrides,
  });
  const read = async (r: ReadInput, actor: Actor = link.system()): Promise<Prepared> =>
    (await link.read<Prepared>(actor, READ, params(r))).rows[0];
  const withdraw = (r: ReadInput, sequence = 1, event = digest(`withdrawal ${sequence}`), at = AT, actor: Actor = link.system()) =>
    link.call<string>(actor, WITHDRAW, [r.project, r.material, event, sequence, r.version, at]);
  return { home, link, admin, task, handle, input, read, withdraw };
}
type Context = Awaited<ReturnType<typeof context>>;

async function snapshot(admin: pg.Client) {
  const result: Record<string, unknown> = {};
  for (const table of [...STORES, 'episodes', 'ledger', 'ledger_heads', 'runs']) {
    result[table] = (await admin.query(`SELECT to_jsonb(x) AS row FROM app.${table} x ORDER BY to_jsonb(x)::text`)).rows;
  }
  return result;
}
async function governor(c: Context, actor: Actor, sql: string, values: unknown[] = []) {
  await enter(c.admin, actor);
  try {
    await c.admin.query('SET LOCAL ROLE backbone_gov');
    return await c.admin.query(sql, values);
  } finally { await c.admin.query('ROLLBACK'); }
}

async function applicationClient(c: Context) {
  const { appUrl } = JSON.parse(readFileSync(join(c.home, 'pg', 'external.json'), 'utf8')) as { appUrl: string };
  assert.equal(typeof appUrl, 'string');
  const client = new pg.Client({ connectionString: appUrl });
  try {
    await client.connect();
    assert.deepEqual((await client.query('SELECT current_user AS role,session_user AS login')).rows,
      [{ role: 'backbone_app', login: 'backbone_app' }]);
    return client;
  } catch (error) { await client.end(); throw error; }
}

async function rejectsIsolation(c: Context, client: pg.Client, isolation: 'REPEATABLE READ' | 'SERIALIZABLE', sql: string, values: unknown[]) {
  await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
  try {
    // enter() starts its own transaction; set all four identity GUCs directly after this BEGIN.
    await client.query(`SELECT set_config('backbone.workspace',$1,true),set_config('backbone.principal',$2,true),
      set_config('backbone.run',$3,true),set_config('backbone.secret',$4,true)`,
    [c.link.id.workspace, c.link.id.system, '', '']);
    await assert.rejects(client.query(sql, values), (error: unknown) => error instanceof Error &&
      reasonOf(error) === 'paused' && /isolation/i.test(error.message) && /READ COMMITTED/i.test(error.message));
    await assert.rejects(client.query('SELECT 1'), (error: unknown) => error instanceof Error &&
      'code' in error && error.code === '25P02', 'the refusal aborts this transaction until rollback');
  } finally { await client.query('ROLLBACK'); }
}

async function committedReplay(c: Context, client: pg.Client, sql: string, values: unknown[]) {
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  try {
    await client.query(`SELECT set_config('backbone.workspace',$1,true),set_config('backbone.principal',$2,true),
      set_config('backbone.run',$3,true),set_config('backbone.secret',$4,true)`,
    [c.link.id.workspace, c.link.id.system, '', '']);
    const result = await client.query(sql, values);
    await client.query('COMMIT');
    return result.rows;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

test('an opaque material read keeps all three representations and exact retries create no second episode or ledger entry', async (t) => {
  const c = await context(t), r = c.input({ author: c.link.id.person, task: c.task });
  const first = await c.read(r);
  assert.match(first.episode_id, /^[a-f0-9-]{36}$/);
  assert.match(first.receipt_id, /^[a-f0-9-]{36}$/);
  assert.notEqual(first.episode_id, first.receipt_id);
  const before = await snapshot(c.admin);
  assert.deepEqual(await c.read(r), first);
  assert.deepEqual(await snapshot(c.admin), before);
  const link = (await c.admin.query('SELECT * FROM app.material_source_reads WHERE episode_id=$1', [first.episode_id])).rows[0];
  assert.equal(link.original_sha256, r.original);
  assert.equal(link.episode_sha256, digest(r.episode));
  assert.equal(link.prepared_sha256, digest(r.prepared));
  assert.deepEqual(link.transformation, r.transformation);
  const episode = (await c.admin.query('SELECT * FROM app.episodes WHERE id=$1', [first.episode_id])).rows[0];
  assert.equal(episode.content, r.episode);
  assert.equal(episode.content_hash, digest(r.episode));
  assert.equal(episode.trust, 'trusted');
  assert.equal(episode.sensitive, true, 'the native file crossing retains person-authored private-task classification');
  assert.equal(episode.authored_by, c.link.id.person);
  const publicRows = JSON.stringify((await c.admin.query("SELECT subject,payload FROM app.ledger WHERE entry_type IN ('material.read_registered','material.source_withdrawn')")).rows);
  for (const raw of [r.material, r.project, r.key, r.original, digest(r.episode), digest(r.prepared), r.episode, r.prepared]) {
    assert.equal(publicRows.includes(raw), false, 'new ledger metadata uses keyed digests, not raw identities, text or hashes');
  }
});

test('C2: withdrawing a source Core never knew creates an immutable tombstone and a stable payload-bound receipt', async (t) => {
  const c = await context(t), r = c.input();
  const event = digest('unknown source withdrawal');
  const receipt = await c.withdraw(r, 1, event);
  const before = await snapshot(c.admin);
  assert.equal(await c.withdraw(r, 1, event), receipt);
  assert.deepEqual(await snapshot(c.admin), before);
  assert.equal((await c.admin.query('SELECT count(*)::int AS n FROM app.episodes')).rows[0].n, 0);
  assert.equal((await c.admin.query('SELECT generation FROM app.material_source_withdrawals')).rows[0].generation, 0);
  await assert.rejects(c.read(r), /generation was withdrawn/);
  await assert.rejects(c.withdraw({ ...r, version: 2 }, 1, event), /another payload/);
  await assert.rejects(c.withdraw(r, 1, event, '2026-11-09T12:00:00.000+00:00'), /another payload/);
  await assert.rejects(c.withdraw(r, 1, digest('same generation, another event')), /another withdrawal event/);
  assert.deepEqual(await snapshot(c.admin), before);
});

test('C1: a real store restore registers a new generation without reviving its original receipt or changing evidence', async (t) => {
  const c = await context(t), store = new MaterialStore(c.home, {}, () => {});
  const source = await withHomeLock(c.home, async () => store.create('project:restore', 'source.txt', 'text/plain', Buffer.from('original'), 'original', 'person'));
  const initial = c.input({ project: source.projectId, material: source.id, original: source.versions[0].sha256, episode: 'original', prepared: 'original' });
  const first = await withHomeLock(c.home, async () => c.read(initial));
  const event = await withHomeLock(c.home, async () => { store.withdraw(source.id); return store.pendingWithdrawals(c.link.id.workspace)[0]; });
  const receipt = await c.link.call<string>(c.link.system(), WITHDRAW, [event.projectId, event.materialId, event.id, event.sequence, event.version, event.at]);
  await withHomeLock(c.home, async () => { assert.equal(store.acknowledgeWithdrawal(source.id, event.id, c.link.id.workspace, receipt), true); });
  await assert.rejects(c.read(initial), /generation was withdrawn/);
  const restored = await withHomeLock(c.home, async () => store.restore(source.id));
  const next = { ...initial, generation: restored.withdrawals!.length, key: digest('fresh restored read') };
  const second = await withHomeLock(c.home, async () => c.read(next));
  assert.notEqual(second.episode_id, first.episode_id);
  assert.notEqual(second.receipt_id, first.receipt_id);
  assert.equal((await c.admin.query('SELECT content FROM app.episodes WHERE id=$1', [first.episode_id])).rows[0].content, 'original');
  assert.equal((await c.admin.query('SELECT count(*)::int AS n FROM app.material_source_withdrawals')).rows[0].n, 1);
  await withHomeLock(c.home, async () => { store.withdraw(source.id); });
  const latest = store.pendingWithdrawals(c.link.id.workspace).find(e => e.sequence === 2)!;
  await c.link.call(c.link.system(), WITHDRAW, [latest.projectId, latest.materialId, latest.id, latest.sequence, latest.version, latest.at]);
  await assert.rejects(c.read(next), /generation was withdrawn/);
  assert.equal((await c.admin.query('SELECT count(*)::int AS n FROM app.material_source_reads')).rows[0].n, 2);
});

test('out-of-order tombstones hold higher generations until the entire previous prefix exists', async (t) => {
  const c = await context(t), r = c.input();
  await assert.rejects(c.read({ ...r, generation: 1 }), /prior material withdrawals/);
  await c.withdraw(r, 2);
  await assert.rejects(c.read({ ...r, generation: 2 }), /prior material withdrawals/);
  await assert.rejects(c.read({ ...r, generation: 1 }), /generation was withdrawn/);
  await c.withdraw(r, 1);
  assert.ok(await c.read({ ...r, generation: 2 }));
  await assert.rejects(c.read({ ...r, generation: 3, key: digest('invented gap') }), /prior material withdrawals/);
  // Core cannot prove an actual restore after this complete prefix; C1's Host/store check is separate.
});

test('a read key rejects changed payloads and a material cannot be relabelled into another project', async (t) => {
  const c = await context(t), r = c.input();
  await c.read(r);
  const before = await snapshot(c.admin);
  const otherTask = await c.link.createTask('Other visible task');
  const baseline = await snapshot(c.admin);
  for (const change of [
    { prepared: r.prepared + ' changed' }, { episode: r.episode + ' changed' },
    { transformation: { ...r.transformation, mode: 'different' } }, { version: 2 },
    { material: 'another opaque material' }, { author: c.link.id.person }, { task: otherTask },
  ]) await assert.rejects(c.read({ ...r, ...change }), /another payload/);
  await assert.rejects(c.read({ ...r, project: 'another project' }), /another project/);
  await assert.rejects(c.withdraw({ ...r, project: 'another project' }), /another project/);
  assert.deepEqual(await snapshot(c.admin), baseline);
  assert.equal((before.material_source_reads as unknown[]).length, 1);
});

test('contradictory original bytes refuse even with a new read key, while a new immutable version can differ', async (t) => {
  const c = await context(t), r = c.input();
  await c.read(r);
  const before = await snapshot(c.admin);
  await assert.rejects(c.read({ ...r, key: digest('changed bytes'), original: digest('different original bytes') }), /different original bytes/);
  assert.deepEqual(await snapshot(c.admin), before);
  assert.ok(await c.read({ ...r, version: 2, key: digest('version two'), original: digest('different original bytes') }));
});

test('an error at link insertion rolls back its native episode, source ledger, identity and run marks together', async (t) => {
  const c = await context(t), r = c.input({ key: 'e'.repeat(64) });
  // Disposable fault after record_source has inserted and marked the run, before the binding can land.
  await c.admin.query("ALTER TABLE app.material_source_reads ADD CONSTRAINT synthetic_link_fault CHECK (read_key <> repeat('e',64))");
  const before = await snapshot(c.admin);
  await assert.rejects(c.read(r), /synthetic_link_fault/);
  assert.deepEqual(await snapshot(c.admin), before);
});

test('the system-only caller and closed-table boundary reject persons, agents, runs and empty identities', async (t) => {
  const c = await context(t), r = c.input();
  for (const actor of [c.link.person(), c.link.runOf(c.handle), { workspace: c.link.id.workspace, principal: c.link.id.agent }, {}]) {
    await assert.rejects(c.read(r, actor), /system_records/);
    await assert.rejects(c.withdraw(r, 1, digest('role test'), AT, actor), /system_records/);
  }
  assert.equal((await c.admin.query('SELECT count(*)::int AS n FROM app.material_source_identities')).rows[0].n, 0);
  for (const table of STORES) {
    await assert.rejects(c.link.read(c.link.system(), `SELECT * FROM app.${table}`), /permission denied/);
    await assert.rejects(c.link.read(c.link.system(), `DELETE FROM app.${table}`), /permission denied/);
  }
});

test('tenant identity, event/read keys and receipts are isolated, including governor RLS and foreign runs', async (t) => {
  const c = await context(t), r = c.input();
  const first = await c.read(r);
  const other = (await c.admin.query("SELECT * FROM operator.create_workspace('Other tenant','team','Other person','other@example.invalid')")).rows[0];
  const system: Actor = { workspace: other.workspace_id, principal: other.system_id };
  await assert.rejects(c.read({ ...r, project: 'foreign project' }, system), /no such run/);
  const second = await c.read({ ...r, project: 'foreign project', run: null }, system);
  assert.notEqual(first.episode_id, second.episode_id);
  assert.notEqual(first.receipt_id, second.receipt_id);
  const a = await c.withdraw(r), b = await c.withdraw({ ...r, project: 'foreign project' }, 1, digest('withdrawal 1'), AT, system);
  assert.notEqual(a, b);
  for (const table of STORES) {
    assert.deepEqual((await governor(c, system, `SELECT * FROM app.${table} WHERE workspace_id=$1`, [c.link.id.workspace])).rows, []);
  }
  await assert.rejects(governor(c, system, 'INSERT INTO app.material_source_identities(workspace_id,material_id,project_id,observed_by) VALUES($1,$2,$3,$4)',
    [c.link.id.workspace, 'forged tenant material', 'forged tenant project', c.link.id.system]), /row-level security/);
});

test('all three source stores refuse evidence mutation and truncation even to their privileged fixture administrator', async (t) => {
  const c = await context(t), r = c.input();
  await c.read(r); await c.withdraw(r);
  const before = await snapshot(c.admin);
  for (const table of STORES) {
    await assert.rejects(c.admin.query(`UPDATE app.${table} SET workspace_id=workspace_id`), /evidence is immutable/);
    await assert.rejects(c.admin.query(`DELETE FROM app.${table}`), /evidence is immutable/);
  }
  await assert.rejects(c.admin.query('TRUNCATE app.material_source_reads'), /never truncated/);
  await assert.rejects(c.admin.query('TRUNCATE app.material_source_identities CASCADE'), /never truncated/);
  assert.deepEqual(await snapshot(c.admin), before);
});

test('MCP material identities sharing one connection/tool keep independent tombstones and native privacy', async (t) => {
  const c = await context(t);
  const connection = await c.link.call<string>(c.link.person(), "SELECT gov.register_connection('Synthetic server','synthetic',NULL,'person','none')");
  const a = c.input({ material: 'server answer A', kind: 'mcp', connection, tool: 'read', episode: 'Episode envelope A', prepared: 'Raw answer A' });
  const b = { ...a, material: 'server answer B', key: digest('server answer B'), original: digest('material envelope B'), episode: 'Episode envelope B', prepared: 'Raw answer B' };
  const first = await c.read(a), second = await c.read(b);
  const episodes = (await c.admin.query('SELECT * FROM app.episodes WHERE id=ANY($1::uuid[]) ORDER BY content', [[first.episode_id, second.episode_id]])).rows;
  assert.equal(episodes.length, 2);
  assert.equal(episodes[0].source_ref, episodes[1].source_ref);
  for (const e of episodes) { assert.equal(e.trust, 'untrusted'); assert.equal(e.sensitive, true); assert.equal(e.authored_by, null); assert.equal(e.task_id, c.task); }
  await c.withdraw(a);
  await assert.rejects(c.read(a), /generation was withdrawn/);
  assert.deepEqual(await c.read(b), second);
  await assert.rejects(c.read({ ...b, key: digest('forged MCP author'), author: c.link.id.person }), /preserves its native source rules/);
  await assert.rejects(c.read({ ...b, key: digest('forged MCP task'), task: c.task }), /preserves its native source rules/);
});

test('retry cannot reuse a non-sensitive MCP receipt after the connection becomes sensitive', async (t) => {
  const c = await context(t);
  const connection = await c.link.call<string>(c.link.person(), "SELECT gov.register_connection('Synthetic shared server','shared',NULL,'workspace','none')");
  const r = c.input({ kind: 'mcp', connection, tool: 'read' });
  const first = await c.read(r);
  await c.link.call(c.link.person(), 'SELECT gov.mark_connection($1,true)', [connection]);
  const before = await snapshot(c.admin);
  await assert.rejects(c.read(r), /connected source privacy changed/);
  assert.deepEqual(await snapshot(c.admin), before);
  assert.equal((await c.admin.query('SELECT sensitive FROM app.episodes WHERE id=$1', [first.episode_id])).rows[0].sensitive, false);
  const fresh = await c.read({ ...r, key: digest('explicit fresh private read') });
  assert.equal((await c.admin.query('SELECT sensitive FROM app.episodes WHERE id=$1', [fresh.episode_id])).rows[0].sensitive, true);
});

test('an existing receipt does not let a closed or revoked receiving run register another preparation', async (t) => {
  const c = await context(t), r = c.input();
  const first = await c.read(r);
  await c.link.finishRun(c.handle, 'succeeded');
  const before = await snapshot(c.admin);
  await assert.rejects(c.read(r), /no longer belongs to active work/);
  assert.deepEqual(await snapshot(c.admin), before);
  assert.equal((await c.admin.query('SELECT receipt_id FROM app.material_source_reads WHERE episode_id=$1', [first.episode_id])).rows[0].receipt_id, first.receipt_id);
  const other = await c.link.startRun(await c.link.createTask('Revoked receiving run'));
  const next = { ...r, key: digest('revoked run read'), run: other.run };
  await c.read(next);
  const mandate = (await c.admin.query('SELECT mandate_id FROM app.runs WHERE id=$1', [other.run])).rows[0].mandate_id;
  await c.link.call(c.link.person(), 'SELECT gov.revoke_mandate($1)', [mandate]);
  await assert.rejects(c.read(next), /no longer belongs to active work/);
});

test('retry rechecks the run person access to an explicitly named source task before returning its old receipt', async (t) => {
  const c = await context(t), person = randomUUID(), task = randomUUID();
  await c.admin.query("INSERT INTO app.principals(workspace_id,id,kind,role,name) VALUES($1,$2,'person','member','Synthetic other person')", [c.link.id.workspace, person]);
  await c.admin.query("INSERT INTO app.tasks(workspace_id,id,title,visibility,requested_by,on_behalf_of) VALUES($1,$2,'Synthetic shared source','workspace',$3,$3)", [c.link.id.workspace, task, person]);
  const r = c.input({ task });
  const first = await c.read(r);
  // An adverse fixture narrows this audience; the test claims no full concurrent audience proof.
  await c.admin.query("UPDATE app.tasks SET visibility='private' WHERE workspace_id=$1 AND id=$2", [c.link.id.workspace, task]);
  const before = await snapshot(c.admin);
  await assert.rejects(c.read(r), /person cannot see/);
  assert.deepEqual(await snapshot(c.admin), before);
  assert.equal((await c.admin.query('SELECT receipt_id FROM app.material_source_reads WHERE episode_id=$1', [first.episode_id])).rows[0].receipt_id, first.receipt_id);
});

test('a withdrawal committing while a typed read waits on the workspace is observed before any episode is inserted', async (t) => {
  const c = await context(t), r = c.input();
  await enter(c.admin, c.link.system());
  let transaction = true;
  let reading: Promise<{ value?: Prepared; error?: unknown }> | undefined;
  try {
    await c.admin.query(WITHDRAW, [r.project, r.material, digest('in-flight withdrawal'), 1, 1, AT]);
    const pid = (await c.admin.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    reading = c.read(r).then(value => ({ value }), error => ({ error }));
    let blocked = false;

    await waitFor(async()=>{
      blocked = (await c.admin.query('SELECT EXISTS (SELECT FROM pg_stat_activity a WHERE $1=ANY(pg_blocking_pids(a.pid))) AS blocked', [pid])).rows[0].blocked;

      await new Promise(resolve => setTimeout(resolve, 10));
    return !!blocked;},'material-source-link: SQL lock observation',{diagnostic:()=>`blocked=${blocked}`});
    assert.equal(blocked, true, 'observe the actual workspace-lock interleaving before committing');
    await c.admin.query('COMMIT'); transaction = false;
    const result = await reading;
    assert.equal(result.value, undefined);
    assert.match(String(result.error), /generation was withdrawn/);
    assert.equal((await c.admin.query('SELECT count(*)::int AS n FROM app.episodes')).rows[0].n, 0);
    assert.equal((await c.admin.query('SELECT count(*)::int AS n FROM app.material_source_reads')).rows[0].n, 0);
    assert.equal((await c.admin.query('SELECT count(*)::int AS n FROM app.material_source_withdrawals')).rows[0].n, 1);
  } finally {
    if (transaction) await c.admin.query('ROLLBACK');
    await reading;
  }
});

test('a legacy run or connection row lock pauses preparation without waiting in the reverse ledger-lock order', async (t) => {
  const c = await context(t), r = c.input();
  await c.admin.query('BEGIN');
  try {
    await c.admin.query('SELECT id FROM app.runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [c.link.id.workspace, c.handle.run]);
    await assert.rejects(c.read(r), /receiving run or mandate is changing/);
  } finally { await c.admin.query('ROLLBACK'); }
  const connection = await c.link.call<string>(c.link.person(), "SELECT gov.register_connection('Synthetic locked server','locked',NULL,'workspace','none')");
  const mcp = { ...r, kind: 'mcp' as const, connection, tool: 'read' };
  await c.admin.query('BEGIN');
  try {
    await c.admin.query('SELECT id FROM app.connections WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [c.link.id.workspace, connection]);
    await assert.rejects(c.read(mcp), /connected source privacy is changing/);
  } finally { await c.admin.query('ROLLBACK'); }
  assert.equal((await c.admin.query('SELECT count(*)::int AS n FROM app.episodes')).rows[0].n, 0);
  assert.equal((await c.admin.query('SELECT count(*)::int AS n FROM app.material_source_reads')).rows[0].n, 0);
});

test('a held mandate row pauses exact replay through its NOWAIT branch without returning or duplicating the receipt', async (t) => {
  const c = await context(t), r = c.input();
  const first = await c.read(r);
  const mandate = (await c.admin.query('SELECT mandate_id FROM app.runs WHERE workspace_id=$1 AND id=$2', [c.link.id.workspace, c.handle.run])).rows[0].mandate_id;
  const before = await snapshot(c.admin);
  const caller = new pg.Client({ connectionString: dataHomeAdminUrl(c.home) });
  await caller.connect();
  try {
    await c.admin.query('BEGIN');
    await c.admin.query('SELECT id FROM app.mandates WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [c.link.id.workspace, mandate]);
    await enter(caller, c.link.system());
    await caller.query('SET LOCAL ROLE backbone_app');
    assert.equal((await caller.query('SELECT current_user AS role')).rows[0].role, 'backbone_app');
    // A removed NOWAIT must fail this control by timeout, not hang while the fixture owns the row.
    await caller.query("SET LOCAL statement_timeout='240s'");
    await assert.rejects(hangDetector(caller.query(READ, params(r)),'material receipt NOWAIT admission while mandate is held'), (error: unknown) => error instanceof Error &&
      reasonOf(error) === 'paused' && /receiving run or mandate is changing/.test(error.message));
  } finally {
    await caller.query('ROLLBACK');
    await c.admin.query('ROLLBACK');
    await caller.end();
  }
  assert.deepEqual(await snapshot(c.admin), before);
  assert.deepEqual(await c.read(r), first, 'the original receipt remains usable once the lock settles');
  assert.deepEqual(await snapshot(c.admin), before);
});

test('expiry alone makes replay stale while preserving the running run and its original preparation receipt', async (t) => {
  const c = await context(t), r = c.input();
  const first = await c.read(r);
  const mandate = (await c.admin.query('SELECT mandate_id FROM app.runs WHERE workspace_id=$1 AND id=$2', [c.link.id.workspace, c.handle.run])).rows[0].mandate_id;
  // Disposable administrator moves the fixture's time boundary, without a timed sleep or a
  // production mandate-edit route. Its immutable-term trigger is restored before any assertion.
  await c.admin.query('BEGIN');
  try {
    await c.admin.query('ALTER TABLE app.mandates DISABLE TRIGGER rules');
    await c.admin.query("UPDATE app.mandates SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND id=$2", [c.link.id.workspace, mandate]);
    await c.admin.query('ALTER TABLE app.mandates ENABLE TRIGGER rules');
    await c.admin.query('COMMIT');
  } catch (error) { await c.admin.query('ROLLBACK'); throw error; }
  assert.equal((await c.admin.query("SELECT tgenabled FROM pg_trigger WHERE tgrelid='app.mandates'::regclass AND tgname='rules'")).rows[0].tgenabled, 'O');
  const state = (await c.admin.query('SELECT r.status,m.revoked_at,m.expires_at<=clock_timestamp() AS expired FROM app.runs r JOIN app.mandates m ON m.workspace_id=r.workspace_id AND m.id=r.mandate_id WHERE r.workspace_id=$1 AND r.id=$2', [c.link.id.workspace, c.handle.run])).rows[0];
  assert.equal(state.status, 'running');
  assert.equal(state.revoked_at, null);
  assert.equal(state.expired, true);
  const before = await snapshot(c.admin);
  await assert.rejects(c.read(r), (error: unknown) => error instanceof Error &&
    reasonOf(error) === 'stale' && /no longer belongs to active work/.test(error.message));
  assert.deepEqual(await snapshot(c.admin), before);
  assert.equal((await c.admin.query('SELECT receipt_id FROM app.material_source_reads WHERE workspace_id=$1 AND episode_id=$2', [c.link.id.workspace, first.episode_id])).rows[0].receipt_id, first.receipt_id);
});

test('K1: typed reads refuse fresh requests and committed replays outside READ COMMITTED on an actual app connection', async (t) => {
  const c = await context(t), replay = c.input();
  const original = await c.read(replay);
  const fresh = c.input({ material: 'fresh isolation material', key: digest('fresh isolation read') });
  const before = await snapshot(c.admin);
  const client = await applicationClient(c);
  try {
    for (const isolation of ['REPEATABLE READ', 'SERIALIZABLE'] as const) {
      for (const input of [fresh, replay]) {
        await rejectsIsolation(c, client, isolation, READ, params(input));
        assert.deepEqual(await snapshot(c.admin), before);
      }
    }
    assert.deepEqual(await committedReplay(c, client, READ, params(replay)), [original]);
  } finally { await client.end(); }
  assert.deepEqual(await c.read(replay), original, 'ordinary READ COMMITTED still returns the original receipt');
  assert.deepEqual(await snapshot(c.admin), before);
});

test('K1: withdrawals refuse fresh events and committed replays outside READ COMMITTED on an actual app connection', async (t) => {
  const c = await context(t), replay = c.input();
  const event = digest('committed isolation withdrawal');
  const original = await c.withdraw(replay, 1, event);
  const fresh = c.input({ material: 'fresh isolation withdrawal material' });
  const payloads = [
    [fresh.project, fresh.material, digest('fresh isolation withdrawal'), 1, fresh.version, AT],
    [replay.project, replay.material, event, 1, replay.version, AT],
  ];
  const before = await snapshot(c.admin);
  const client = await applicationClient(c);
  try {
    for (const isolation of ['REPEATABLE READ', 'SERIALIZABLE'] as const) {
      for (const payload of payloads) {
        await rejectsIsolation(c, client, isolation, WITHDRAW, payload);
        assert.deepEqual(await snapshot(c.admin), before);
      }
    }
    const rows = await committedReplay(c, client, WITHDRAW, payloads[1]);
    assert.equal(Object.values(rows[0])[0], original);
  } finally { await client.end(); }
  assert.equal(await c.withdraw(replay, 1, event), original, 'ordinary READ COMMITTED still returns the original receipt');
  assert.deepEqual(await snapshot(c.admin), before);
});
