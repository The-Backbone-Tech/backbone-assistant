// The data home's secrets at rest. Adverse cases: a process of the same user reads every file in the
// home, and finds no password, master key or model key; an existing home (its passwords and master
// key in the clear) moves them into the vault once and stays readable, also after a move cut short;
// without the Keychain's key nothing opens; and the app's keys refuse a test home's plaintext.
// The Keychain is played by a key held in this process's memory only (`memoryKeychain`).
import assert from 'node:assert/strict';
import fs, { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { CoreLink } from '../src/composition/core.ts';
import { createHost, removeDataHome } from '../src/composition/host.ts';
import { CredentialStore } from '../src/credentials/store.ts';
import { plaintextKeys, Vault } from '../src/keys/vault.ts';
import { freshDataHome } from '../src/testing/data-home.ts';
import { findInHome, homeSecrets, memoryKeychain } from '../src/testing/keys.ts';

const CANARY = 'sk-ant-canary-0b9e4f7a2c614d1f8e3a5b6c7d8e9f01'; // public-tree: synthetic
const homes: string[] = [];
after(async () => {
  for (const h of homes) await removeDataHome(h);
});
/** A home with a cluster of its own, as a person's first launch makes it (not the run's shared cluster). */
function ownHome(label: string): string {
  const home = mkdtempSync(join(tmpdir(), `backbone-${label}-`));
  homes.push(home);
  return home;
}

/** Every write to this process's stdout and stderr while `fn` runs, as the logs a run leaves. */
async function logsOf(fn: () => Promise<void>): Promise<string> {
  let seen = '';
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: never[]) => ((seen += String(chunk)), out(chunk, ...rest))) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: never[]) => ((seen += String(chunk)), err(chunk, ...rest))) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
  return seen;
}

const secretsOf = async (home: string, keys: Parameters<typeof homeSecrets>[1]) => {
  const { passwords, master } = await homeSecrets(home, keys);
  return [passwords.admin, passwords.app, passwords.operator, master];
};

async function close(host: ReturnType<typeof createHost>, home: string) {
  host.close();
  await CoreLink.whenClosed(home);
}

const keychain = memoryKeychain();

test('a new home keeps no secret in the clear: no file holds a password, the master key or a model key, and no log shows one', async () => {
  const home = ownHome('keys-new');
  const logs = await logsOf(async () => {
    const host = createHost({ home, keys: keychain });
    assert.equal((await host.call('settings.model.put', { change: { route: 'own', provider: 'anthropic', key: CANARY } })).ok, true);
    assert.equal((await host.call('projects.create', { name: 'Kept', kind: 'folder' })).ok, true);
    await close(host, home);
  });
  const secrets = [...(await secretsOf(home, keychain)), CANARY];
  assert.deepEqual(findInHome(home, secrets), [], 'a secret is readable in a file of the home');
  for (const s of secrets) assert.ok(!logs.includes(typeof s === 'string' ? s : s.toString('hex')), 'a secret appeared in a log');
  assert.ok(!existsSync(join(home, 'pg', 'secrets.json')));
  assert.ok(!existsSync(join(home, 'keys', 'master.key')));
  const vault = JSON.parse(readFileSync(join(home, 'keys', 'vault.json'), 'utf8'));
  assert.equal(vault.holder, 'keychain');
  assert.equal(vault.wrap, 'test-keychain');
  for (const entry of Object.values(vault.entries) as { alg: string }[]) assert.equal(entry.alg, 'A256GCM');
  // What a same-user process holds is the files: without the Keychain's key nothing opens.
  await assert.rejects(CoreLink.open({ home }), /Keychain/);
  await assert.rejects(CoreLink.open({ home, keys: plaintextKeys() }), /Keychain/);
  await assert.rejects(CoreLink.open({ home, keys: memoryKeychain() }));
});

/** Turn a home into the layout every home had before the vault: passwords and port in pg/secrets.json, the master key in keys/master.key, all in the clear. */
async function asBeforeTheVault(home: string) {
  const { passwords, master } = await homeSecrets(home, plaintextKeys());
  const { port } = JSON.parse(readFileSync(join(home, 'pg', 'cluster.json'), 'utf8')) as { port: number };
  writeFileSync(join(home, 'pg', 'secrets.json'), JSON.stringify({ ...passwords, port }), { mode: 0o600 });
  writeFileSync(join(home, 'keys', 'master.key'), master, { mode: 0o600 });
  rmSync(join(home, 'keys', 'vault.json'));
  rmSync(join(home, 'pg', 'cluster.json'));
  Vault.forget(home);
  return { passwords, master };
}

test('an existing home moves its secrets into the vault once, stays readable, and leaves none of them in the clear', async () => {
  const home = ownHome('keys-legacy');
  const before = createHost({ home, keys: plaintextKeys() });
  assert.equal((await before.call('projects.create', { name: 'Before the vault', kind: 'folder' })).ok, true);
  assert.equal((await before.call('settings.model.put', { change: { route: 'own', provider: 'anthropic', key: CANARY } })).ok, true);
  await close(before, home);
  const { passwords, master } = await asBeforeTheVault(home);
  const handle = JSON.parse(readFileSync(join(home, 'model-route.json'), 'utf8')).own.credential as string;

  const after = createHost({ home, keys: keychain });
  assert.deepEqual((await after.call('projects.list', {})).map((p) => p.name), ['Before the vault']);
  assert.equal((await after.call('settings.model.get', {})).own?.keySet, true);
  await close(after, home);
  assert.ok(!existsSync(join(home, 'pg', 'secrets.json')), 'the passwords file is gone');
  assert.ok(!existsSync(join(home, 'keys', 'master.key')), 'the master key file is gone');
  assert.deepEqual(findInHome(home, [passwords.admin, passwords.app, passwords.operator, master, CANARY]), []);
  // The sealed model key is the same one, now unsealed only through the vault.
  const vault = await Vault.open(home, keychain);
  assert.equal(await new CredentialStore(home, () => vault.masterKey()).resolve(handle), CANARY);

  // Moved once: a second launch finds it all and changes nothing.
  const bytes = readFileSync(join(home, 'keys', 'vault.json'));
  const again = createHost({ home, keys: keychain });
  assert.deepEqual((await again.call('projects.list', {})).map((p) => p.name), ['Before the vault']);
  await close(again, home);
  assert.deepEqual(readFileSync(join(home, 'keys', 'vault.json')), bytes, 'the vault was rewritten');
});

test('a move cut short (the old files still there beside the vault) is finished at the next start, with the same passwords', async () => {
  const home = ownHome('keys-cut-short');
  const first = createHost({ home, keys: plaintextKeys() });
  assert.equal((await first.call('projects.create', { name: 'Cut short', kind: 'folder' })).ok, true);
  await close(first, home);
  await asBeforeTheVault(home);
  const migrated = createHost({ home, keys: keychain });
  await migrated.call('projects.list', {});
  await close(migrated, home);
  // As if the process died after the vault was written and before the old files went.
  const vaultBytes = readFileSync(join(home, 'keys', 'vault.json'));
  const { passwords, master } = await homeSecrets(home, keychain);
  const { port } = JSON.parse(readFileSync(join(home, 'pg', 'cluster.json'), 'utf8')) as { port: number };
  writeFileSync(join(home, 'pg', 'secrets.json'), JSON.stringify({ ...passwords, port }), { mode: 0o600 });
  writeFileSync(join(home, 'keys', 'master.key'), master, { mode: 0o600 });
  Vault.forget(home);
  const next = createHost({ home, keys: keychain });
  assert.deepEqual((await next.call('projects.list', {})).map((p) => p.name), ['Cut short']);
  await close(next, home);
  assert.ok(!existsSync(join(home, 'pg', 'secrets.json')));
  assert.ok(!existsSync(join(home, 'keys', 'master.key')));
  assert.deepEqual(await homeSecrets(home, keychain), { passwords, master });
  assert.deepEqual(readFileSync(join(home, 'keys', 'vault.json')), vaultBytes);
});

test('the app\'s keys refuse a test home: a plaintext vault, or a database borrowed from a test cluster', async () => {
  const test = freshDataHome('keys-test-home');
  homes.push(test);
  await assert.rejects(CoreLink.open({ home: test, keys: keychain }), /plain text/);
  // The borrowed database alone is refused too, whatever the vault.
  rmSync(join(test, 'keys', 'vault.json'));
  Vault.forget(test);
  await assert.rejects(CoreLink.open({ home: test, keys: keychain }), /test database/);
  assert.ok(!existsSync(join(test, 'keys', 'vault.json')), 'a refused open wrote a vault');
});

test('a home with no vault opens only with keys someone chose: none given, nothing is made', async () => {
  const home = ownHome('keys-none');
  await assert.rejects(CoreLink.open({ home }), /BACKBONE_KEYS=plaintext/);
  assert.ok(!existsSync(join(home, 'keys', 'vault.json')));
  assert.ok(!existsSync(join(home, 'pg', 'data')), 'a cluster was made without keys');
});

test('a stray pg/pw an interrupted initdb left (the superuser\'s password in the clear) is gone after the next open, migrated or not', async () => {
  const home = ownHome('keys-stray-pw');
  const first = createHost({ home, keys: plaintextKeys() });
  assert.equal((await first.call('projects.create', { name: 'Stray', kind: 'folder' })).ok, true);
  await close(first, home);
  // An earlier version, killed between writing its password file and removing it.
  const { passwords } = await asBeforeTheVault(home);
  writeFileSync(join(home, 'pg', 'pw'), passwords.admin, { mode: 0o600 });
  const migrated = createHost({ home, keys: keychain });
  await migrated.call('projects.list', {});
  await close(migrated, home);
  assert.ok(!existsSync(join(home, 'pg', 'pw')), 'the migration left the password file');
  assert.deepEqual(findInHome(home, [passwords.admin, passwords.app, passwords.operator]), []);
  // Once more on a home already migrated, whose cluster exists.
  writeFileSync(join(home, 'pg', 'pw'), passwords.admin, { mode: 0o600 });
  const later = createHost({ home, keys: keychain });
  assert.deepEqual((await later.call('projects.list', {})).map((p) => p.name), ['Stray']);
  await close(later, home);
  assert.ok(!existsSync(join(home, 'pg', 'pw')), 'a later open left the password file');
  assert.deepEqual(findInHome(home, [passwords.admin]), []);
});

/** Each open, fsync, rename and removal this process makes while `fn` runs, in order, with the path an fsync was for. */
async function fsOps(fn: () => Promise<void>): Promise<{ op: string; path: string; to?: string; mode?: number }[]> {
  const log: { op: string; path: string; to?: string; mode?: number }[] = [];
  const fds = new Map<number, string>();
  const real = { openSync: fs.openSync, fsyncSync: fs.fsyncSync, renameSync: fs.renameSync, rmSync: fs.rmSync, unlinkSync: fs.unlinkSync, writeFileSync: fs.writeFileSync };
  Object.assign(fs, {
    openSync: (path: string, flags: fs.OpenMode = 'r', mode?: number) => {
      const fd = real.openSync(path, flags, mode);
      fds.set(fd, String(path));
      log.push({ op: 'open', path: String(path), mode });
      return fd;
    },
    fsyncSync: (fd: number) => (log.push({ op: 'fsync', path: fds.get(fd) ?? '?' }), real.fsyncSync(fd)),
    renameSync: (from: string, to: string) => (log.push({ op: 'rename', path: String(from), to: String(to) }), real.renameSync(from, to)),
    rmSync: (path: string, o?: fs.RmOptions) => (log.push({ op: 'remove', path: String(path) }), real.rmSync(path, o)),
    unlinkSync: (path: string) => (log.push({ op: 'remove', path: String(path) }), real.unlinkSync(path)),
    writeFileSync: (path: string, ...rest: unknown[]) => (log.push({ op: 'write', path: String(path) }), (real.writeFileSync as (...a: unknown[]) => void)(path, ...rest)),
  });
  syncBuiltinESMExports();
  try {
    await fn();
  } finally {
    Object.assign(fs, real);
    syncBuiltinESMExports();
  }
  return log;
}

test('the vault is written durably and owner-only from its first byte, by the one helper cluster.json uses', async () => {
  const at = mkdtempSync(join(tmpdir(), 'backbone-keys-durable-'));
  homes.push(at);
  const log = await fsOps(async () => {
    const { writePlaintextVault } = await import('../src/keys/vault.ts');
    writePlaintextVault(at);
    const vault = await Vault.open(at);
    await vault.put('probe', Buffer.from('value'));
  });
  const vaultFile = join(at, 'keys', 'vault.json');
  const renames = log.filter((e) => e.op === 'rename' && e.to === vaultFile);
  assert.equal(renames.length, 2, `the vault is written by write-then-rename both times: ${JSON.stringify(log.filter((e) => e.path.includes('vault')))}`);
  for (const r of renames) {
    const i = log.indexOf(r);
    const opened = log.slice(0, i).reverse().find((e) => e.op === 'open' && e.path === r.path);
    assert.equal(opened?.mode, 0o600, 'the vault\'s new file is owner-only from its first byte');
    assert.ok(log.slice(0, i).some((e) => e.op === 'fsync' && e.path === r.path), 'the file is synced before it takes the name');
    assert.ok(log.slice(i).some((e) => e.op === 'fsync' && e.path === join(at, 'keys')), 'its folder is synced after the rename');
  }
  assert.ok(!log.some((e) => e.op === 'write' && e.path === vaultFile), 'the vault was written in place');
});

test('two model-settings saves at once both persist: the own key and the gateway key, with no credential left over', async () => {
  const home = freshDataHome('keys-settings');
  homes.push(home);
  const host = createHost({ home });
  await host.call('projects.list', {});
  const [own, gateway] = await Promise.all([
    host.call('settings.model.put', { change: { route: 'own', provider: 'anthropic', key: 'sk-ant-own-0001' } }),
    host.call('settings.model.put', { change: { route: 'gateway', provider: 'openrouter', key: 'sk-or-gateway-0002' } }),
  ]);
  assert.ok(own.ok && gateway.ok, JSON.stringify([own, gateway]));
  const settings = await host.call('settings.model.get', {});
  assert.equal(settings.own?.keySet, true, 'the own key was lost');
  assert.equal(settings.gateway?.keySet, true, 'the gateway key was lost');
  assert.equal(readdirSync(join(home, 'credentials')).length, 2, 'a sealed credential is left with no route');
  await close(host, home);
});
