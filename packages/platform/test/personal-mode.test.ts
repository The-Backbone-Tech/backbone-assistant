import { waitFor } from '../../../scripts/lib/test-hang.ts';
import { hangDetector } from '../../../scripts/lib/test-hang.ts';
// Personal mode booted from nothing, as a person's first launch does it. Every other platform test
// borrows a database from the run's shared cluster (helpers.ts, so one machine's 32 shared-memory
// segments are not spent one per test); this file does not, so the production path stays covered:
// initdb and the baseline in the home, a server of its own that stops with the host, a restart that
// finds what the first run made, and a server a killed process left behind being reused and then
// stopped when the home is removed.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { dataHomeAdminUrl } from '@backbone/core/testing';
import { buildBaseline, upgradeSignatureLedger, verifySignatureLedger, verifyIdentityRuntime, openPersonalDatabase, type ClusterPasswords } from '@backbone/core/db';
import { CoreLink } from '../src/composition/core.ts';
import { createHost, removeDataHome } from '../src/composition/host.ts';
import { plaintextKeys } from '../src/keys/vault.ts';
import { homeSecrets } from '../src/testing/keys.ts';

// C1 and its hardening are ordered, append-only steps; owned open must record every one.
const identityVersions=['identity-v1','identity-work-v1','identity-role-revocation-v1','identity-resource-guard-v1','identity-admission-closure-v1','identity-guarantees-v1','identity-platform-v1','identity-role-closure-v1','identity-piece-admission-v1','identity-lookup-closure-v1','identity-invitation-closure-v1','identity-device-recovery-v1','identity-device-lockout-v1','identity-device-subject-v1','identity-native-turn-v1','identity-device-current-v1'];
const home = mkdtempSync(join(tmpdir(), 'backbone-personal-'));
after(() => removeDataHome(home));

const server = () => Number(readFileSync(join(home, 'pg', 'data', 'postmaster.pid'), 'utf8').split('\n')[0]);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const gone = async (pid: number) => {
  await waitFor(()=>!alive(pid),'PostgreSQL process exit',{diagnostic:()=>`pid=${pid}; alive=${alive(pid)}`});
  return !alive(pid);
};
const projects = async (host: ReturnType<typeof createHost>) => (await host.call('projects.list', {})).map((p) => p.name);

test('a first launch makes the home its own cluster with the baseline, and closing the host stops it', async () => {
  // A test home: its vault is plaintext by this explicit choice, so the killed child below opens it
  // too (the app's Keychain-held homes are keys.test.ts's).
  const host = createHost({ home, keys: plaintextKeys() });
  // Close even when an assertion fails, so the next case is not refused a home still held by this one.
  let pid = 0;
  try {
  const made = await host.call('projects.create', { name: 'First', kind: 'folder' });
  assert.ok(made.ok, 'the core answered');
  assert.ok(existsSync(join(home, 'pg', 'data', 'PG_VERSION')), 'initdb ran in the home');
  assert.ok(!existsSync(join(home, 'pg', 'external.json')), 'the home borrows no database');
  pid = server();
  assert.ok(alive(pid), 'its server is running');
  const admin = new pg.Client({ connectionString: dataHomeAdminUrl(home, (await homeSecrets(home)).passwords) });
  await admin.connect();
  try {
    // A fresh home holds the baseline, source guard, material journal and insertion enforcement, verified on open.
    const { rows } = await admin.query('SELECT current_database() AS db, (SELECT array_agg(version ORDER BY applied_at, version) FROM ops.schema_migrations) AS history');
    assert.deepEqual(rows, [{ db: 'backbone', history: ['baseline', 'material-source-guard-v1', 'material-source-link-v1', 'material-source-enforcement-v1', 'connector-signature-ledger-v1', 'material-closure-foundation-v1', 'material-closure-hardening-v1', ...identityVersions] }]);
    assert.equal((await verifyIdentityRuntime(admin)).state, 'verified');
    // Owned open installed the signature step; repeating its installer stays idempotent.
    assert.equal((await verifySignatureLedger(admin)).state, 'verified');
    const installed = await upgradeSignatureLedger(admin, buildBaseline().sql);
    assert.equal(installed.state, 'verified', installed.reason);
    assert.equal((await verifySignatureLedger(admin)).state, 'verified');
    assert.deepEqual((await admin.query('SELECT version FROM ops.schema_migrations ORDER BY applied_at,version')).rows.map(r => r.version),
      ['baseline','material-source-guard-v1','material-source-link-v1','material-source-enforcement-v1','connector-signature-ledger-v1', 'material-closure-foundation-v1', 'material-closure-hardening-v1', ...identityVersions]);
  } finally {
    await admin.end();
  }
  } finally {
    host.close();
    await CoreLink.whenClosed(home);
  }
  assert.ok(await gone(pid), 'closing the host stopped the server it started');
});

test('a second launch starts a server again and finds what the first made', async () => {
  const host = createHost({ home });
  assert.deepEqual(await projects(host), ['First']);
  assert.ok(alive(server()));
  host.close();
  await CoreLink.whenClosed(home);
});

test('concurrent opens repair old local role settings without losing the existing home', async () => {
  const host = createHost({ home });
  assert.deepEqual(await projects(host), ['First']);
  const admin = new pg.Client({ connectionString: dataHomeAdminUrl(home, (await homeSecrets(home)).passwords) });
  await admin.connect();
  try {
    await admin.query('ALTER ROLE backbone_app RESET log_parameter_max_length; ALTER ROLE backbone_operator RESET log_parameter_max_length');
    const links = await Promise.all([CoreLink.open({ home }), CoreLink.open({ home })]);
    try {
      const { rows } = await admin.query(`SELECT r.rolname, s.setconfig FROM pg_roles r
        JOIN pg_db_role_setting s ON s.setrole = r.oid AND s.setdatabase = 0
        WHERE r.rolname IN ('backbone_app', 'backbone_operator') ORDER BY r.rolname`);
      assert.equal(rows.length, 2);
      for (const row of rows) assert.ok(row.setconfig.includes('log_parameter_max_length=0'));
    } finally { await Promise.all(links.map(link => link.release())); }
  } finally { await admin.end(); host.close(); await CoreLink.whenClosed(home); }
});

test('a server a killed process left behind is reused, and removing the home stops it', async () => {
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./crash-personal.ts', import.meta.url)), home], { encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  const left = server();
  assert.ok(alive(left), 'the kill left the home\'s server running');
  const host = createHost({ home });
  assert.deepEqual((await projects(host)).sort(), ['First', 'Left running']);
  assert.equal(server(), left, 'the same server, not a second one');
  host.close();
  await CoreLink.whenClosed(home);
  assert.ok(await gone(left), 'closing stopped the server it found, too');
});

test('cleanup returns when a locally started server already died from a signal', async () => {
  const other = mkdtempSync(join(tmpdir(), 'backbone-signalled-'));
  let saved: ClusterPasswords | null = null;
  let segmentId: string | undefined; let serverPid: number | undefined;
  const keeper = { read: async () => saved, write: async (p: ClusterPasswords) => { saved = p; } };
  try {
    const db = await openPersonalDatabase({ dir: join(other, 'pg'), baselineSql: buildBaseline().sql, passwords: keeper });
    const pidFile = readFileSync(join(other, 'pg', 'data', 'postmaster.pid'), 'utf8').split('\n');
    serverPid = Number(pidFile[0]);
    assert.ok(Number.isSafeInteger(serverPid) && serverPid > 0, 'the test server has a valid PID');
    if (process.platform === 'darwin') {
      segmentId = pidFile[6]?.trim().split(/\s+/)[1];
      assert.match(segmentId ?? '', /^\d+$/, 'the test server identifies its shared-memory segment');
    }
    process.kill(serverPid, 'SIGKILL');
    assert.ok(await gone(serverPid), 'server exited from the signal');
    await hangDetector(db.stopIfStarted(),'stopIfStarted after real server SIGKILL',{diagnostic:()=>`server pid=${serverPid}`});
  } finally {
    try {
      if (segmentId) {
        const lines = execFileSync('ipcs', ['-m', '-a'], { encoding: 'utf8' }).split('\n');
        const header = lines.find(line => /^T\s+ID\s+KEY/.test(line))?.trim().split(/\s+/);
        assert.ok(header, 'shared-memory inventory is available');
        const row = lines.map(line => line.trim().split(/\s+/)).find(cols => cols[0] === 'm' && cols[header.indexOf('ID')] === segmentId);
        if (row) {
          assert.equal(row[header.indexOf('OWNER')], userInfo().username, 'remove only our own segment');
          assert.equal(Number(row[header.indexOf('CPID')]), serverPid, 'remove only the test server segment');
          assert.equal(Number(row[header.indexOf('NATTCH')]), 0, 'never remove an attached segment');
          assert.ok(serverPid && !alive(serverPid), 'never remove memory from a live creator');
          execFileSync('ipcrm', ['-m', segmentId]);
        }
        const remaining = execFileSync('ipcs', ['-m'], { encoding: 'utf8' }).split('\n')
          .some(line => { const cols = line.trim().split(/\s+/); return cols[0] === 'm' && cols[1] === segmentId; });
        assert.equal(remaining, false, 'the killed server left no shared-memory segment');
      }
    } finally { await removeDataHome(other); }
  }
});
