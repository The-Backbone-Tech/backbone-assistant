import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openSqlV08PersonalRuntime } from '../src/authority/sql-v08/transport.ts';
import { transaction } from '../src/authority/sql-v08/session.ts';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const personId = '00000000-0000-4000-8000-000000000002';
const run = '00000000-0000-4000-8000-000000000003';
const execution = '00000000-0000-4000-8000-000000000004';
const handle = { run, fence: 1, secret: 'unit-test-run-secret' };
const binding = { workspaceId, personId, accountId: 'local-installation-account' };
const sessions = { current: async () => ({ status: 'authenticated' as const, ...binding,
  personToken: 'unit-test-person-secret' }) };

function pool(observer = false) {
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const releases: (Error | undefined)[] = [];
  let fault: ((sql: string) => unknown) | undefined;
  let result: unknown;
  let resultSet = false;
  let roleOk = true;
  const roleFacts: Record<string, unknown> = {
    login_role: observer ? 'transport_observer_login' : 'backbone_app',
    effective_role: observer ? 'planes_observer' : 'backbone_app',
    login_can_login: true, effective_can_login: !observer,
  };
  for (const subject of ['login', 'effective']) {
    for (const flag of ['rolsuper', 'rolbypassrls', 'rolcreaterole', 'rolcreatedb', 'rolreplication']) roleFacts[`${subject}_${flag}`] = false;
    for (const role of ['backbone_owner', 'backbone_gov', 'backbone_app', 'planes_observer', 'planes_identity']) {
      roleFacts[`${subject}_${role}`] = observer ? role === 'planes_observer' : role === 'backbone_app';
    }
  }
  return {
    calls, releases,
    setFault: (next: typeof fault) => { fault = next; },
    setResult: (next: unknown) => { result = next; resultSet = true; },
    setRoleOk: (next: boolean) => { roleOk = next; },
    setRoleFacts: (changed: Record<string, unknown>) => { Object.assign(roleFacts, changed); },
    connect: async () => ({
      query: async (sql: string, values: readonly unknown[] = []) => {
        calls.push({ sql, values });
        const error = fault?.(sql); if (error) throw error;
        if (sql.includes("current_setting('log_parameter_max_length')")) return { rows: [{ parameters: '0', errors: '0', plans: null, plan_duration: null, debug_plan: 'off', audit: null }] };
        // Model the original single-row login-only predicate, so the red probe distinguishes the
        // missing effective-role/replication/membership checks from login flags it already checked.
        if (sql.includes('AS role_ok')) return { rows: [{ role_ok: roleOk &&
          ['rolsuper', 'rolbypassrls', 'rolcreaterole', 'rolcreatedb', 'backbone_owner', 'backbone_gov']
            .every(f => roleFacts[`login_${f}`] === false) &&
          (observer ? roleFacts.effective_role === 'planes_observer' && roleFacts.login_role !== 'backbone_app' :
            roleFacts.effective_role === 'backbone_app' && roleFacts.login_role === 'backbone_app' &&
            roleFacts.login_planes_observer === false) }] };
        if (sql.includes('AS login_role')) return { rows: roleOk ? [{ ...roleFacts }] : [] };
        if (sql.includes('sec.effective_principal()')) return { rows: [{ value: personId }] };
        if (sql.includes('gov.admit_run') || sql.includes('gov.control_run')) {
          return { rows: [{ value: { runId: run, fence: 1, secret: handle.secret } }] };
        }
        return { rows: [{ value: resultSet ? result : (observer ? execution : null) }] };
      },
      release: (error?: Error) => { releases.push(error); },
    }),
  };
}

async function opened() {
  const app = pool(); const observer = pool(true);
  const result = await openSqlV08PersonalRuntime({ appPool: app, observerPool: observer, binding, sessions });
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') throw new Error('test setup');
  return { ...result, app, observer };
}

test('missing trusted identity boundary fails closed without connecting', async () => {
  const app = pool(); const observer = pool(true);
  const outcome = await openSqlV08PersonalRuntime({ appPool: app, observerPool: observer, binding });
  assert.deepEqual(outcome, { status: 'dependency', dependency: 'trusted-personal-session-owner' });
  assert.equal(app.calls.length + observer.calls.length, 0);
});

test('wrong authenticated account/person/workspace never reaches SQL', async () => {
  for (const changed of [{ accountId: 'other' }, { personId: run }, { workspaceId: run }]) {
    const app = pool(); const observer = pool(true);
    const result = await openSqlV08PersonalRuntime({ appPool: app, observerPool: observer, binding,
      sessions: { current: async () => ({ status: 'authenticated', ...binding, ...changed, personToken: 'secret' }) } });
    assert.equal(result.status, 'dependency');
    assert.equal(app.calls.length + observer.calls.length, 0);
  }
});

test('every transaction sets all identity GUCs and clears pooled session state after commit', async () => {
  const { runtime, app, observer } = await opened();
  await runtime.person.admitRun({ plane: run, task: execution });
  await runtime.run(handle).writeContent({ key: 'draft.txt', bytes: Buffer.from('draft'), execution });
  await runtime.observer.observeExecution(handle, { model: 'm', pin: 'p', family: 'f', provider: 'p',
    region: 'eu', harness: 'h' });
  for (const p of [app, observer]) {
    const setters = p.calls.filter(c => c.sql.includes("set_config('app.workspace_id'"));
    assert.ok(setters.length > 0);
    for (const c of setters) {
      for (const name of ['workspace_id', 'principal_id', 'person_token', 'app_token', 'run_id', 'run_token', 'run_fence']) {
        assert.ok(c.sql.includes(`app.${name}`), name);
      }
      assert.equal(c.values.length, 7);
    }
    assert.ok(setters.some(c => c.values.every(v => v === '')), 'explicit empty context reset');
  }
  const local = app.calls.filter(c => c.sql.includes("set_config('app.workspace_id'") && c.values[4] === run);
  assert.ok(local.length > 0);
  assert.deepEqual(local[0]!.values, [workspaceId, '', '', '', run, handle.secret, '1']);
  assert.equal(app.calls.at(-1)?.values.every(v => v === ''), true);
});

test('observer calls always select strict full-handle SQL arities', async () => {
  const { runtime, observer } = await opened();
  await runtime.observer.observeExecution(handle, { model: 'm', pin: 'p', family: 'f', provider: 'p',
    region: 'eu', harness: 'h' });
  await runtime.observer.issueOutboundLease(handle);
  const observation = observer.calls.find(c => c.sql.includes('gov.observe_execution'))!;
  const lease = observer.calls.find(c => c.sql.includes('gov.issue_outbound_lease'))!;
  assert.equal(observation.values.length, 9);
  assert.equal(observation.values[8], handle.secret);
  assert.equal(lease.values.length, 3);
  assert.equal(lease.values[2], handle.secret);
});

test('incomplete handle and absent execution cannot select a weaker SQL path', async () => {
  const { runtime, app, observer } = await opened();
  const before = app.calls.length + observer.calls.length;
  for (const bad of [{ ...handle, secret: '' }, { ...handle, secret: undefined }, { ...handle, fence: 0 }]) {
    const h = bad as typeof handle;
    assert.equal((await runtime.observer.issueOutboundLease(h)).status, 'denied');
    assert.equal((await runtime.run(h).writeContent({ key: 'd', bytes: Buffer.from('x'), execution })).status, 'denied');
  }
  assert.equal((await runtime.run(handle).writeContent({ key: 'd', bytes: Buffer.from('x'), execution: '' })).status, 'denied');
  assert.equal(app.calls.length + observer.calls.length, before);
});

test('SQL refusal rolls back, scrubs pooled identity and hides SQL diagnostics', async () => {
  const { runtime, app } = await opened();
  app.setFault(sql => sql.includes('gov.write_content') ? { code: '42501', message: handle.secret,
    detail: 'person-secret', query: 'private bytes' } : undefined);
  const result = await runtime.run(handle).writeContent({ key: 'd', bytes: Buffer.from('private'), execution });
  assert.deepEqual(result, { status: 'denied', code: '42501' });
  assert.equal(JSON.stringify(result).includes(handle.secret), false);
  assert.ok(app.calls.some(c => c.sql === 'ROLLBACK'));
  assert.equal(app.calls.at(-1)?.values.every(v => v === ''), true);
});

test('lost COMMIT is UNKNOWN, never success or automatic retry', async () => {
  const { runtime, app } = await opened();
  app.setFault(sql => sql === 'COMMIT' ? new Error('connection lost with private query') : undefined);
  const before = app.calls.filter(c => c.sql.includes('gov.write_content')).length;
  const outcome = await runtime.run(handle).writeContent({ key: 'd', bytes: Buffer.from('x'), execution });
  assert.deepEqual(outcome, { status: 'unknown', reason: 'transaction-outcome-unknown' });
  assert.equal(app.calls.filter(c => c.sql.includes('gov.write_content')).length - before, 1);
  assert.ok(app.releases.at(-1) instanceof Error);
});

test('post-commit scrub failure destroys connection without changing durable success', async () => {
  const { runtime, app } = await opened();
  let committed = false;
  app.setFault(sql => {
    if (sql === 'COMMIT') committed = true;
    if (committed && sql.includes('set_config')) return new Error('scrub failed');
  });
  const result = await runtime.run(handle).writeContent({ key: 'd', bytes: Buffer.from('x'), execution });
  assert.equal(result.status, 'committed');
  assert.ok(app.releases.at(-1) instanceof Error);
});

test('mutating scratch arguments during connection checkout cannot omit execution binding', async () => {
  const { runtime, app } = await opened();
  const args = { key: 'draft', bytes: Buffer.from('original'), execution };
  const pending = runtime.run(handle).writeContent(args);
  args.key = 'mutated'; args.execution = '';
  args.bytes.fill(0);
  assert.equal((await pending).status, 'committed');
  const write = app.calls.find(c => c.sql.includes('gov.write_content'))!;
  assert.equal(write.values[0], 'draft');
  assert.equal(write.values[3], execution);
  assert.equal(Buffer.from(write.values[1] as Uint8Array).toString(), 'original');
});

test('wrong application or observer credential roles fail before the protected SQL operation', async () => {
  const a = pool(); const o = pool(true); a.setRoleOk(false);
  const opening = await openSqlV08PersonalRuntime({ appPool: a, observerPool: o, binding, sessions });
  assert.deepEqual(opening, { status: 'unavailable', reason: 'credential-role' });
  assert.equal(a.calls.some(c => c.sql.includes('sec.effective_principal()')), false);
  const { runtime, observer } = await opened();
  observer.setRoleOk(false);
  assert.deepEqual(await runtime.observer.issueOutboundLease(handle), { status: 'unavailable', reason: 'credential-role' });
  assert.equal(observer.calls.some(c => c.sql.includes('gov.issue_outbound_lease')), false);
});

test('owner run controls explicitly disable the fixture path', async () => {
  const { runtime, app } = await opened();
  assert.equal((await runtime.person.cancel(run)).status, 'committed');
  assert.equal((await runtime.person.erase(run)).status, 'committed');
  const control = app.calls.filter(c => c.sql.includes('gov.control_run'));
  assert.equal(control.length, 2);
  for (const c of control) assert.ok(c.sql.includes('$2::text,false'));
});

test('contract formation carries explicit finite scopes and TTL without wildcard defaults', async () => {
  const { runtime, app } = await opened(); app.setResult(run);
  const outcome = await runtime.person.formContract(run, { purpose: execution, data: ['input'], tools: ['read'],
    destinations: ['draft'], models: ['model'], budget: 2, ceiling: 2, ttlMs: 1000, checker: false });
  assert.equal(outcome.status, 'committed');
  const q = app.calls.find(c => c.sql.includes('gov.set_contract'))!;
  assert.deepEqual(JSON.parse(q.values[2] as string), { data: ['input'], tools: ['read'], destinations: ['draft'],
    models: ['model'], budget: 2, ceiling: 2 });
  assert.equal(q.values[4], personId); assert.equal(q.values[5], 1000);
});

test('a lifetime the confirmation cannot state exactly is refused before anyone is asked', async () => {
  const { runtime, app } = await opened(); app.setResult(run);
  for (const ttlMs of [1.5, 0, -1, Number.MAX_SAFE_INTEGER + 2]) {
    assert.deepEqual(await runtime.person.formContract(run, { purpose: execution, data: [], tools: [], destinations: [], models: [], budget: 0, ceiling: 1, ttlMs, checker: false }), { status: 'denied', code: 'invalid-input' });
  }
  assert.equal(app.calls.some(c => c.sql.includes('gov.set_contract')), false);
});

test('durable SQL NULL remains committed NULL rather than invented denial or success data', async () => {
  const { runtime, observer } = await opened(); observer.setResult(null);
  assert.deepEqual(await runtime.observer.issueOutboundLease(handle), { status: 'committed', value: null });
});

test('a server-applied BEGIN with a lost response is discarded without exposing an open transaction to reuse', async () => {
  let serverOpen = false; let destroyed = false; let operation = false;
  const calls: string[] = [];
  const outcome = await transaction({ connect: async () => ({
    query: async sql => {
      calls.push(sql);
      if (sql.includes("current_setting('log_parameter_max_length')")) return { rows: [{ parameters: '0', errors: '0', plans: null, plan_duration: null, debug_plan: 'off', audit: null }] };
      if (sql === 'BEGIN') { serverOpen = true; throw new Error('lost BEGIN response'); }
      if (sql === 'ROLLBACK') serverOpen = false;
      return { rows: [] };
    },
    release: error => { destroyed = !!error; assert.ok(!serverOpen || destroyed, 'never reuse a possibly open transaction'); },
  }) }, 'app', { workspaceId }, async () => { operation = true; });
  assert.deepEqual(outcome, { status: 'unavailable', reason: 'database-unavailable' });
  assert.equal(operation, false);
  assert.equal(calls.filter(c => c === 'BEGIN').length, 1, 'no BEGIN retry');
  assert.equal(destroyed, true, 'uncertain BEGIN takes the conservative disposal path');
  assert.equal(calls.at(-1), 'BEGIN', 'do not scrub inside an uncertain transaction');
});

test('unsafe parameter logging refuses before credentials reach PostgreSQL', async () => {
  for (const policy of [
    { parameters: '-1', errors: '0', plans: null, plan_duration: null, debug_plan: 'off', audit: null },
    { parameters: '0', errors: '-1', plans: null, plan_duration: null, debug_plan: 'off', audit: null },
    { parameters: '0', errors: '0', plans: '-1', plan_duration: null, debug_plan: 'off', audit: null },
    { parameters: '0', errors: '0', plans: null, plan_duration: null, debug_plan: 'off', audit: 'on' },
    { parameters: '0', errors: '0', plans: '0', plan_duration: '0', debug_plan: 'off', audit: null },
    { parameters: '0', errors: '0', plans: null, plan_duration: null, debug_plan: 'on', audit: null },
  ]) {
    const queries: string[] = []; let destroyed = false;
    const outcome = await transaction({ connect: async () => ({
      query: async sql => { queries.push(sql); return { rows: [policy] }; },
      release: error => { destroyed = !!error; },
    }) }, 'app', { workspaceId, secret: 'synthetic-sensitive-token' }, async () => { throw new Error('must not run'); });
    assert.deepEqual(outcome, { status: 'unavailable', reason: 'database-unavailable' });
    assert.equal(queries.length, 1, 'no identity settings or transaction were sent');
    assert.equal(destroyed, true);
  }
});

test('login and effective observer privilege flags and forbidden memberships are rejected independently', async () => {
  for (const subject of ['login', 'effective']) {
    for (const field of ['rolsuper', 'rolbypassrls', 'rolcreaterole', 'rolcreatedb', 'rolreplication',
      'backbone_owner', 'backbone_gov', 'backbone_app', 'planes_identity']) {
      const { runtime, observer } = await opened();
      observer.setRoleFacts({ [`${subject}_${field}`]: true });
      const outcome = await runtime.observer.issueOutboundLease(handle);
      assert.deepEqual(outcome, { status: 'unavailable', reason: 'credential-role' }, `${subject}_${field}`);
      assert.equal(observer.calls.some(c => c.sql.includes('gov.issue_outbound_lease')), false);
    }
  }
  for (const subject of ['login', 'effective']) {
    const app = pool(); const observer = pool(true);
    app.setRoleFacts({ [`${subject}_rolreplication`]: true });
    const outcome = await openSqlV08PersonalRuntime({ appPool: app, observerPool: observer, binding, sessions });
    assert.deepEqual(outcome, { status: 'unavailable', reason: 'credential-role' }, `${subject} application replication`);
    assert.equal(app.calls.some(c => c.sql.includes('sec.effective_principal()')), false);
  }
});

test('separate ordinary login and NOLOGIN observer role remain a permitted credential configuration', async () => {
  const { runtime, app, observer } = await opened();
  assert.equal((await runtime.person.admitRun({ plane: run, task: execution })).status, 'committed');
  assert.equal((await runtime.observer.issueOutboundLease(handle)).status, 'committed');
  assert.equal(app.releases.at(-1), undefined);
  assert.equal(observer.releases.at(-1), undefined);
});

const digest = (c: string) => c.repeat(64);
const attempt = { class: 'document' as const, tool: 'workspace', operation: 'write_document', target: digest('a'), args: digest('b'), key: digest('c'), cost: 1 };

test('the door names class, cost and digests on the observer role, with no run secret on the wire', async () => {
  const { runtime, observer, app } = await opened(); observer.setResult(run);
  const before = app.calls.length;
  assert.deepEqual(await runtime.door.attempt(handle, attempt), { status: 'committed', value: run });
  assert.equal(app.calls.length, before, 'the application login never reaches the door');
  const call = observer.calls.find(c => c.sql.includes('gov.attempt_effect'))!;
  assert.deepEqual(call.values, [run, 1, 'document', 'workspace', 'write_document', digest('a'), digest('b'), digest('c'), 1]);
  assert.equal(JSON.stringify(observer.calls).includes(handle.secret), false);
});

test('anything but a digest never reaches the door', async () => {
  const { runtime, observer } = await opened();
  for (const bad of [{ target: 'notes/person.md' }, { args: digest('B') }, { key: '' }, { cost: -1 }, { cost: Number.NaN }, { tool: 'Send To A Person' }, { operation: '' }]) {
    assert.equal((await runtime.door.attempt(handle, { ...attempt, ...bad })).status, 'denied');
  }
  assert.equal((await runtime.door.attempt({ ...handle, fence: 0 }, attempt)).status, 'denied');
  assert.equal((await runtime.door.reconcile(run, 'executed', 'not-a-digest')).status, 'denied');
  assert.equal(observer.calls.some(c => c.sql.includes('attempt_effect') || c.sql.includes('reconcile_attempt')), false);
});

test('a lost COMMIT on begin stays UNKNOWN and is not retried', async () => {
  const { runtime, observer } = await opened();
  observer.setFault(sql => sql === 'COMMIT' ? new Error('lost') : undefined);
  assert.deepEqual(await runtime.door.begin(run, 'claim', digest('b'), digest('a')), { status: 'unknown', reason: 'transaction-outcome-unknown' });
  assert.equal(observer.calls.filter(c => c.sql.includes('gov.begin_attempt')).length, 1);
});

test('a run\'s attempts come back as typed rows and never as the audit export', async () => {
  const { runtime, observer } = await opened();
  observer.setResult([{ id: run, run_id: run, fence: 1, class: 'document', tool: 'workspace', operation: 'write_document', target_sha256: digest('a'), args_sha256: digest('b'), key: digest('c'), cost: 1, status: 'unknown', reconciliation_sha256: null, claim_hash: 'secret-hash' }]);
  const rows = await runtime.door.attempts(run);
  assert.equal(rows.status, 'committed');
  if (rows.status === 'committed') assert.deepEqual(rows.value, [{ id: run, run, fence: 1, class: 'document', tool: 'workspace', operation: 'write_document', target: digest('a'), args: digest('b'), key: digest('c'), cost: 1, status: 'unknown', reconciliation: null }]);
  assert.equal(observer.calls.some(c => c.sql.includes('gov.dump_crossing_rows')), false);
  const read = observer.calls.find(c => c.sql.includes('gov.read_attempts'))!;
  assert.deepEqual(read.values, [run]);
});

test('a task\'s runs come back with only id, status and fence', async () => {
  const { runtime, observer } = await opened();
  observer.setResult([{ id: run, status: 'running', fence: 2 }]);
  assert.deepEqual(await runtime.door.runs(execution), { status: 'committed', value: [{ id: run, status: 'running', fence: 2 }] });
  const read = observer.calls.find(c => c.sql.includes('gov.dump_crossing_rows'))!;
  assert.ok(read.sql.includes("'id'"));
  assert.equal(read.sql.includes('token_hash'), false);
  assert.deepEqual(read.values, [execution]);
});

test('closing a run goes through the door with its fence, and no person', async () => {
  const { runtime, observer, app } = await opened();
  assert.deepEqual(await runtime.door.closeRun(run, 3, 'finished'), { status: 'committed', value: undefined });
  const close = observer.calls.find(c => c.sql.includes('gov.close_run'))!;
  assert.deepEqual(close.values, [run, 3, 'finished']);
  assert.equal(app.calls.some(c => c.sql.includes('gov.close_run')), false);
});
