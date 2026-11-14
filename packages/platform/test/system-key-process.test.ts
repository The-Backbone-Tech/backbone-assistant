import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Vault } from '../src/keys/vault.ts';
import { systemKeys } from '../src/system-keys/index.ts';
import { MemoryKeyStore } from '../src/system-keys/fake.ts';

test('two processes create one vault and keep entries encrypted under the same data key', { timeout: TEST_HANG_MS * 2 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'backbone-system-process-'));
  const store = new MemoryKeyStore(), children: ChildProcess[] = [];
  const source = `
    import {Vault} from ${JSON.stringify(new URL('../src/keys/vault.ts', import.meta.url).href)};
    import {systemKeys} from ${JSON.stringify(new URL('../src/system-keys/index.ts', import.meta.url).href)};
    const pending=new Map(); let sequence=0;
    process.on('message', ({id,value,failed}) => {
      const p=pending.get(id); pending.delete(id);
      if(failed) p.reject(new Error('Fake store refused')); else p.resolve(value);
    });
    const rpc=(op,account,key) => new Promise((resolve,reject) => {
      const id=++sequence; pending.set(id,{resolve,reject}); process.send({id,op,account,key});
    });
    const store={
      available:async()=>true,
      get:async(account)=>{const v=await rpc('get',account);return v?Buffer.from(v,'base64'):null;},
      create:(account,key)=>rpc('create',account,key.toString('base64'))
    };
    const vault=await Vault.open(process.argv[1],systemKeys(process.argv[1],store));
    await vault.put(process.argv[2],Buffer.from(process.argv[2]));
    process.disconnect();
  `;
  function start(label: string) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, home, label], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    children.push(child);
    let logs = '';
    child.stdout!.on('data', (d) => { logs += d; }); child.stderr!.on('data', (d) => { logs += d; });
    child.on('message', (message: { id: number; op: string; account: string; key: string }) => {
      void (async () => {
        try {
          const value = message.op === 'get' ? (await store.get(message.account))?.toString('base64') ?? null : await store.create(message.account, Buffer.from(message.key, 'base64'));
          child.send({ id: message.id, value });
        } catch { child.send({ id: message.id, failed: true }); }
      })();
    });
    return new Promise<void>((resolve, reject) => child.once('close', (code) => {
      if (code !== 0 || logs) reject(new Error('A concurrent vault process failed or wrote unexpected output.'));
      else resolve();
    }));
  }
  try {
    await Promise.all([start('left'), start('right')]);
    assert.equal(store.items.size, 1); assert.equal(store.writes, 1);
    const vault = await Vault.open(home, systemKeys(home, store));
    assert.equal(vault.get('left')?.toString(), 'left'); assert.equal(vault.get('right')?.toString(), 'right');
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) await new Promise((r) => { child.once('close', r); child.kill('SIGKILL'); });
    rmSync(home, { recursive: true, force: true });
  }
});
