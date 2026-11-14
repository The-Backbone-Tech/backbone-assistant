import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; native SQL deadlines are asserted separately.
// The transport against real SQL: credentials, roles, fences and identity. Run it with `test:sql-v08:sql`.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { crossingDoor, openSqlV08PersonalRuntime } from '../src/authority/sql-v08/transport.ts';
import { identityMint } from '../src/authority/sql-v08/session-owner.ts';
import { transaction } from '../src/authority/sql-v08/session.ts';
import type { AuthenticatedPersonalSession, ContractTerms, RunHandle, SqlOutcome,
  SqlV08PersonalRuntime } from '../src/authority/sql-v08/types.ts';
import { bootstrapWorkspace as provision, crossingRows, startV08Cluster, type V08Cluster } from './sql-v08-cluster.ts';

const connectionLimits = { connectionTimeoutMillis: 2_000, query_timeout: 5_000,
  statement_timeout: 4_000, lock_timeout: 2_000, idle_in_transaction_session_timeout: 5_000 };
let cluster: V08Cluster; let app: pg.Pool; let observer: pg.Pool; let fixture: pg.Client;
const extraPools: pg.Pool[] = [];
const fixtureQuery = (sql: string, params: unknown[] = []) => fixture.query(sql, params);
function committed<T>(outcome: SqlOutcome<T>): T {
  assert.equal(outcome.status, 'committed', JSON.stringify(outcome));
  if (outcome.status !== 'committed') throw new Error('expected committed SQL outcome');
  return outcome.value;
}
function denied(outcome: SqlOutcome<unknown>) { assert.equal(outcome.status, 'denied'); }

before(async () => {
  cluster = await startV08Cluster();
  app = new pg.Pool({ ...connectionLimits, connectionString: cluster.appUrl, max: 1 });
  observer = new pg.Pool({ ...connectionLimits, connectionString: cluster.observerUrl, max: 1 });
  fixture = new pg.Client({ ...connectionLimits, connectionString: cluster.adminUrl });
  await fixture.connect();
}, { timeout: TEST_HANG_MS * 2 });
after(async () => {
  await Promise.allSettled([app?.end(), observer?.end(), fixture?.end(), ...extraPools.map(p => p.end())]);
  await cluster?.stop();
}, { timeout: TEST_HANG_MS * 2 });

const bootstrapWorkspace = (name: string) => provision(cluster.adminUrl, name);

/** These are synthetic test identities. The callback below is NOT human authentication. */
async function make() {
  const w = await bootstrapWorkspace('Transport fixture');
  await fixtureQuery('BEGIN');
  await fixtureQuery("SELECT set_config('app.workspace_id',$1,true)", [w.workspaceId]);
  await fixtureQuery('SET LOCAL ROLE planes_identity');
  const token = (await fixtureQuery('SELECT gov.authenticate_person($1::uuid) AS value', [w.ownerId])).rows[0]?.value as string;
  await fixtureQuery('COMMIT');
  const binding = { workspaceId: w.workspaceId, personId: w.ownerId, accountId: w.workspaceId };
  let current: AuthenticatedPersonalSession = { status: 'authenticated', ...binding, personToken: token };
  const sessions = { current: async () => current };
  const opened = await openSqlV08PersonalRuntime({ appPool: app, observerPool: observer, binding, sessions });
  assert.equal(opened.status, 'ready');
  if (opened.status !== 'ready') throw new Error('fixture transport unavailable');
  const runtime: SqlV08PersonalRuntime = opened.runtime;
  const ctx = { workspaceId: w.workspaceId, personId: w.ownerId, personToken: token };
  const provisioned = committed(await transaction(app, 'app', ctx, async c => {
    const plane = (await c.query("SELECT gov.create_plane('Synthetic',NULL::uuid,NULL::uuid[],false) AS value")).rows[0]?.value as string;
    const task = (await c.query("SELECT gov.create_task($1::uuid,'Synthetic task specification') AS value", [plane])).rows[0]?.value as string;
    return { plane, task };
  }));
  const terms: ContractTerms = { purpose: provisioned.task, data: ['synthetic-input'], tools: ['synthetic.read'],
    destinations: ['scratch.draft'], models: ['synthetic-model'], budget: 10, ceiling: 2,
    ttlMs: 120_000, checker: false };
  committed(await runtime.person.formContract(provisioned.plane, terms));
  const start = async () => committed(await runtime.person.admitRun(provisioned));
  const observe = async (h: RunHandle) => committed(await runtime.observer.observeExecution(h,
    { model: 'synthetic-model', pin: 'synthetic-model', family: 'synthetic-family', provider: 'synthetic',
      region: 'local', harness: 'a'.repeat(64) }));
  const handle = await start();
  const execution = await observe(handle);
  assert.equal(typeof execution, 'string');
  return { ...binding, ...provisioned, runtime, terms, ctx, handle, execution: execution!, start, observe,
    sessions, setSession: (next: AuthenticatedPersonalSession) => { current = next; }, token };
}

test('control: explicit contract/admission, observation, scratch read-your-write and lease', { timeout: TEST_HANG_MS * 2 }, async () => {
  const f = await make();
  committed(await f.runtime.run(f.handle).writeContent({ key: 'draft.txt', bytes: Buffer.from('synthetic draft'), execution: f.execution }));
  const read = committed(await f.runtime.run(f.handle).readContent('draft.txt'));
  assert.equal(Buffer.from(read!.bytes).toString(), 'synthetic draft');
  assert.equal(read!.execution, f.execution);
  assert.equal(typeof committed(await f.runtime.observer.issueOutboundLease(f.handle)), 'string');
});

test('wrong account/person/workspace preconditions and a forged SQL person session fail closed', { timeout: TEST_HANG_MS * 2 }, async () => {
  const f = await make();
  for (const changed of [{ accountId: 'wrong' }, { personId: f.handle.run }, { workspaceId: f.handle.run }]) {
    const opened = await openSqlV08PersonalRuntime({ appPool: app, observerPool: observer, binding: f,
      sessions: { current: async () => ({ status: 'authenticated', ...f, personToken: f.token, ...changed }) } });
    assert.equal(opened.status, 'dependency');
  }
  const forged = await openSqlV08PersonalRuntime({ appPool: app, observerPool: observer, binding: f,
    sessions: { current: async () => ({ status: 'authenticated', ...f, personToken: 'wrong-person-session' }) } });
  assert.equal(forged.status, 'dependency');
  const other = await make();
  denied(await other.runtime.run(f.handle).readContent('draft.txt'));
  denied(await other.runtime.observer.issueOutboundLease(f.handle));
  denied(await other.runtime.person.admitRun({ plane: f.plane, task: f.task }));
  // A real second SQL person in the same workspace is authenticated but is not this plane's owner.
  const personId = committed(await transaction(app, 'app', f.ctx, async c =>
    (await c.query("SELECT gov.add_person('Synthetic other owner','member',false) AS value")).rows[0]?.value as string));
  await fixtureQuery('BEGIN');
  await fixtureQuery("SELECT set_config('app.workspace_id',$1,true)", [f.workspaceId]);
  await fixtureQuery('SET LOCAL ROLE planes_identity');
  const personToken = (await fixtureQuery('SELECT gov.authenticate_person($1::uuid) AS value', [personId])).rows[0]?.value as string;
  await fixtureQuery('COMMIT');
  const sameWorkspace = { workspaceId: f.workspaceId, personId, accountId: f.accountId };
  const wrongPerson = await openSqlV08PersonalRuntime({ appPool: app, observerPool: observer, binding: sameWorkspace,
    sessions: { current: async () => ({ status: 'authenticated', ...sameWorkspace, personToken }) } });
  assert.equal(wrongPerson.status, 'ready');
  if (wrongPerson.status === 'ready') {
    denied(await wrongPerson.runtime.person.formContract(f.plane, f.terms));
    denied(await wrongPerson.runtime.person.admitRun({ plane: f.plane, task: f.task }));
    denied(await wrongPerson.runtime.person.cancel(f.handle.run));
  }
});

test('SQL rejects wrong secret, stale fence, foreign execution; absent handles fail before dispatch', { timeout: TEST_HANG_MS * 2 }, async () => {
  const f = await make(); const otherRun = await f.start(); const otherExecution = await f.observe(otherRun);
  assert.equal(typeof otherExecution, 'string');
  for (const h of [{ ...f.handle, secret: 'wrong' }, { ...f.handle, fence: f.handle.fence + 1 }]) {
    denied(await f.runtime.run(h).writeContent({ key: 'd', bytes: Buffer.from('x'), execution: f.execution }));
    denied(await f.runtime.run(h).readContent('d'));
    denied(await f.runtime.observer.issueOutboundLease(h));
    denied(await f.runtime.observer.observeExecution(h, { model: 'synthetic-model', pin: 'p', family: 'f',
      provider: 'p', region: 'local', harness: 'h' }));
  }
  denied(await f.runtime.run(f.handle).writeContent({ key: 'd', bytes: Buffer.from('x'), execution: otherExecution! }));
  denied(await f.runtime.observer.issueOutboundLease({ ...f.handle, secret: '' }));
  const strictNull = await transaction(observer, 'observer', {
    workspaceId: f.workspaceId, run: f.handle.run, fence: f.handle.fence, secret: f.handle.secret,
  }, async c => (await c.query('SELECT gov.issue_outbound_lease($1::uuid,$2::bigint,$3::text) AS value',
    [f.handle.run, f.handle.fence, null])).rows[0]?.value);
  assert.equal(committed(strictNull), null, 'fixed strict overload must not choose the secret-free function');
  const strictObservationNull = await transaction(observer, 'observer', {
    workspaceId: f.workspaceId, run: f.handle.run, fence: f.handle.fence, secret: f.handle.secret,
  }, async c => (await c.query(`SELECT gov.observe_execution($1::uuid,$2::bigint,
    'synthetic-model'::text,'pin'::text,'family'::text,'provider'::text,'local'::text,'harness'::text,$3::text) AS value`,
  [f.handle.run, f.handle.fence, null])).rows[0]?.value);
  assert.equal(committed(strictObservationNull), null);
  const reclaimed = committed(await f.runtime.person.reclaim(f.handle.run));
  assert.ok(reclaimed.fence > f.handle.fence);
  denied(await f.runtime.run(f.handle).writeContent({ key: 'd', bytes: Buffer.from('x'), execution: f.execution }));
  denied(await f.runtime.observer.issueOutboundLease(f.handle));
  committed(await f.runtime.run(reclaimed).writeContent({ key: 'd', bytes: Buffer.from('current'), execution: f.execution }));
});

test('expired SQL person session prevents owner control; account switch blocks the existing person port', { timeout: TEST_HANG_MS * 2 }, async () => {
  const f = await make();
  await fixtureQuery("UPDATE ops.person_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND person_id=$2",
    [f.workspaceId, f.personId]);
  denied(await f.runtime.person.admitRun({ plane: f.plane, task: f.task }));
  denied(await f.runtime.person.cancel(f.handle.run));
  const g = await make();
  g.setSession({ status: 'authenticated', ...g, personToken: g.token, accountId: 'switched-account' });
  denied(await g.runtime.person.admitRun({ plane: g.plane, task: g.task }));
});

test('revocation, owner deactivation, contract expiry, cancel and erase fence the next SQL use', { timeout: TEST_HANG_MS * 2 }, async () => {
  for (const change of ['revoke', 'deactivate', 'expire', 'cancel', 'erase']) {
    const f = await make();
    if (change === 'revoke') committed(await f.runtime.person.revokeContract(f.plane));
    if (change === 'cancel') committed(await f.runtime.person.cancel(f.handle.run));
    if (change === 'erase') committed(await f.runtime.person.erase(f.handle.run));
    if (change === 'deactivate') committed(await transaction(app, 'app', f.ctx, async c => {
      await c.query('SELECT gov.deactivate_principal($1::uuid,false)', [f.personId]);
    }));
    if (change === 'expire') {
      committed(await f.runtime.person.formContract(f.plane, { ...f.terms, ttlMs: 5 }));
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    denied(await f.runtime.run(f.handle).writeContent({ key: 'd', bytes: Buffer.from('x'), execution: f.execution }));
    denied(await f.runtime.run(f.handle).readContent('d'));
    denied(await f.runtime.observer.issueOutboundLease(f.handle));
  }
});

test('pooled context contamination is masked and scrubbed; an absent person token is never inherited', { timeout: TEST_HANG_MS * 2 }, async () => {
  const f = await make(); const c = await app.connect();
  const names = ['workspace_id', 'principal_id', 'person_token', 'app_token', 'run_id', 'run_token', 'run_fence'];
  try {
    for (const [i, name] of names.entries()) await c.query("SELECT set_config($1,$2,false)",
      [`app.${name}`, [f.workspaceId, f.personId, f.token, 'stale-app', f.handle.run, f.handle.secret, '1'][i]]);
  } finally { c.release(); }
  committed(await f.runtime.run(f.handle).writeContent({ key: 'd', bytes: Buffer.from('x'), execution: f.execution }));
  const check = await app.connect();
  try {
    for (const name of names) assert.equal((await check.query('SELECT current_setting($1,true) AS value', [`app.${name}`])).rows[0]?.value, '');
  } finally { check.release(); }
  const noToken = await transaction(app, 'app', { workspaceId: f.workspaceId, personId: f.personId }, async c =>
    (await c.query('SELECT sec.effective_principal() AS value')).rows[0]?.value);
  assert.equal(committed(noToken), null);
});

test('the door cannot make a person, and a login that holds both the door and identity is refused', { timeout: TEST_HANG_MS * 2 }, async () => {
  const f = await make();
  denied(await transaction(observer, 'observer', { workspaceId: f.workspaceId }, async c => {
    await c.query('SELECT gov.authenticate_person($1::uuid)', [f.personId]);
  }));
  const identity = new pg.Pool({ ...connectionLimits, connectionString: cluster.identityUrl, max: 1 });
  extraPools.push(identity);
  const binding = { workspaceId: f.workspaceId, personId: f.personId, accountId: f.accountId };
  assert.equal(typeof (await identityMint(identity, binding)()), 'string');
  assert.equal(await identityMint(observer, binding)(), null, 'the door login is not identity');
  await fixtureQuery("CREATE ROLE v08_both LOGIN NOINHERIT PASSWORD 'both'");
  await fixtureQuery('GRANT planes_observer, planes_identity TO v08_both');
  const url = new URL(cluster.observerUrl); url.username = 'v08_both'; url.password = 'both';
  const both = new pg.Pool({ ...connectionLimits, connectionString: url.href, max: 1 });
  extraPools.push(both);
  assert.deepEqual(await transaction(both, 'observer', { workspaceId: f.workspaceId }, async c => c.query('SELECT 1')), { status: 'unavailable', reason: 'credential-role' });
  assert.equal(await identityMint(both, binding)(), null);
});

test('an irreversible effect is held, and an accepted row must name its target at begin', { timeout: TEST_HANG_MS * 2 }, async () => {
  const f = await make();
  const propose = async (key: string) => {
    const made = { class: 'irreversible', tool: 'synthetic.read', operation: 'scratch.draft', target: key.repeat(64), args: 'b'.repeat(64), key: key.repeat(64), cost: 1 } as const;
    const id = committed(await f.runtime.door.attempt(f.handle, made));
    assert.equal(committed(await f.runtime.door.attempts(f.handle.run)).find(a => a.id === id)?.status, 'held');
    assert.equal(committed(await f.runtime.door.attempts(f.handle.run)).find(a => a.id === id)?.class, 'irreversible');
    assert.deepEqual(await f.runtime.door.claim(id, 5_000), { status: 'denied', code: '55006' });
    committed(await transaction(app, 'app', f.ctx, async c => { await c.query('SELECT gov.accept_attempt($1::uuid,$2::text,$3::text)', [id, made.target, made.args]); }));
    return { id, made, claim: committed(await f.runtime.door.claim(id, 5_000))! };
  };
  const wrong = await propose('c');
  assert.equal(committed(await f.runtime.door.begin(wrong.id, wrong.claim, wrong.made.args, 'e'.repeat(64))), false);
  assert.equal(committed(await f.runtime.door.attempts(f.handle.run)).find(a => a.id === wrong.id)?.status, 'denied');
  const right = await propose('d');
  assert.equal(committed(await f.runtime.door.begin(right.id, right.claim, right.made.args, right.made.target)), true);
});

test('only the door records a first unknown: the record holds, and a settled one refuses', { timeout: TEST_HANG_MS * 2 }, async () => {
  const f = await make();
  const checker = await f.start();
  const { intent, snapshot } = await crossingRows(cluster.adminUrl, { workspaceId: f.workspaceId, run: f.handle.run, checkerRun: checker.run });
  denied(await transaction(app, 'app', f.ctx, async c => { await c.query('SELECT gov.record_unknown_crossing($1::uuid,$2::uuid,1)', [intent, snapshot]); }));
  await crossingDoor(f.runtime.door).recordUnknown(intent, snapshot, 1);
  await crossingDoor(f.runtime.door).recordUnknown(intent, snapshot, 1);
  assert.deepEqual(committed(await f.runtime.door.crossingRecords()).filter(r => r.snapshot === snapshot).map(r => r.disposition), ['outcome-unknown']);
  // The checker lives, so the owner cannot speak for it.
  assert.deepEqual(await f.runtime.person.reconcilePromotionAsOwner(intent, snapshot, 'execution-error', 'c'.repeat(64)), { status: 'denied', code: '23514' });
  denied(await f.runtime.run(checker).reconcilePromotion(intent, snapshot, 'approved-executed'));
  assert.equal(committed(await f.runtime.run(checker).reconcilePromotion(intent, snapshot, 'execution-error')), 'execution-error');
  await assert.rejects(crossingDoor(f.runtime.door).recordUnknown(intent, snapshot, 1), /could not record/);
  assert.deepEqual(await f.runtime.door.recordUnknownCrossing(intent, snapshot, 1), { status: 'denied', code: '23514' });
});

test('app credentials cannot call observer-only functions; installer credentials cannot open transport', { timeout: TEST_HANG_MS * 2 }, async () => {
  const f = await make();
  for (const sql of [
    'SELECT gov.authenticate_person($1::uuid)',
    'SELECT gov.observe_execution($1::uuid,1,\'m\',\'p\',\'f\',\'p\',\'eu\',\'h\',\'secret\')',
    'SELECT gov.issue_outbound_lease($1::uuid,1,\'secret\')',
  ]) denied(await transaction(app, 'app', f.ctx, async c => { await c.query(sql, [f.personId]); }));
  const wrongObserver = new pg.Pool({ ...connectionLimits, connectionString: cluster.appUrl, max: 1 });
  const installer = new pg.Pool({ ...connectionLimits, connectionString: cluster.adminUrl, max: 1 });
  extraPools.push(wrongObserver, installer);
  const o = await openSqlV08PersonalRuntime({ appPool: app, observerPool: wrongObserver, binding: f, sessions: f.sessions });
  assert.equal(o.status, 'ready');
  if (o.status === 'ready') denied(await o.runtime.observer.issueOutboundLease(f.handle));
  const a = await openSqlV08PersonalRuntime({ appPool: installer, observerPool: observer, binding: f, sessions: f.sessions });
  assert.equal(a.status, 'unavailable');
});
