import { spawnSyncHang, TEST_HANG_MS } from '../../../../scripts/lib/test-hang.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { removeDataHome } from '@backbone-next/platform/composition';
import { putTelemetryEndpoint, putTelemetryHeaders } from '@backbone-next/platform/credentials/telemetry';
import { keychainKeys, Vault } from '@backbone-next/platform/keys';

const main = new URL('../src/main.ts', import.meta.url).pathname;
function diagnose(home: string, env: NodeJS.ProcessEnv) {
  const child = spawnSyncHang(process.execPath, [main, 'doctor', '--home', home, '--json'], { encoding: 'utf8', timeout: TEST_HANG_MS, env });
  assert.equal(child.signal, null, child.stderr);
  const check = JSON.parse(child.stdout).checks.find((item: { name: string }) => item.name === 'telemetry');
  assert.ok(check);
  return check;
}

// Include directories and every file's bytes so creating a vault or a lock is visible too.
const snapshot = (root: string): unknown[] => readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry => [entry.name, entry.isDirectory() ? snapshot(join(root, entry.name)) : readFileSync(join(root, entry.name)).toString('base64')]);

test('doctor reports configured collector headers when only the desktop app has the keys', async () => {
  const home = mkdtempSync(join(tmpdir(), 'backbone-telemetry-doctor-app-'));
  // Fake safeStorage: no system keychain or real account is used.
  const keys = keychainKeys({ isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async text => Buffer.from(`test-wrap:${text}`), decryptStringAsync: async bytes => ({ result: bytes.toString().slice('test-wrap:'.length), shouldReEncrypt: false }) });
  const env = { ...process.env }; delete env.BACKBONE_KEYS;
  try {
    await putTelemetryEndpoint(home, 'https://collector.invalid/v1/traces');
    await putTelemetryHeaders(home, { authorization: 'test-only-collector-header' }, keys);
    const before = snapshot(home), check = diagnose(home, env);
    assert.ok(isDeepStrictEqual(snapshot(home), before), 'doctor must preserve every file and byte');
    assert.equal(check.status, 'ok');
    assert.equal(check.detail, 'on (configuration; 1 collector header(s) stored, not opened; applies on restart)');
  } finally { Vault.forget(home); rmSync(home, { recursive: true, force: true }); }
});

test('doctor leaves a settings-and-header-index folder byte-for-byte unchanged even with plaintext keys selected', () => {
  const home = mkdtempSync(join(tmpdir(), 'backbone-telemetry-doctor-folder-'));
  try {
    mkdirSync(join(home, 'credentials'));
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ telemetry: { endpoint: 'https://collector.invalid/v1/traces' } }));
    writeFileSync(join(home, 'credentials', 'telemetry.json'), JSON.stringify({ authorization: 'cred_00000000-0000-0000-0000-000000000000', 'x-api-key': 'cred_11111111-1111-1111-1111-111111111111' }));
    const before = snapshot(home), check = diagnose(home, { ...process.env, BACKBONE_KEYS: 'plaintext' });
    assert.ok(isDeepStrictEqual(snapshot(home), before), 'doctor must create no vault, keys, lock, database or other file');
    assert.equal(check.status, 'ok');
    assert.equal(check.detail, 'on (configuration; 2 collector header(s) stored, not opened; applies on restart)');
  } finally { Vault.forget(home); rmSync(home, { recursive: true, force: true }); }
});

test('doctor prints content-free off/on/configuration-error classes without contacting the collector', async () => {
  const home = freshDataHome('telemetry-doctor'), marker = 'PRIVATE_DOCTOR_DETAIL_891f';
  const read = () => {
    const child = spawnSyncHang(process.execPath, [main, 'doctor', '--home', home, '--json'], { encoding: 'utf8', timeout: TEST_HANG_MS, env: { ...process.env, BACKBONE_KEYS: 'plaintext' } });
    assert.equal(child.signal, null, child.stderr);
    assert.ok(!child.stdout.includes(marker) && !child.stderr.includes(marker));
    const check = JSON.parse(child.stdout).checks.find((item: { name: string }) => item.name === 'telemetry');
    assert.ok(check); return check;
  };
  try {
    assert.match(read().detail, /^off /);
    await putTelemetryEndpoint(home, 'https://collector.invalid/v1/traces');
    assert.match(read().detail, /^on /); // Configuration only; .invalid is never contacted.
    writeFileSync(join(home, 'settings.json'), marker);
    assert.equal(read().detail, 'misconfigured (settings)');
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ telemetry: { endpoint: 'https://collector.invalid/v1/traces' } }));
    writeFileSync(join(home, 'credentials', 'telemetry.json'), JSON.stringify({ authorization: marker }));
    const check = read(); assert.equal(check.status, 'warn'); assert.equal(check.detail, 'misconfigured (credentials)');
  } finally { await removeDataHome(home); }
});
