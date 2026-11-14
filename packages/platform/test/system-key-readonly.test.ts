import { TEST_HANG_MS, hangDetector } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
import assert from 'node:assert/strict';
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';
import { outsideHomeLocks, withHomeLock } from '../src/composition/home-lock.ts';
import { Vault } from '../src/keys/vault.ts';
import { systemKeys } from '../src/system-keys/index.ts';
import { MemoryKeyStore } from '../src/system-keys/fake.ts';

const homes: string[] = [];
after(() => { for (const home of homes) { chmodSync(join(home, 'keys'), 0o700); rmSync(home, { recursive: true, force: true }); } });
async function fixture(marker = false) {
  const home = mkdtempSync(join(tmpdir(), 'backbone-key-readonly-')); homes.push(home);
  const store = new MemoryKeyStore();
  await Vault.open(home, systemKeys(home, store));
  if (marker) await Vault.open(home, systemKeys(home, store));
  return { home, store, keys: join(home, 'keys'), path: join(home, 'keys', 'vault.json'), marker: join(home, 'keys', 'system-protected') };
}
function snapshot(keys: string) {
  return readdirSync(keys).sort().map((name) => {
    const path = join(keys, name), stat = statSync(path);
    return { name, mode: stat.mode, mtime: stat.mtimeMs, bytes: stat.isFile() ? readFileSync(path).toString('base64') : null };
  });
}

test('existing marker skips every provider lock and file read', async () => {
  const f = await fixture(true), wrapped = Buffer.from(JSON.parse(readFileSync(f.path, 'utf8')).key, 'base64');
  const keys = systemKeys(f.home, f.store);
  const read = mock.method(fs, 'readFileSync', () => { throw new Error('unexpected provider read'); });
  const mkdir = mock.method(fs, 'mkdirSync', () => { throw new Error('unexpected provider lock'); });
  syncBuiltinESMExports();
  try {
    assert.equal((await keys.unwrapKey(wrapped)).key.length, 32);
    assert.equal(read.mock.callCount(), 0); assert.equal(mkdir.mock.callCount(), 0);
  } finally { read.mock.restore(); mkdir.mock.restore(); syncBuiltinESMExports(); }
});

test('a read-only keys folder with a marker opens promptly without changes', { timeout: TEST_HANG_MS * 2 }, async () => {
  const f = await fixture(true);
  // A pending writer holds the keys lock (a persistent regular file since H1); it must not delay an already marked open.
  let release!: () => void, ready!: () => void;
  const entered = new Promise<void>((r) => { ready = r; });
  const held = withHomeLock(f.keys, async () => { ready(); await new Promise<void>((r) => { release = r; }); });
  await entered;
  chmodSync(f.keys, 0o500);
  const before = snapshot(f.keys), writes = f.store.writes;
  try {
    assert.equal((await hangDetector(outsideHomeLocks(() => Vault.open(f.home, systemKeys(f.home, f.store))), 'marked read-only vault open while writer stays held')).holder, 'keychain');
    assert.deepEqual(snapshot(f.keys), before); assert.equal(f.store.writes, writes);
  } finally { chmodSync(f.keys, 0o700); release(); await held; }
});

test('a read-only keys folder without a marker opens and a later writable open publishes it', { timeout: TEST_HANG_MS * 2 }, async () => {
  const f = await fixture(); chmodSync(f.keys, 0o500);
  const before = snapshot(f.keys), writes = f.store.writes;
  try {
    assert.equal((await hangDetector(Vault.open(f.home, systemKeys(f.home, f.store)), 'read-only vault open without marker publication')).holder, 'keychain');
    assert.equal(existsSync(f.marker), false); assert.deepEqual(snapshot(f.keys), before);
  } finally { chmodSync(f.keys, 0o700); }
  await Vault.open(f.home, systemKeys(f.home, f.store));
  assert.equal(existsSync(f.marker), true); assert.equal(f.store.writes, writes);
  assert.deepEqual(readFileSync(f.path), Buffer.from(before.find((x) => x.name === 'vault.json')!.bytes!, 'base64'));
});

test('a busy in-process marker lock is bounded and retried on a later open', { timeout: TEST_HANG_MS * 2 }, async () => {
  const f = await fixture();
  let release!: () => void, ready!: () => void;
  const entered = new Promise<void>(resolve => { ready = resolve; });
  const held = withHomeLock(f.keys, async () => { ready(); await new Promise<void>(resolve => { release = resolve; }); });
  await entered;
  const nativeTimer = globalThis.setTimeout;
  let expire: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined, requestedMs = 0, finished = false;
  let clockReady!: () => void;
  const clockRequested = new Promise<void>(resolve => { clockReady = resolve; });
  // The provider's admission timer is the first short timer after this authenticated open.
  // Keep I/O and shared hang guards on real time; advance only that product clock.
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms: number, ...args: unknown[]) => {
    if (expire || ms > 10_000) return nativeTimer(callback, ms, ...args);
    requestedMs = ms;
    timer = nativeTimer(() => {}, TEST_HANG_MS); timer.unref();
    expire = () => callback(...args); clockReady(); return timer;
  }) as typeof setTimeout;
  const opening = outsideHomeLocks(() => Vault.open(f.home, systemKeys(f.home, f.store)));
  const completed = opening.then(result => { finished = true; return result; });
  try {
    await hangDetector(Promise.race([clockRequested, completed]), 'marker admission clock or immediate no-wait open');
    if (!finished) { assert.equal(requestedMs, 100, 'marker admission retains its product bound'); expire!(); }
    const opened = await hangDetector(completed, 'busy marker open finishes at its admission deadline while writer stays held');
    assert.equal(opened.holder, 'keychain');
    assert.equal(existsSync(f.marker), false);
  } finally {
    globalThis.setTimeout = nativeTimer; clearTimeout(timer);
    release(); await held;
    await hangDetector(opening.catch(() => undefined), 'marker open drains after writer release');
  }
  await Vault.open(f.home, systemKeys(f.home, f.store));
  assert.equal(existsSync(f.marker), true);
});

test('a stored envelope without outer base64 padding opens and publishes the marker', async () => {
  const f = await fixture(), file = JSON.parse(readFileSync(f.path, 'utf8'));
  const unpadded = file.key.replace(/=+$/, ''); assert.notEqual(unpadded, file.key);
  file.key = unpadded; writeFileSync(f.path, JSON.stringify(file));
  const before = readFileSync(f.path);
  assert.equal((await hangDetector(Vault.open(f.home, systemKeys(f.home, f.store)), 'read-only vault open without marker publication')).holder, 'keychain');
  assert.equal(existsSync(f.marker), true); assert.deepEqual(readFileSync(f.path), before);
});

test('a tampered envelope still fails authentication without publishing or writing', async () => {
  const f = await fixture(), file = JSON.parse(readFileSync(f.path, 'utf8'));
  const envelope = JSON.parse(Buffer.from(file.key, 'base64').toString());
  envelope.tag = Buffer.alloc(16, 4).toString('base64');
  file.key = Buffer.from(JSON.stringify(envelope)).toString('base64'); writeFileSync(f.path, JSON.stringify(file));
  const before = snapshot(f.keys), writes = f.store.writes;
  await assert.rejects(Vault.open(f.home, systemKeys(f.home, f.store)), /could not authenticate/);
  assert.deepEqual(snapshot(f.keys), before); assert.equal(f.store.writes, writes); assert.equal(existsSync(f.marker), false);
});
