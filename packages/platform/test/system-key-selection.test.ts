import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { plaintextKeys, Vault } from '../src/keys/vault.ts';
import { chooseKeys, homeKeyProvider, SYSTEM_WRAP, systemKeys } from '../src/system-keys/index.ts';
import { MemoryKeyStore } from '../src/system-keys/fake.ts';

const homes: string[] = [];
const home = () => { const h = mkdtempSync(join(tmpdir(), 'backbone-key-selection-')); homes.push(h); return h; };
after(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
const settings = [undefined, 'plaintext', 'system'] as const;
for (const choice of settings) for (const existing of ['fresh', 'plaintext', 'system', 'app'] as const) {
  test(`selection: ${choice ?? 'unset'} on ${existing}`, async () => {
    const h = home(), store = new MemoryKeyStore();
    if (existing === 'plaintext') await Vault.open(h, plaintextKeys());
    if (existing === 'system') await Vault.open(h, systemKeys(h, store));
    if (existing === 'app') {
      mkdirSync(join(h, 'keys'));
      writeFileSync(join(h, 'keys', 'vault.json'), JSON.stringify({ format: 1, holder: 'keychain', wrap: 'electron-safeStorage' }));
    }
    const before = existing === 'fresh' ? null : readFileSync(join(h, 'keys', 'vault.json'));
    const promise = chooseKeys(h, { BACKBONE_KEYS: choice }, store);
    if (existing === 'app') await assert.rejects(promise, /electron-safeStorage.*app/);
    else if (choice === 'system' && existing === 'plaintext') await assert.rejects(promise, /plain text.*not converted/);
    else if (choice === 'plaintext' && existing === 'system') await assert.rejects(promise, /os-keyring-v1/);
    else {
      const keys = await promise;
      assert.equal(keys.wrap, choice === 'plaintext' || existing === 'plaintext' ? 'none' : SYSTEM_WRAP);
      const vault = await Vault.open(h, keys);
      assert.equal(vault.holder, keys.holder);
    }
    if (before) assert.deepEqual(readFileSync(join(h, 'keys', 'vault.json')), before);
    if (existing === 'plaintext') assert.deepEqual(homeKeyProvider(h), { holder: 'plaintext', wrap: 'none' });
  });
}

for (const choice of [undefined, 'system']) test(`no usable store with ${choice ?? 'nothing'} chosen refuses without plaintext or identity`, async () => {
  const h = home(), store = new MemoryKeyStore(); store.usable = false;
  await assert.rejects(chooseKeys(h, { BACKBONE_KEYS: choice }, store), /No usable system key store.*BACKBONE_KEYS=plaintext.*plain text/);
  assert.ok(!existsSync(join(h, 'keys'))); assert.equal(store.writes, 0);
});

test('plaintext does not probe a store; an existing plaintext home opens even if no store is usable', async () => {
  const h = home(), store = new MemoryKeyStore();
  store.available = async () => { assert.fail('store was probed'); };
  await Vault.open(h, await chooseKeys(h, { BACKBONE_KEYS: 'plaintext' }, store));
  const keys = await chooseKeys(h, {}, store);
  assert.equal(keys.wrap, 'none'); await Vault.open(h, keys);
});

test('bad configuration, malformed metadata, and unknown providers fail without raw content', async () => {
  const h = home(), store = new MemoryKeyStore();
  await assert.rejects(chooseKeys(h, { BACKBONE_KEYS: 'bad-private-value' }, store), /takes plaintext or system/);
  mkdirSync(join(h, 'keys')); const path = join(h, 'keys', 'vault.json');
  for (const text of ['bad-private-value', 'null', JSON.stringify({ holder: 'keychain', wrap: 'bad-private-value', format: 1 })]) {
    writeFileSync(path, text);
    await assert.rejects(chooseKeys(h, {}, store), (e: Error) => { assert.ok(!e.message.includes('bad-private-value')); return true; });
    assert.equal(readFileSync(path, 'utf8'), text);
  }
  assert.equal(store.reads, 0); assert.equal(store.writes, 0);
});


test('Windows forced system selection refuses plainly without trying any real store', () => {
  const h = home();
  const source = `
    Object.defineProperty(process,'platform',{value:'win32'});
    const {chooseKeys}=await import(${JSON.stringify(new URL('../src/system-keys/index.ts', import.meta.url).href)});
    try { await chooseKeys(process.argv[1],{BACKBONE_KEYS:'system'}); process.exitCode=1; }
    catch(e) { if(!e.message.includes('not supported on Windows yet')) process.exitCode=2; }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, h], { encoding: 'utf8' });
  assert.equal(result.status, 0); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  assert.ok(!existsSync(join(h, 'keys')));
});

for (const choice of [undefined, 'plaintext', 'system']) test(`data without a vault refuses ${choice ?? 'unset'} selection before probing or making keys`, async () => {
  const h = home(), store = new MemoryKeyStore();
  mkdirSync(join(h, 'pg', 'data'), { recursive: true });
  store.available = async () => { assert.fail('a lost-vault home probed the system store'); };
  await assert.rejects(chooseKeys(h, { BACKBONE_KEYS: choice }, store), /has data but no vault.*nothing was changed/);
  assert.ok(!existsSync(join(h, 'keys'))); assert.equal(store.writes, 0);
});


for (const trace of ['system-id', 'system-protected']) for (const choice of [undefined, 'plaintext', 'system']) for (const usable of [true, false]) test(`protected plaintext downgrade: ${trace}, ${choice ?? 'unset'}, store ${usable}`, async () => {
  const h = home(), store = new MemoryKeyStore();
  await Vault.open(h, systemKeys(h, store));
  await Vault.open(h, systemKeys(h, store)); // Authenticated reopen finalizes the marker.
  rmSync(join(h, 'keys', trace === 'system-id' ? 'system-protected' : 'system-id'));
  const path = join(h, 'keys', 'vault.json'), file = JSON.parse(readFileSync(path, 'utf8'));
  file.holder = 'plaintext'; file.wrap = 'none'; file.key = Buffer.alloc(32, 9).toString('base64');
  writeFileSync(path, JSON.stringify(file)); const before = readFileSync(path), writes = store.writes;
  store.usable = usable; store.available = async () => { assert.fail('downgrade probed store'); };
  await assert.rejects(chooseKeys(h, { BACKBONE_KEYS: choice }, store), new RegExp(`plaintext vault.*keys/${trace}.*nothing was changed`));
  assert.deepEqual(readFileSync(path), before); assert.equal(store.writes, writes);
});

test('an interrupted protected creation retries the same item but cannot switch to plaintext', async () => {
  const h = home(), store = new MemoryKeyStore(); store.failAfterWrite = true;
  await assert.rejects(Vault.open(h, systemKeys(h, store)), /system key store/);
  await assert.rejects(chooseKeys(h, { BACKBONE_KEYS: 'plaintext' }, store), /Plaintext keys were requested.*protection record/);
  store.failAfterWrite = false;
  const vault = await Vault.open(h, await chooseKeys(h, {}, store));
  assert.equal(vault.holder, 'keychain'); assert.equal(store.writes, 1);
});

for (const marker of ['credentials', 'doors', 'memory', 'skills', 'tools', 'connectors', 'projects', 'material', 'drafts', 'checkpoints', 'outbox', 'channels', 'project-create-intents', 'new-owner-data']) test(`missing vault inventory includes ${marker}`, async () => {
  const h = home(), store = new MemoryKeyStore(); mkdirSync(join(h, marker));
  store.available = async () => { assert.fail('orphaned data probed the store'); };
  await assert.rejects(chooseKeys(h, {}, store), /has data but no vault/);
  assert.ok(!existsSync(join(h, 'keys')));
});

for (const choice of [undefined, 'plaintext', 'system']) test(`selector with create:false refuses a fresh folder (${choice ?? 'unset'})`, async () => {
  const h = home(), store = new MemoryKeyStore(); store.available = async () => { assert.fail('non-creating choice probed store'); };
  await assert.rejects(chooseKeys(h, { BACKBONE_KEYS: choice }, store, { create: false }), /not an existing data home/);
  assert.deepEqual(homeKeyProvider(h), null); assert.equal(store.writes, 0);
});

for (const marker of ['keys/master.key', 'pg/secrets.json']) for (const choice of [undefined, 'plaintext', 'system']) test(`legacy selection ${marker}: ${choice ?? 'unset'}`, async () => {
  const h = home(), store = new MemoryKeyStore(), file = join(h, marker);
  mkdirSync(join(h, marker.split('/')[0]), { recursive: true });
  writeFileSync(file, marker.endsWith('master.key') ? Buffer.alloc(32, 5) : '{}');
  store.available = async () => { assert.fail('legacy selection probed the store'); };
  if (choice === 'plaintext') {
    assert.equal((await chooseKeys(h, { BACKBONE_KEYS: choice }, store, { create: false })).holder, 'plaintext');
  } else await assert.rejects(chooseKeys(h, { BACKBONE_KEYS: choice }, store, { create: false }), /legacy plaintext keys.*BACKBONE_KEYS=plaintext/);
  assert.equal(store.writes, 0); assert.ok(!existsSync(join(h, 'keys', 'vault.json')));
});


for (const choice of [undefined, 'system']) test(`refusal switch names itself without suggesting plaintext (${choice ?? 'unset'})`, async () => {
  const h = home();
  await assert.rejects(chooseKeys(h, { BACKBONE_KEYS: choice, BACKBONE_SYSTEM_STORE_UNAVAILABLE: '1' }), (e: Error) => {
    assert.match(e.message, /disabled by BACKBONE_SYSTEM_STORE_UNAVAILABLE=1/);
    assert.ok(!e.message.includes('plaintext'));
    return true;
  });
  assert.ok(!existsSync(join(h, 'keys')));
});

test('the refusal switch does not change an explicit or existing plaintext choice', async () => {
  const h = home();
  await Vault.open(h, await chooseKeys(h, { BACKBONE_KEYS: 'plaintext', BACKBONE_SYSTEM_STORE_UNAVAILABLE: '1' }));
  assert.equal((await chooseKeys(h, { BACKBONE_SYSTEM_STORE_UNAVAILABLE: '1' })).holder, 'plaintext');
});

for (const litter of ['.DS_Store', 'Thumbs.db', 'desktop.ini']) test(`OS directory metadata ${litter} does not make a folder an existing home`, async () => {
  const h = home(), store = new MemoryKeyStore();
  writeFileSync(join(h, litter), 'test directory metadata');
  assert.equal((await Vault.open(h, await chooseKeys(h, {}, store))).holder, 'keychain');
  assert.equal(readFileSync(join(h, litter), 'utf8'), 'test directory metadata');
});
