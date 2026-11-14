// Disposable real PostgreSQL transport controls; no provider calls or non-disposable homes.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import pg from 'pg';
import { dataHomeAdminUrl } from '@backbone/core/testing';
import { CoreLink, CoreRefusal } from '../src/composition/core.ts';
import { withHomeLock } from '../src/composition/home-lock.ts';
import { LOG_POLICY_QUERY } from '../src/authority/log-policy.ts';
import { MaterialStore } from '../src/stub/material.ts';
import { freshHome } from './helpers.ts';

async function context(t: TestContext) {
  const home = freshHome();
  const link = await CoreLink.open({ home });
  const admin = new pg.Client({ connectionString: dataHomeAdminUrl(home) });
  await admin.connect();
  t.after(async () => { await link.close(); await CoreLink.whenClosed(home); await admin.end(); });
  const store = new MaterialStore(home, {}, () => {});
  const event = await withHomeLock(home, async () => {
    const source = store.create('synthetic-project', 'source.md', 'text/markdown', Buffer.from('Synthetic original'), 'original', 'person');
    store.withdraw(source.id);
    return store.pendingWithdrawals(link.id.workspace)[0];
  });
  const journal = async () => ({
    withdrawals: (await admin.query('SELECT * FROM app.material_source_withdrawals WHERE workspace_id=$1 ORDER BY event_id', [link.id.workspace])).rows,
    identities: (await admin.query('SELECT * FROM app.material_source_identities WHERE workspace_id=$1 ORDER BY material_id', [link.id.workspace])).rows,
    ledger: (await admin.query("SELECT * FROM app.ledger WHERE workspace_id=$1 AND entry_type='material.source_withdrawn' ORDER BY seq", [link.id.workspace])).rows,
    episodes: (await admin.query('SELECT * FROM app.episodes WHERE workspace_id=$1 ORDER BY id', [link.id.workspace])).rows,
  });
  const appConnections = async () => (await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND usename='backbone_app'")).rows[0].n as number;
  return { home, link, admin, store, event, journal, appConnections };
}

const textOf = (query: unknown): string => typeof query === 'string' ? query :
  query && typeof query === 'object' && 'text' in query && typeof query.text === 'string' ? query.text : '';
// Instrument the native client only at its response boundary; every observed query still runs
// on the real disposable database. Test files run in separate processes; restore before cleanup.
const prototype = pg.Client.prototype as unknown as { query: (...args: unknown[]) => Promise<pg.QueryResult> };

test('the real transport tombstones a source Core never knew and exact retries return its first committed receipt', async (t) => {
  const c = await context(t);
  assert.equal(c.link.materialLink.state, 'verified');
  assert.deepEqual(await c.journal(), { withdrawals: [], identities: [], ledger: [], episodes: [] });
  const connections = await c.appConnections();
  const first = await c.link.confirmMaterialWithdrawal(c.event);
  assert.deepEqual({ workspace: first.workspace, event: first.event }, { workspace: c.link.id.workspace, event: c.event.id });
  assert.match(first.receipt, /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  const recorded = await c.journal();
  assert.equal(recorded.withdrawals.length, 1);
  const row = recorded.withdrawals[0];
  assert.equal(row.receipt_id, first.receipt);
  assert.equal(row.event_id, c.event.id);
  assert.equal(row.project_id, c.event.projectId);
  assert.equal(row.material_id, c.event.materialId);
  assert.equal(row.generation, c.event.sequence - 1);
  assert.equal(row.observed_version, c.event.version);
  assert.equal(row.event_at, c.event.at);
  assert.equal(row.recorded_by, c.link.id.system);
  assert.equal(recorded.identities.length, 1);
  assert.equal(recorded.ledger.length, 1);
  assert.deepEqual(recorded.episodes, [], 'withdrawal does not invent a read or require an existing episode');
  assert.deepEqual(await c.link.confirmMaterialWithdrawal(c.event), first);
  assert.deepEqual(await c.journal(), recorded);
  assert.equal(await c.appConnections(), connections, 'the dedicated transport connection is closed after each call');
  assert.deepEqual(c.store.pendingWithdrawals(c.link.id.workspace), [c.event], 'transport alone does not merge a store acknowledgement');
});

test('a real Core payload conflict is exposed as conflict without inventing a replacement receipt', async (t) => {
  const c = await context(t);
  const first = await c.link.confirmMaterialWithdrawal(c.event);
  const before = await c.journal();
  await assert.rejects(c.link.confirmMaterialWithdrawal({ ...c.event, projectId: 'another-project' }),
    error => error instanceof CoreRefusal && error.reason === 'conflict' && /^conflict: /.test(error.message));
  assert.deepEqual(await c.journal(), before);
  assert.deepEqual(await c.link.confirmMaterialWithdrawal(c.event), first);
});

test('losing the response only after COMMIT keeps the real receipt and an exact retry neither duplicates nor replays another event', async (t) => {
  const c = await context(t);
  const original = prototype.query;
  let target: pg.Client | undefined, dropped = false, committedReceipt: string | undefined;
  t.mock.method(prototype, 'query', async function(this: pg.Client, ...args: unknown[]) {
    const sql = textOf(args[0]);
    if (sql.startsWith('SELECT gov.withdraw_material_source(')) target = this;
    const result = await Reflect.apply(original, this, args);
    if (this === target && sql === 'COMMIT' && !dropped) {
      // Verify committed visibility on a different connection before discarding the response.
      const rows = await Reflect.apply(original, c.admin, ['SELECT receipt_id FROM app.material_source_withdrawals WHERE workspace_id=$1 AND event_id=$2', [c.link.id.workspace, c.event.id]]);
      assert.equal(rows.rows.length, 1);
      committedReceipt = rows.rows[0].receipt_id;
      dropped = true;
      throw new Error('Synthetic lost acknowledgement after a verified real COMMIT');
    }
    return result;
  });
  try {
    await assert.rejects(c.link.confirmMaterialWithdrawal(c.event), /Synthetic lost acknowledgement after a verified real COMMIT/);
  } finally { t.mock.restoreAll(); }
  assert.equal(dropped, true);
  assert.ok(committedReceipt);
  const before = await c.journal();
  assert.equal(before.withdrawals[0].receipt_id, committedReceipt);
  assert.deepEqual(c.store.pendingWithdrawals(c.link.id.workspace), [c.event]);
  const confirmed = await c.link.confirmMaterialWithdrawal(c.event);
  assert.deepEqual(confirmed, { workspace: c.link.id.workspace, event: c.event.id, receipt: committedReceipt });
  assert.deepEqual(await c.journal(), before);
});

test('a held workspace head produces a finite transport failure, cleans its connection, and allows a clean exact retry', async (t) => {
  const c = await context(t);
  const connections = await c.appConnections();
  const before = await c.journal();
  await c.admin.query('BEGIN');
  const started = performance.now();
  try {
    const locked = await c.admin.query('SELECT workspace_id FROM app.ledger_heads WHERE workspace_id=$1 FOR UPDATE', [c.link.id.workspace]);
    assert.equal(locked.rows.length, 1);
    await assert.rejects(c.link.confirmMaterialWithdrawal(c.event), error => error instanceof Error &&
      /lock timeout|deadline|terminated|timeout/i.test(error.message) && !(error instanceof CoreRefusal && error.reason === 'conflict'));
    assert.ok(performance.now() - started < 12_000, 'native limits and the absolute deadline bound the failure');
  } finally { await c.admin.query('ROLLBACK'); }
  assert.deepEqual(await c.journal(), before);
  assert.equal(await c.appConnections(), connections);
  assert.deepEqual(c.store.pendingWithdrawals(c.link.id.workspace), [c.event]);
  const confirmed = await c.link.confirmMaterialWithdrawal(c.event);
  assert.equal((await c.journal()).withdrawals[0].receipt_id, confirmed.receipt);
  assert.equal(await c.appConnections(), connections);
});

test('unsafe logging is refused before actor GUCs or transaction work without changing any server setting', async (t) => {
  const c = await context(t);
  const before = await c.journal(), connections = await c.appConnections();
  const original = prototype.query;
  const statements: string[] = [];
  let inspected = false;
  t.mock.method(prototype, 'query', async function(this: pg.Client, ...args: unknown[]) {
    const sql = textOf(args[0]); statements.push(sql);
    const result = await Reflect.apply(original, this, args);
    if (sql === LOG_POLICY_QUERY) {
      inspected = true;
      return { ...result, rows: [{ ...result.rows[0], parameters: '64' }] };
    }
    return result;
  });
  try {
    await assert.rejects(c.link.confirmMaterialWithdrawal(c.event), /before sending credentials/);
  } finally { t.mock.restoreAll(); }
  assert.equal(inspected, true);
  assert.ok(statements.includes(LOG_POLICY_QUERY));
  assert.equal(statements.some(sql => sql.includes("set_config('backbone.")), false);
  assert.equal(statements.some(sql => /^BEGIN\b/.test(sql)), false);
  assert.equal(statements.some(sql => sql.includes('gov.withdraw_material_source')), false);
  assert.deepEqual(await c.journal(), before);
  assert.equal(await c.appConnections(), connections);
});
