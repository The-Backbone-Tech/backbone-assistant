import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openSqlV08PersonalRuntime } from '../src/authority/sql-v08/transport.ts';
import type { AuthenticatedPersonalSession, SqlPool } from '../src/authority/sql-v08/types.ts';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const personId = '00000000-0000-4000-8000-000000000002';
const artifactId = '00000000-0000-4000-8000-000000000003';
const binding = { workspaceId, personId, accountId: 'synthetic-account' };
const readSql = 'SELECT gov.read_landing($1::uuid) AS value';

function fixture() {
  const calls: { sql: string; values: unknown[] }[] = [];
  const releases: (Error | undefined)[] = [];
  const facts: Record<string, unknown> = {
    login_role: 'backbone_app', effective_role: 'backbone_app', login_can_login: true, effective_can_login: true,
  };
  for (const subject of ['login', 'effective']) {
    for (const flag of ['rolsuper', 'rolbypassrls', 'rolcreaterole', 'rolcreatedb', 'rolreplication']) {
      facts[`${subject}_${flag}`] = false;
    }
    for (const role of ['backbone_owner', 'backbone_gov', 'backbone_app', 'planes_observer', 'planes_identity']) {
      facts[`${subject}_${role}`] = role === 'backbone_app';
    }
  }
  let connects = 0;
  let value: unknown = null;
  let fault: ((sql: string) => unknown) | undefined;
  let identity: AuthenticatedPersonalSession | { status: 'required' } = {
    status: 'authenticated', ...binding, personToken: 'synthetic-person-token',
  };
  let ownerError = false;
  const app: SqlPool = { connect: async () => {
    connects++;
    return {
      query: async (sql, values = []) => {
        calls.push({ sql, values });
        const error = fault?.(sql); if (error) throw error;
        if (sql.includes("current_setting('log_parameter_max_length')")) return { rows: [{ parameters: '0', errors: '0', plans: null, plan_duration: null, debug_plan: 'off', audit: null }] };
        if (sql.includes('AS login_role')) return { rows: [{ ...facts }] };
        if (sql === 'SELECT sec.effective_principal() AS value') return { rows: [{ value: personId }] };
        if (sql === readSql) return { rows: [{ value }] };
        if (sql.startsWith('SELECT') && !sql.includes('set_config')) throw new Error('unexpected protected query');
        return { rows: [] };
      },
      release: error => { releases.push(error); },
    };
  } };
  const observer: SqlPool = { connect: async () => { throw new Error('read must never use observer pool'); } };
  const sessions = { current: async () => {
    if (ownerError) throw new Error('synthetic-private-owner-error');
    return identity;
  } };
  return {
    calls, releases, facts, app, observer, sessions,
    connects: () => connects,
    setValue: (next: unknown) => { value = next; },
    setFault: (next: typeof fault) => { fault = next; },
    setIdentity: (next: typeof identity) => { identity = next; },
    setOwnerError: () => { ownerError = true; },
    open: () => openSqlV08PersonalRuntime({ appPool: app, observerPool: observer, binding, sessions }),
  };
}
async function opened() {
  const f = fixture(); const result = await f.open();
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') throw new Error('test setup');
  f.calls.length = 0; f.releases.length = 0;
  return { ...f, runtime: result.runtime };
}

test('explicit artifact read uses only the person transaction, fixed SQL and detached exact files', async () => {
  const f = await opened();
  const payload = [{ path: 'notes/decision.md', bytes: 'aGVsbG8=' }, { path: 'empty', bytes: '' }];
  f.setValue(payload);
  const result = await f.runtime.person.readLanding(artifactId);
  assert.deepEqual(result, { status: 'committed', value: payload });
  if (result.status !== 'committed' || result.value === null) throw new Error('expected files');
  assert.notEqual(result.value, payload);
  assert.notEqual(result.value[0], payload[0]);
  payload[0]!.path = 'mutated'; payload[0]!.bytes = ''; payload.push({ path: 'later', bytes: '' });
  assert.deepEqual(result.value, [{ path: 'notes/decision.md', bytes: 'aGVsbG8=' }, { path: 'empty', bytes: '' }]);
  const protectedCalls = f.calls.filter(c => c.sql.includes('gov.'));
  assert.deepEqual(protectedCalls, [{ sql: readSql, values: [artifactId] }]);
  assert.ok(f.calls.findIndex(c => c.sql === 'BEGIN') < f.calls.findIndex(c => c.sql === readSql));
  assert.ok(f.calls.findIndex(c => c.sql.includes('AS login_role')) < f.calls.findIndex(c => c.sql === readSql));
  assert.ok(f.calls.findIndex(c => c.sql === readSql) < f.calls.findIndex(c => c.sql === 'COMMIT'));
  const context = f.calls.find(c => c.sql.includes("$1, true"));
  assert.deepEqual(context?.values, [workspaceId, personId, 'synthetic-person-token', '', '', '', '']);
  assert.ok(f.calls.at(-1)?.values.every(v => v === ''), 'clear pooled identity after commit');
  assert.equal(f.releases.at(-1), undefined);
});

test('SQL null, empty file list and empty file bytes retain distinct committed values', async () => {
  const f = await opened();
  for (const value of [null, [], [{ path: 'empty.txt', bytes: '' }]]) {
    f.setValue(value);
    assert.deepEqual(await f.runtime.person.readLanding(artifactId), { status: 'committed', value });
  }
});

test('invalid artifact IDs refuse before session lookup or checkout', async () => {
  const f = await opened(); const before = f.connects(); f.setOwnerError();
  for (const invalid of ['', 'latest', `${artifactId}'; DROP TABLE app.artifacts; --`, null, undefined, 1, {}]) {
    assert.deepEqual(await f.runtime.person.readLanding(invalid as string), { status: 'denied', code: 'invalid-input' });
  }
  assert.equal(f.connects(), before); assert.equal(f.calls.length, 0);
});

test('missing or switched account, person, workspace or person token blocks an already-open port', async () => {
  for (const change of [{ accountId: 'other-account' }, { personId: artifactId }, { workspaceId: artifactId },
    { personToken: '' }]) {
    const f = await opened(); const before = f.connects();
    f.setIdentity({ status: 'authenticated', ...binding, personToken: 'synthetic-person-token', ...change });
    assert.deepEqual(await f.runtime.person.readLanding(artifactId), { status: 'denied', code: 'personal-session-required' });
    assert.equal(f.connects(), before); assert.equal(f.calls.length, 0);
  }
  const f = await opened(); const before = f.connects(); f.setIdentity({ status: 'required' });
  assert.deepEqual(await f.runtime.person.readLanding(artifactId), { status: 'denied', code: 'personal-session-required' });
  assert.equal(f.connects(), before);
});

test('session owner failure is redacted and prevents the protected query', async () => {
  const f = await opened(); const before = f.connects(); f.setOwnerError();
  assert.deepEqual(await f.runtime.person.readLanding(artifactId), { status: 'denied', code: 'personal-session-required' });
  assert.equal(f.connects(), before); assert.equal(f.calls.length, 0);
});

test('each call uses the current valid person token rather than the opening token', async () => {
  const f = await opened();
  f.setIdentity({ status: 'authenticated', ...binding, personToken: 'synthetic-rotated-token' });
  await f.runtime.person.readLanding(artifactId);
  assert.equal(f.calls.find(c => c.sql.includes('$1, true'))?.values[2], 'synthetic-rotated-token');
});

test('elevated or mixed login/effective app roles cannot execute the protected read', async () => {
  for (const subject of ['login', 'effective']) {
    for (const field of ['rolsuper', 'rolbypassrls', 'rolcreaterole', 'rolcreatedb', 'rolreplication',
      'backbone_owner', 'backbone_gov', 'planes_observer']) {
      const f = await opened(); f.facts[`${subject}_${field}`] = true;
      assert.deepEqual(await f.runtime.person.readLanding(artifactId), { status: 'unavailable', reason: 'credential-role' });
      assert.equal(f.calls.some(c => c.sql === readSql), false);
      assert.ok(f.calls.some(c => c.sql === 'ROLLBACK'));
    }
  }
  for (const changed of [{ login_role: 'installer' }, { effective_role: 'planes_observer' },
    { login_can_login: false }, { effective_backbone_app: false }]) {
    const f = await opened(); Object.assign(f.facts, changed);
    assert.deepEqual(await f.runtime.person.readLanding(artifactId), { status: 'unavailable', reason: 'credential-role' });
    assert.equal(f.calls.some(c => c.sql === readSql), false);
  }
});

test('SQL permission refusal rolls back and exposes no driver data or credentials', async () => {
  const f = await opened();
  f.setFault(sql => sql === readSql ? { code: '42501', message: 'synthetic-person-token', detail: 'private body',
    query: readSql, parameters: [artifactId] } : undefined);
  assert.deepEqual(await f.runtime.person.readLanding(artifactId), { status: 'denied', code: '42501' });
  assert.equal(f.calls.filter(c => c.sql === readSql).length, 1);
  assert.ok(f.calls.some(c => c.sql === 'ROLLBACK'));
  assert.ok(f.calls.at(-1)?.values.every(v => v === ''));
});

test('malformed SQL results fail closed without committing invented empty content', async () => {
  const f = await opened();
  for (const value of [undefined, false, 0, '', {}, { files: [] }, [null], [[]], [{}],
    [{ path: 3, bytes: '' }], [{ path: 'x', bytes: null }],
    ...['not base64!', 'a', 'YQ', '====', 'AA==='].map(bytes => [{ path: 'x', bytes }])]) {
    f.calls.length = 0; f.setValue(value);
    assert.deepEqual(await f.runtime.person.readLanding(artifactId), { status: 'unavailable', reason: 'database-unavailable' });
    assert.ok(f.calls.some(c => c.sql === 'ROLLBACK'));
    assert.equal(f.calls.some(c => c.sql === 'COMMIT'), false);
    assert.equal(f.calls.filter(c => c.sql === readSql).length, 1);
  }
});

test('base64 payload is preserved exactly including SQL line wrapping and binary bytes', async () => {
  const f = await opened();
  const bytes = Buffer.from(Array.from({ length: 120 }, (_, n) => n)).toString('base64').match(/.{1,76}/g)!.join('\n');
  const value = [{ path: 'binary', bytes }]; f.setValue(value);
  assert.deepEqual(await f.runtime.person.readLanding(artifactId), { status: 'committed', value });
});

test('valid multi-megabyte file reads preserve exact bytes with and without SQL wrapping', async () => {
  const f = await opened();
  const encoded = Buffer.alloc(4 * 1024 * 1024, 0x5a).toString('base64');
  const lines: string[] = [];
  for (let offset = 0; offset < encoded.length; offset += 76) lines.push(encoded.slice(offset, offset + 76));
  for (const bytes of [encoded, lines.join('\n')]) {
    f.calls.length = 0;
    f.setValue([{ path: 'large.bin', mode: '100644', bytes }]);
    const result = await f.runtime.person.readLanding(artifactId);
    assert.equal(result.status, 'committed', `valid ${bytes.length}-character payload must remain readable`);
    if (result.status !== 'committed' || result.value === null) throw new Error('expected large file');
    assert.equal(result.value.length, 1);
    assert.equal(result.value[0]?.path, 'large.bin');
    assert.equal(result.value[0]?.bytes, bytes);
    assert.equal(f.calls.filter(c => c.sql === readSql).length, 1);
    assert.equal(f.calls.some(c => c.sql === 'ROLLBACK'), false);
  }
  // Validation must scan the whole payload and still reject a malformed tail, without truncation.
  for (const bytes of [encoded + '!', encoded + 'A', encoded + '=', encoded.slice(0, -1)]) {
    f.calls.length = 0; f.setValue([{ path: 'large.bin', bytes }]);
    assert.deepEqual(await f.runtime.person.readLanding(artifactId), { status: 'unavailable', reason: 'database-unavailable' });
    assert.ok(f.calls.some(c => c.sql === 'ROLLBACK'));
    assert.equal(f.calls.some(c => c.sql === 'COMMIT'), false);
  }
});

test('caller mutation cannot change a subsequent independently observed SQL result', async () => {
  const f = await opened(); const value = [{ path: 'original', bytes: 'eA==' }]; f.setValue(value);
  const first = await f.runtime.person.readLanding(artifactId);
  if (first.status !== 'committed' || first.value === null) throw new Error('expected files');
  // Whether immutable or mutable, returned objects must not alias the driver's payload.
  try { Object.assign(first.value[0]!, { path: 'tampered', bytes: '' }); } catch { /* readonly result */ }
  try { (first.value as unknown[]).push({ path: 'extra', bytes: '' }); } catch { /* readonly result */ }
  assert.deepEqual(await f.runtime.person.readLanding(artifactId), { status: 'committed', value: [{ path: 'original', bytes: 'eA==' }] });
  assert.equal(f.calls.filter(c => c.sql === readSql).length, 2);
});

test('lost BEGIN response discards the connection without read or retry', async () => {
  const f = await opened(); f.setFault(sql => sql === 'BEGIN' ? new Error('private driver details') : undefined);
  assert.deepEqual(await f.runtime.person.readLanding(artifactId), { status: 'unavailable', reason: 'database-unavailable' });
  assert.equal(f.calls.filter(c => c.sql === 'BEGIN').length, 1);
  assert.equal(f.calls.some(c => c.sql === readSql), false);
  assert.equal(f.calls.at(-1)?.sql, 'BEGIN'); assert.ok(f.releases.at(-1) instanceof Error);
  assert.equal(f.releases.at(-1)?.message, 'sql-v08 connection discarded');
});

test('lost COMMIT response remains UNKNOWN without returning files or retrying', async () => {
  const f = await opened(); f.setValue([{ path: 'private', bytes: 'eA==' }]);
  f.setFault(sql => sql === 'COMMIT' ? new Error('synthetic-person-token private bytes') : undefined);
  assert.deepEqual(await f.runtime.person.readLanding(artifactId), { status: 'unknown', reason: 'transaction-outcome-unknown' });
  assert.equal(f.calls.filter(c => c.sql === readSql).length, 1);
  assert.equal(f.calls.filter(c => c.sql === 'COMMIT').length, 1);
  assert.equal(f.calls.some(c => c.sql === 'ROLLBACK'), false);
  assert.ok(f.releases.at(-1) instanceof Error);
});
