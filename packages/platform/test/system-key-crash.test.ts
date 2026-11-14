import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Vault } from '../src/keys/vault.ts';
import { chooseKeys, systemKeys } from '../src/system-keys/index.ts';
import { MemoryKeyStore } from '../src/system-keys/fake.ts';

// Abrupt exits leave the real durable files in place. Only the key store is an IPC fake.
for (const point of ['before-identity', 'identity', 'item', 'verified', 'envelope', 'vault', 'before-marker', 'marker']) {
  test(`creation retries after process exit at ${point}`, { timeout: TEST_HANG_MS * 2 }, async () => {
    const home = mkdtempSync(join(tmpdir(), 'backbone-key-crash-')), store = new MemoryKeyStore();
    const durable = new URL('../../kernel/src/durable.ts', import.meta.url).href;
    const provider = new URL('../src/system-keys/index.ts', import.meta.url).href;
    const vaultModule = new URL('../src/keys/vault.ts', import.meta.url).href;
    const wrappedWriter = `
      import * as original from ${JSON.stringify(durable)};
      export * from ${JSON.stringify(durable)};
      export function writeDurable(path,...args) {
        const name=String(path).split('/').at(-1), point=process.argv[2];
        if((point==='before-identity'&&name==='system-id')||(point==='before-marker'&&name==='system-protected'))process.kill(process.pid,'SIGKILL');
        const result=original.writeDurable(path,...args);
        if((point==='identity'&&name==='system-id')||(point==='vault'&&name==='vault.json')||(point==='marker'&&name==='system-protected'))process.kill(process.pid,'SIGKILL');
        return result;
      }
    `;
    const source = `
      import {registerHooks} from 'node:module';
      registerHooks({resolve(s,c,next){return s==='@backbone-next/kernel/files'?{url:'test:durable',shortCircuit:true}:next(s,c)},load(u,c,next){return u==='test:durable'?{format:'module',source:${JSON.stringify(wrappedWriter)},shortCircuit:true}:next(u,c)}});
      const pending=new Map();let sequence=0,created=false;
      process.on('message',({id,value})=>{pending.get(id)(value);pending.delete(id)});
      const rpc=(op,account,key)=>new Promise(resolve=>{const id=++sequence;pending.set(id,resolve);process.send({id,op,account,key})});
      const point=process.argv[2],home=process.argv[1];
      const store={available:async()=>true,
        get:async(account)=>{const v=await rpc('get',account);if(created&&point==='verified')process.kill(process.pid,'SIGKILL');return v?Buffer.from(v,'base64'):null},
        create:async(account,key)=>{await rpc('create',account,key.toString('base64'));created=true;if(point==='item')process.kill(process.pid,'SIGKILL')}};
      const {chooseKeys,systemKeys}=await import(${JSON.stringify(provider)});
      const {Vault}=await import(${JSON.stringify(vaultModule)});
      const keys=await chooseKeys(home,{},store),wrapKey=keys.wrapKey;
      keys.wrapKey=async(key)=>{const wrapped=await wrapKey(key);if(point==='envelope')process.kill(process.pid,'SIGKILL');return wrapped};
      await Vault.open(home,keys);
      await Vault.open(home,systemKeys(home,store));
      process.exit(0);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, home, point], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let logs = '';
    child.stdout!.on('data', (d) => { logs += d; }); child.stderr!.on('data', (d) => { logs += d; });
    child.on('message', (m: { id: number; op: string; account: string; key: string }) => {
      void (async () => {
        const value = m.op === 'get' ? (await store.get(m.account))?.toString('base64') ?? null : await store.create(m.account, Buffer.from(m.key, 'base64'));
        child.send({ id: m.id, value });
      })();
    });
    try {
      const signal = await new Promise((resolve) => child.once('close', (_code, signal) => resolve(signal)));
      assert.equal(signal, 'SIGKILL', logs);
      const committed = ['vault', 'before-marker', 'marker'].includes(point);
      assert.equal(existsSync(join(home, 'keys', 'vault.json')), committed);
      assert.equal(existsSync(join(home, 'keys', 'system-protected')), point === 'marker');
      const identity = existsSync(join(home, 'keys', 'system-id')) ? readFileSync(join(home, 'keys', 'system-id'), 'utf8') : null;
      const before = committed ? readFileSync(join(home, 'keys', 'vault.json')) : null;
      const retry = await Vault.open(home, await chooseKeys(home, {}, store));
      await retry.put('retry', Buffer.from('works'));
      Vault.forget(home);
      assert.equal((await Vault.open(home, systemKeys(home, store))).get('retry')?.toString(), 'works');
      if (identity) assert.equal(readFileSync(join(home, 'keys', 'system-id'), 'utf8'), identity);
      if (before) assert.equal(JSON.parse(readFileSync(join(home, 'keys', 'vault.json'), 'utf8')).key, JSON.parse(before.toString()).key);
      assert.equal(store.items.size, 1); assert.equal(store.writes, 1);
      assert.equal(existsSync(join(home, 'keys', 'system-protected')), true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) await new Promise((r) => { child.once('close', r); child.kill('SIGKILL'); });
      rmSync(home, { recursive: true, force: true });
    }
  });
}
