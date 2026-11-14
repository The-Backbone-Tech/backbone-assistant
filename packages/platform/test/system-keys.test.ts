import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { KeysRefused, plaintextKeys, Vault } from '../src/keys/vault.ts';
import { systemKeys, SYSTEM_WRAP } from '../src/system-keys/index.ts';
import { MemoryKeyStore } from '../src/system-keys/fake.ts';

const homes: string[] = [];
const home = () => { const h = mkdtempSync(join(tmpdir(), 'backbone-system-keys-')); homes.push(h); return h; };
after(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
const path = (h: string) => join(h, 'keys', 'vault.json');
const bytes = (h: string) => readFileSync(path(h));

test('create and reopen with the existing vault interface; no usable key in the home', async () => {
  const h = home(), store = new MemoryKeyStore();
  const v = await Vault.open(h, systemKeys(h, store));
  await v.put('probe', Buffer.from('kept value'));
  const master = await v.masterKey();
  Vault.forget(h);
  const reopened = await Vault.open(h, systemKeys(h, store));
  assert.equal(reopened.get('probe')?.toString(), 'kept value');
  assert.deepEqual(await reopened.masterKey(), master);
  const f = JSON.parse(bytes(h).toString());
  assert.equal(f.format, 1); assert.equal(f.holder, 'keychain'); assert.equal(f.wrap, SYSTEM_WRAP);
  for (const key of store.items.values()) {
    assert.ok(!bytes(h).includes(key.toString('base64')));
    assert.ok(!bytes(h).includes(key.toString('hex')));
  }
  assert.notEqual(Buffer.from(f.key, 'base64').length, 32);
});

test('the unchanged vault refuses wrong providers before touching the store', async () => {
  const h = home(), store = new MemoryKeyStore();
  await Vault.open(h, systemKeys(h, store));
  const before = bytes(h); const reads = store.reads;
  await assert.rejects(Vault.open(h, plaintextKeys()), /Keychain/);
  await assert.rejects(Vault.open(h, { ...plaintextKeys(), holder: 'keychain', wrap: 'electron-safeStorage' }), /os-keyring-v1/);
  assert.equal(store.reads, reads); assert.deepEqual(bytes(h), before);
});

test('missing item says keys are gone and nothing changed; never creates a replacement', async () => {
  const h = home(), store = new MemoryKeyStore();
  await Vault.open(h, systemKeys(h, store));
  store.items.clear(); Vault.forget(h);
  const before = bytes(h), writes = store.writes;
  await assert.rejects(Vault.open(h, systemKeys(h, store)), /keys are gone from the system key store.*nothing was changed/);
  assert.equal(store.writes, writes); assert.deepEqual(bytes(h), before);
});

test('a tampered wrapped data key refuses without a write or a secret in the error', async () => {
  const h = home(), store = new MemoryKeyStore();
  await Vault.open(h, systemKeys(h, store));
  const f = JSON.parse(bytes(h).toString()); const envelope = JSON.parse(Buffer.from(f.key, 'base64').toString());
  envelope.data = Buffer.alloc(32, 7).toString('base64');
  f.key = Buffer.from(JSON.stringify(envelope)).toString('base64'); writeFileSync(path(h), JSON.stringify(f));
  Vault.forget(h); const before = bytes(h), writes = store.writes;
  await assert.rejects(Vault.open(h, systemKeys(h, store)), (e: Error) => {
    assert.match(e.message, /could not authenticate/);
    for (const key of store.items.values()) assert.ok(!e.message.includes(key.toString('base64')));
    return true;
  });
  assert.equal(store.writes, writes); assert.deepEqual(bytes(h), before);
});

test('two homes do not collide and exchanging their store items cannot open either', async () => {
  const a = home(), b = home(), store = new MemoryKeyStore();
  await Vault.open(a, systemKeys(a, store)); await Vault.open(b, systemKeys(b, store));
  assert.equal(store.items.size, 2);
  const [[idA, keyA], [idB, keyB]] = [...store.items];
  assert.notEqual(idA, idB); assert.notDeepEqual(keyA, keyB);
  store.items.set(idA, keyB); store.items.set(idB, keyA);
  Vault.forget(a); Vault.forget(b);
  await assert.rejects(Vault.open(a, systemKeys(a, store)), /authenticate/);
  await assert.rejects(Vault.open(b, systemKeys(b, store)), /authenticate/);
});

test('a moved home opens with the same account; missing identity is never recreated', async () => {
  const h = home(), moved = `${h}-moved`, store = new MemoryKeyStore(); homes.push(moved);
  const v = await Vault.open(h, systemKeys(h, store)); await v.put('probe', Buffer.from('moved'));
  renameSync(h, moved); Vault.forget(h);
  assert.equal((await Vault.open(moved, systemKeys(moved, store))).get('probe')?.toString(), 'moved');
  rmSync(join(moved, 'keys', 'system-id')); Vault.forget(moved);
  assert.equal((await Vault.open(moved, systemKeys(moved, store))).get('probe')?.toString(), 'moved');
  assert.throws(() => readFileSync(join(moved, 'keys', 'system-id')), /ENOENT/);
  assert.equal(store.items.size, 1);
});

test('concurrent creation uses the vault lock and keeps a single key and account', async () => {
  const h = home(), store = new MemoryKeyStore();
  const [a, b] = await Promise.all([Vault.open(h, systemKeys(h, store)), Vault.open(h, systemKeys(h, store))]);
  assert.equal(store.items.size, 1); assert.equal(store.writes, 1);
  await a.put('a', Buffer.from('one')); await b.put('b', Buffer.from('two'));
  assert.equal(a.get('b')?.toString(), 'two'); assert.equal(b.get('a')?.toString(), 'one');
});

test('interruption after store write leaves no vault; retry reuses the existing store key', async () => {
  const h = home(), store = new MemoryKeyStore();
  store.failAfterWrite = true;
  await assert.rejects(Vault.open(h, systemKeys(h, store)), /system key store/);
  assert.throws(() => bytes(h), /ENOENT/);
  const [[id, key]] = [...store.items]; store.failAfterWrite = false;
  await Vault.open(h, systemKeys(h, store));
  assert.equal(store.items.size, 1); assert.equal(store.writes, 1); assert.deepEqual(store.items.get(id), key);
});


test('store exceptions are sanitized even when a store throws a KeysRefused carrying a value', async () => {
  const h = home(), store = new MemoryKeyStore();
  await Vault.open(h, systemKeys(h, store)); Vault.forget(h);
  const before = bytes(h), writes = store.writes, secret = 'fake-store-exception-canary';
  store.get = async () => { throw new KeysRefused('not-unwrapped', secret); };
  await assert.rejects(Vault.open(h, systemKeys(h, store)), (e: Error) => {
    assert.ok(!e.message.includes(secret)); assert.match(e.message, /No usable system key store/); return true;
  });
  assert.equal(store.writes, writes); assert.deepEqual(bytes(h), before);
});


test('the envelope account is authenticated: substituting another home account cannot open it', async () => {
  const a = home(), b = home(), store = new MemoryKeyStore();
  await Vault.open(a, systemKeys(a, store)); await Vault.open(b, systemKeys(b, store));
  const f = JSON.parse(bytes(a).toString()), other = JSON.parse(bytes(b).toString());
  const envelope = JSON.parse(Buffer.from(f.key, 'base64').toString());
  envelope.account = JSON.parse(Buffer.from(other.key, 'base64').toString()).account;
  f.key = Buffer.from(JSON.stringify(envelope)).toString('base64'); writeFileSync(path(a), JSON.stringify(f)); Vault.forget(a);
  const before = bytes(a), writes = store.writes;
  await assert.rejects(Vault.open(a, systemKeys(a, store)), /could not authenticate/);
  assert.deepEqual(bytes(a), before); assert.equal(store.writes, writes);
});

test('every envelope field is type-checked before the store is asked', async () => {
  const h = home(), store = new MemoryKeyStore(); await Vault.open(h, systemKeys(h, store));
  const file = JSON.parse(bytes(h).toString()), valid = JSON.parse(Buffer.from(file.key, 'base64').toString());
  const invalid: unknown[] = [null, [], 'primitive'];
  for (const field of ['account', 'iv', 'tag', 'data']) for (const value of [null, 7, {}, [valid[field]]]) invalid.push({ ...valid, [field]: value });
  const reads = store.reads, writes = store.writes;
  for (const envelope of invalid) {
    file.key = Buffer.from(JSON.stringify(envelope)).toString('base64'); writeFileSync(path(h), JSON.stringify(file)); Vault.forget(h);
    const before = bytes(h);
    await assert.rejects(Vault.open(h, systemKeys(h, store)), /could not authenticate/);
    assert.deepEqual(bytes(h), before);
  }
  assert.equal(store.reads, reads); assert.equal(store.writes, writes);
});
