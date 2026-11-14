import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { createHost, hostClosed, removeDataHome } from '../src/composition/host.ts';
import { attachApi } from '../src/doors/api-line.ts';
import { chooseKeys, SYSTEM_WRAP } from '../src/system-keys/index.ts';
import { MemoryKeyStore } from '../src/system-keys/fake.ts';
import { MCP_HOST_READY, observeChild } from '../../../scripts/lib/test-child.ts';

const homes: string[] = [], children: ChildProcess[] = [];
after(async () => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) await new Promise((r) => { c.once('exit', r); c.kill('SIGKILL'); });
  for (const h of homes) await removeDataHome(h);
});

/** Test-only module hook injects an IPC fake. The production selector and MCP main still run. */
async function mcpHost(home: string, store: MemoryKeyStore) {
  const source = `
    import { chooseKeys as choose } from ${JSON.stringify(new URL('../src/system-keys/index.ts', import.meta.url).href)};
    const pending = new Map(); let sequence = 0;
    process.on('message', ({id, value, failed}) => {
      const {resolve, reject} = pending.get(id); pending.delete(id);
      if (failed) reject(new Error('Fake store refused')); else resolve(value);
    });
    const rpc = (op, account, key) => new Promise((resolve,reject) => {
      const id=++sequence; pending.set(id,{resolve,reject}); process.send({id,op,account,key});
    });
    const store = {
      available: () => rpc('available'),
      get: async (account) => { const value=await rpc('get',account); return value ? Buffer.from(value,'base64') : null; },
      create: (account,key) => rpc('create',account,key.toString('base64'))
    };
    export const chooseKeys = (home,env) => choose(home,env,store);
  `;
  const main = new URL('../../surfaces/mcp/src/main.ts', import.meta.url).href;
  const boot = `
    import {registerHooks} from 'node:module';
    registerHooks({
      resolve(s,c,next) { return s==='@backbone-next/platform/system-keys' ? {url:'test:system-keys',shortCircuit:true} : next(s,c); },
      load(u,c,next) { return u==='test:system-keys' ? {format:'module',source:${JSON.stringify(source)},shortCircuit:true} : next(u,c); }
    });
  `;
  const env: NodeJS.ProcessEnv = { ...process.env, BACKBONE_HARNESS: 'stub' }; delete env.BACKBONE_KEYS;
  const child = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(boot), fileURLToPath(main), 'host', '--home', home], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  children.push(child);
  const output = observeChild(child, 'MCP system-key host');
  child.on('message', (message: { id: number; op: string; account: string; key: string }) => {
    void (async () => {
      try {
        const value = message.op === 'available' ? await store.available() : message.op === 'get' ? (await store.get(message.account))?.toString('base64') ?? null : await store.create(message.account, Buffer.from(message.key, 'base64'));
        child.send({ id: message.id, value });
      } catch { child.send({ id: message.id, failed: true }); }
    })();
  });
  const closed = new Promise<void>((r) => child.once('close', () => r()));
  try {
    await output.waitForOutput(MCP_HOST_READY);
  } catch (error) { child.kill('SIGKILL'); await closed; throw error; }
  return { close: async () => { child.kill('SIGTERM'); await closed; }, logs: () => output.stdout + output.stderr };
}

test('MCP host creates a system home with no key choice; session-style Host creates and reopens a project', { timeout: 600_000 }, async () => {
  // A protected home cannot borrow freshHome's shared plaintext test database.
  const home = mkdtempSync(join(tmpdir(), 'backbone-system-host-')); homes.push(home);
  const store = new MemoryKeyStore();
  const first = await mcpHost(home, store);
  try {
    const line = await attachApi(home); assert.ok(line);
    try { assert.deepEqual(await line.call('projects.list', {}), []); } finally { line.close(); }
    const vault = JSON.parse(readFileSync(join(home, 'keys', 'vault.json'), 'utf8'));
    assert.equal(vault.wrap, SYSTEM_WRAP); assert.equal(vault.holder, 'keychain');
    assert.ok(!existsSync(join(home, 'pg', 'secrets.json')));
    for (const value of store.items.values()) assert.ok(!first.logs().includes(value.toString('base64')));
  } finally { await first.close(); }

  // Same host composition the leased session needs, with the new selector and no env choice.
  const host = createHost({ home, keys: await chooseKeys(home, {}, store), harness: 'stub' });
  try { assert.equal((await host.call('projects.create', { name: 'My project', kind: 'folder' })).ok, true); }
  finally { host.close(); await hostClosed(home); }
  const second = await mcpHost(home, store);
  try {
    const line = await attachApi(home); assert.ok(line);
    try { assert.deepEqual((await line.call('projects.list', {})).map((p) => p.name), ['My project']); }
    finally { line.close(); }
    assert.equal(store.items.size, 1); assert.equal(store.writes, 1);
  } finally { await second.close(); }
});
