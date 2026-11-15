import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { systemKeys, chooseKeys } from '../src/system-keys/index.ts';
import { MemoryKeyStore } from '../src/system-keys/fake.ts';
import { Vault } from '../src/keys/vault.ts';
import { HomeWriteUnavailable } from '../src/composition/home-lock.ts';

test('direct system wrapping admits storage before identity or item creation', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'backbone-key-admission-')), home = join(root, 'home'), store = new MemoryKeyStore();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = fs.statfsSync;
  t.mock.method(fs, 'statfsSync', ((path: fs.PathLike) => ({ ...original(path), type: 0x6969 })) as typeof fs.statfsSync);
  await assert.rejects(systemKeys(home, store).wrapKey(Buffer.alloc(32, 7)), (e: unknown) => e instanceof HomeWriteUnavailable);
  assert.equal(fs.existsSync(home), false); assert.equal(store.reads, 0); assert.equal(store.writes, 0);
});

test('read-only selection neither initializes an empty home nor publishes a protection marker', async (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'backbone-key-admission-')), store = new MemoryKeyStore();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  await assert.rejects(chooseKeys(home, {}, store, { readOnly: true, create: true }), /not an existing data folder/);
  assert.deepEqual(fs.readdirSync(home), []);
  await Vault.open(home, systemKeys(home, store));
  const before = fs.readFileSync(join(home, 'keys', 'vault.json'));
  const keys = await chooseKeys(home, {}, store, { readOnly: true });
  await Vault.open(home, keys);
  assert.equal(fs.existsSync(join(home, 'keys', 'system-protected')), false);
  assert.deepEqual(fs.readFileSync(join(home, 'keys', 'vault.json')), before);
  await assert.rejects(keys.wrapKey(Buffer.alloc(32, 7)), /Read-only key selection/);
  assert.equal(store.writes, 1);
});
