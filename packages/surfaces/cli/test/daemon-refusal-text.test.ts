import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { keychainKeys, KeysRefused, plaintextKeys, Vault } from '@backbone-next/platform/keys';
import { chooseKeys, systemKeys } from '@backbone-next/platform/system-keys';
import { withHomeLock } from '@backbone-next/platform/composition/home-lock';
import { prepareDataHome } from '@backbone-next/platform/testing/data-home';
import { memoryKeychain } from '@backbone-next/platform/testing/keys';
import { putTelemetryHeaders } from '@backbone-next/platform/credentials/telemetry';
import { keyRefusalLine, keyRefusalRecovery, lastKeyRefusal, type KeyRefusalKind } from '../src/daemon-key-refusal.ts';
import { FakeSystemStore } from './system-key-fixture.ts';

type Produce = (home: string, store: FakeSystemStore) => unknown | Promise<unknown>;
async function rejectedFrom(produce: Produce, check: (error: KeysRefused, home: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'backbone-real-refusal-')), home = join(root, 'home'), store = new FakeSystemStore();
  try {
    let refused: unknown;
    try { await produce(home, store); } catch (error) { refused = error; }
    assert.ok(refused instanceof KeysRefused, 'the real product operation must refuse with KeysRefused');
    check(refused, home);
  } finally { Vault.forget(home); rmSync(root, { recursive: true, force: true }); }
}
const legacy: Produce = async (home, store) => {
  const vault = await Vault.open(home, plaintextKeys()), master = await vault.masterKey();
  await withHomeLock(home, () => withHomeLock(join(home, 'keys'), async () => {
    writeFileSync(join(home, 'keys', 'master.key'), master, { mode: 0o600 });
    rmSync(join(home, 'keys', 'vault.json'));
  })); Vault.forget(home);
  return chooseKeys(home, {}, store);
};
const missingVault: Produce = async (home, store) => {
  await putTelemetryHeaders(home, { authorization: 'synthetic-test-header' }, plaintextKeys());
  await withHomeLock(home, () => withHomeLock(join(home, 'keys'), async () => { rmSync(join(home, 'keys', 'vault.json')); }));
  Vault.forget(home); return chooseKeys(home, {}, store);
};
const plain = (home: string) => Vault.open(home, plaintextKeys());
const protectedHome = (home: string, store: FakeSystemStore) => Vault.open(home, systemKeys(home, store));

// message is the stable scenario title, never an input to an error constructor.
// Each expectedMessage pins the real platform wording; a change there must be reviewed here.
const cases: { code: KeysRefused['code']; message: string; kind: KeyRefusalKind; action: RegExp; expectedMessage: string; produce: Produce }[] = [
  { code: 'plaintext-home', message: 'A plaintext vault was found beside keys/system-id; downgrade refused.', kind: 'downgrade', action: /Restore the original protected vault.*Choosing plaintext cannot undo protection/,
    expectedMessage: 'A plaintext vault was found beside keys/system-id, a system-store protection record; downgrade refused and nothing was changed.',
    produce: async (home, store) => { await protectedHome(home, store); const donor = join(home, 'donor'); await plain(donor); await withHomeLock(home, () => withHomeLock(join(home, 'keys'), async () => { copyFileSync(join(donor, 'keys', 'vault.json'), join(home, 'keys', 'vault.json')); })); return chooseKeys(home, {}, store); } },
  { code: 'plaintext-home', message: 'This plaintext home is not converted.', kind: 'provider-mismatch', action: /BACKBONE_KEYS=plaintext.*data key remains in plain text/,
    expectedMessage: 'This data folder keeps its keys in plain text and is not converted by choosing a provider. Nothing was changed.',
    produce: async (home, store) => { await plain(home); return chooseKeys(home, { BACKBONE_KEYS: 'system' }, store); } },
  { code: 'no-keychain', message: 'System key storage is disabled by BACKBONE_SYSTEM_STORE_UNAVAILABLE=1.', kind: 'store-disabled', action: /Remove BACKBONE_SYSTEM_STORE_UNAVAILABLE only from the real command.*Keep test commands behind/,
    expectedMessage: 'System key storage is disabled by BACKBONE_SYSTEM_STORE_UNAVAILABLE=1. Remove this refusal switch from the real command environment to use the store; nothing was changed.',
    produce: home => chooseKeys(home, { BACKBONE_SYSTEM_STORE_UNAVAILABLE: '1' }) },
  { code: 'no-keychain', message: 'A real guard refusal survives an item read.', kind: 'store-disabled', action: /Remove BACKBONE_SYSTEM_STORE_UNAVAILABLE only from the real command.*Keep test commands behind/,
    expectedMessage: 'System key storage is disabled by BACKBONE_SYSTEM_STORE_UNAVAILABLE=1. Remove this refusal switch from the real command environment to use the store; nothing was changed.',
    produce: async (home, store) => { await protectedHome(home, store); let denied: unknown; try { await chooseKeys(home, { BACKBONE_SYSTEM_STORE_UNAVAILABLE: '1' }); } catch (error) { denied = error; } assert.ok(denied instanceof KeysRefused); denied.message = 'PRIVATE_GUARD_DETAIL_MUST_NOT_ESCAPE'; store.get = async () => { throw denied; }; return Vault.open(home, await chooseKeys(home, {}, store, { readOnly: true })); } },
  { code: 'no-keychain', message: 'System key storage is disabled in a Node test process.', kind: 'store-disabled', action: /outside the test process.*Keep tests behind/,
    expectedMessage: 'System key storage is disabled in a Node test process. Only the explicitly scoped temporary-keychain test may opt in; nothing was changed.',
    produce: async home => { const saved = { ...process.env }; try { delete process.env.BACKBONE_SYSTEM_STORE_UNAVAILABLE; process.env.NODE_TEST_CONTEXT = 'child-v8'; process.env.BACKBONE_TEST_SYSTEM_KEYCHAIN = '0'; return await chooseKeys(home, {}); } finally { for (const name of ['BACKBONE_SYSTEM_STORE_UNAVAILABLE', 'NODE_TEST_CONTEXT', 'BACKBONE_TEST_SYSTEM_KEYCHAIN']) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } } } },
  { code: 'no-keychain', message: 'System key storage is not supported on Windows yet.', kind: 'platform-unsupported', action: /Use a supported platform.*do not change the provider/,
    expectedMessage: 'System key storage is not supported on Windows yet. No usable system key store is available (macOS Keychain or Linux Secret Service with /usr/bin/secret-tool). Unlock or start the store and try again. For an explicit plaintext data folder, BACKBONE_KEYS=plaintext writes the data key in plain text; copied data folders and backups expose it. Nothing falls back to plaintext.',
    produce: async home => { const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!; try { Object.defineProperty(process, 'platform', { value: 'win32' }); return await chooseKeys(home, { BACKBONE_KEYS: 'system' }); } finally { Object.defineProperty(process, 'platform', descriptor); } } },
  { code: 'held-by-app', message: 'App-kept keys.', kind: 'app-required', action: /Open the app.*daemon cannot open/,
    expectedMessage: 'This data folder needs electron-safeStorage through the app. Its keys are held in the Keychain by the app; open the app to use it. Nothing was changed.',
    produce: async (home, store) => { await Vault.open(home, keychainKeys({ isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async text => Buffer.from(text), decryptStringAsync: async bytes => ({ result: bytes.toString(), shouldReEncrypt: false }) })); return chooseKeys(home, {}, store); } },
  { code: 'test-database', message: 'Test database passwords.', kind: 'test-database', action: /with its own database/,
    expectedMessage: 'This data folder borrows a test database whose passwords are in plain text; the app opens only a data folder with a database of its own.',
    produce: home => { assert.equal(prepareDataHome(home), true); return Vault.open(home, memoryKeychain()); } },
  { code: 'no-keys', message: 'This home has legacy plaintext keys and no vault.', kind: 'legacy-home', action: /migration command above succeeds.*BACKBONE_KEYS=plaintext.*plain text/,
    expectedMessage: 'This data folder has legacy plaintext keys and no vault. Explicit BACKBONE_KEYS=plaintext permits the existing migration and keeps the data key in plain text; no system conversion was chosen and nothing was changed.', produce: legacy },
  { code: 'no-keys', message: 'This home has data but no vault of its keys.', kind: 'missing-vault', action: /original keys restored.*recovered from an export/,
    expectedMessage: 'This data folder has data but no vault of its keys; nothing was changed. No new keys were made.', produce: missingVault },
  { code: 'not-unwrapped', message: 'The vault provider could not be read.', kind: 'vault-unreadable', action: /Restore a readable original vault.*matching original store item/,
    expectedMessage: "This data folder's vault names an unknown or invalid key provider; nothing was changed.",
    produce: async (home, store) => { await plain(home); await withHomeLock(home, () => withHomeLock(join(home, 'keys'), async () => { writeFileSync(join(home, 'keys', 'vault.json'), '{'); })); return chooseKeys(home, {}, store); } },
  { code: 'no-keychain', message: 'Unavailable fake store.', kind: 'store-unavailable', action: /Unlock or start the system key store/,
    expectedMessage: 'No usable system key store is available (macOS Keychain or Linux Secret Service with /usr/bin/secret-tool). Unlock or start the store and try again. For an explicit plaintext data folder, BACKBONE_KEYS=plaintext writes the data key in plain text; copied data folders and backups expose it. Nothing falls back to plaintext.',
    produce: (home, store) => { store.usable = false; return chooseKeys(home, {}, store); } },
  { code: 'not-unwrapped', message: 'Missing original store item.', kind: 'missing-item', action: /Recover the original store item.*Do not recreate/,
    expectedMessage: "This data folder's keys are gone from the system key store; nothing was changed.",
    produce: async (home, store) => { await protectedHome(home, store); store.items.clear(); return Vault.open(home, await chooseKeys(home, {}, store, { readOnly: true })); } },
  { code: 'not-unwrapped', message: 'Tampered wrapped key.', kind: 'wrapped-key-invalid', action: /Restore the original vault and matching store item/,
    expectedMessage: "The system key store could not authenticate this data folder's wrapped key; nothing was changed.",
    produce: async (home, store) => { await protectedHome(home, store); await withHomeLock(home, () => withHomeLock(join(home, 'keys'), async () => { const path = join(home, 'keys', 'vault.json'), file = JSON.parse(readFileSync(path, 'utf8')), envelope = JSON.parse(Buffer.from(file.key, 'base64').toString()); const bytes = Buffer.from(envelope.data, 'base64'); bytes[0] ^= 1; envelope.data = bytes.toString('base64'); file.key = Buffer.from(JSON.stringify(envelope)).toString('base64'); writeFileSync(path, JSON.stringify(file)); })); return Vault.open(home, await chooseKeys(home, {}, store, { readOnly: true })); } },
  { code: 'not-unwrapped', message: 'Wrong system-home provider.', kind: 'provider-mismatch', action: /Unset BACKBONE_KEYS or choose BACKBONE_KEYS=system/,
    expectedMessage: 'This data folder needs os-keyring-v1 through the system key store; plaintext keys cannot open it. Nothing was changed.',
    produce: async (home, store) => { await protectedHome(home, store); return chooseKeys(home, { BACKBONE_KEYS: 'plaintext' }, store); } },
  { code: 'no-keys', message: 'Invalid provider choice.', kind: 'invalid-choice', action: /Choose BACKBONE_KEYS=system or BACKBONE_KEYS=plaintext/,
    expectedMessage: 'BACKBONE_KEYS takes plaintext or system. Plaintext writes the data key in plain text.',
    produce: (home, store) => chooseKeys(home, { BACKBONE_KEYS: 'invalid-test-choice' }, store) },
  { code: 'no-keys', message: 'No existing key home.', kind: 'keys-not-chosen', action: /reported key-choice requirement/,
    expectedMessage: 'This folder is not an existing data folder: no vault or legacy keys were found. Only host creates a data folder; nothing was changed.',
    produce: (home, store) => chooseKeys(home, {}, store, { create: false }) },
];
for (const row of cases) test(`daemon recovery is specific for ${row.kind}: ${row.message}`, async () => {
  await rejectedFrom(row.produce, error => {
    assert.equal(error.code, row.code); assert.equal(error.message, row.expectedMessage);
    const recovery = keyRefusalRecovery(error);
    assert.equal(recovery.kind, row.kind); assert.match(recovery.recovery, row.action);
    error.message = 'The platform wording changed completely.';
    assert.deepEqual(keyRefusalRecovery(error), recovery, 'typed reasons, not message substrings, select recovery');
  });
});

test('status log reader is bounded, ignores invalid metadata and never follows log links', () => {
  const root = mkdtempSync(join(tmpdir(), 'backbone-refusal-log-')), logs = join(root, 'logs'), log = join(logs, 'daemon.log');
  const record = 'daemon: stopped after key refusal (not-unwrapped): PRIVATE_VALUE /outside/home [missing-item at 2026-11-10T00:00:00.000Z]\n';
  try {
    assert.equal(lastKeyRefusal(root), undefined); mkdirSync(logs);
    writeFileSync(log, 'old content'.repeat(10_000) + '\n' + record
      + record.replace('missing-item', 'unknown-kind') + record.replace('2026-11-10', '2026-02-31'));
    const before = readFileSync(log);
    assert.deepEqual(lastKeyRefusal(root), { kind: 'missing-item', at: '2026-11-10T00:00:00.000Z' });
    assert.deepEqual(readFileSync(log), before);
    writeFileSync(log, record + 'unrelated later output'.repeat(4_000));
    assert.equal(lastKeyRefusal(root), undefined, 'only the bounded tail is inspected');
    const elsewhere = join(root, 'elsewhere.log'); writeFileSync(elsewhere, record);
    rmSync(log); symlinkSync(elsewhere, log); assert.equal(lastKeyRefusal(root), undefined);
    rmSync(log); renameSync(logs, join(root, 'saved-logs')); symlinkSync(join(root, 'saved-logs'), logs);
    assert.equal(lastKeyRefusal(root), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('daemon log gives each recovery command once', async () => {
  await rejectedFrom(legacy, (error, home) => {
    const line = keyRefusalLine(error, home);
    assert.equal([...line.matchAll(/BACKBONE_KEYS=plaintext backbone projects create/g)].length, 1);
  });
  await rejectedFrom(missingVault, (error, home) => {
    const line = keyRefusalLine(error, home);
    assert.equal([...line.matchAll(/backbone restore <backup-folder>/g)].length, 1);
  });
});
