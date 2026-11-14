// Test-only IPC injection at the public selector seam; the production CLI and Host still run.
import assert from 'node:assert/strict';
import { CHILD_START_HANG_MS, DAEMON_READY, observeChild } from '../../../../scripts/lib/test-child.ts';
import { spawn } from 'node:child_process';
import type { SystemKeyStore } from '@backbone-next/platform/system-keys';

export class FakeSystemStore implements SystemKeyStore {
  readonly items = new Map<string, Buffer>();
  usable = true; probes = 0; reads = 0; writes = 0;
  async available() { this.probes++; return this.usable; }
  async get(account: string) { this.reads++; if (!this.usable) throw Error('Fake store unavailable'); return this.items.has(account) ? Buffer.from(this.items.get(account)!) : null; }
  async create(account: string, key: Buffer) { if (!this.usable || this.items.has(account)) throw Error('Fake store refused'); this.items.set(account, Buffer.from(key)); this.writes++; }
}
export function startCli(home: string, args: string[], store: FakeSystemStore, choice?: string, input = '', launchctlRunning = false) {
  const actual = import.meta.resolve('@backbone-next/platform/system-keys');
  const source = `
    import {chooseKeys as choose} from ${JSON.stringify(actual)};
    export * from ${JSON.stringify(actual)};
    const pending=new Map();let sequence=0;
    process.on('message',({id,value,failed})=>{const p=pending.get(id);pending.delete(id);if(failed)p.reject(Error('Fake store unavailable'));else p.resolve(value)});
    const rpc=(op,account,key)=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});process.send({id,op,account,key})});
    const store={available:()=>rpc('available'),get:async(account)=>{const v=await rpc('get',account);return v?Buffer.from(v,'base64'):null},create:(account,key)=>rpc('create',account,key.toString('base64'))};
    export const chooseKeys=(home,env,_store,options)=>choose(home,env,store,options);
  `;
  const boot = `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';const nativeSpawnSync=cp.spawnSync;cp.spawnSync=(file,...args)=>file==='launchctl'?{status:${launchctlRunning ? 0 : 113},stdout:${JSON.stringify(launchctlRunning ? 'state = running\npid = 4242\n' : '')},stderr:''}:nativeSpawnSync(file,...args);syncBuiltinESMExports();import {registerHooks} from 'node:module';registerHooks({resolve(s,c,next){return s==='@backbone-next/platform/system-keys'?{url:'test:cli-system-keys',shortCircuit:true}:next(s,c)},load(u,c,next){return u==='test:cli-system-keys'?{format:'module',source:${JSON.stringify(source)},shortCircuit:true}:next(u,c)}});`;
  const env = { ...process.env, BACKBONE_KEYS: choice ?? '', BACKBONE_HARNESS: 'stub', BACKBONE_TEST_SYSTEM_KEYCHAIN: '0' };
  const child = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(boot), new URL('../src/main.ts', import.meta.url).pathname, ...args, '--home', home], { env, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  child.stdin!.end(input);
  const output = observeChild(child, 'system-key CLI');
  const seen = { get out() { return output.stdout; }, get err() { return output.stderr; } };
  child.on('message', (m: { id: number; op: string; account: string; key: string }) => {
    void (async () => {
      try {
        const value = m.op === 'available' ? await store.available() : m.op === 'get' ? (await store.get(m.account))?.toString('base64') ?? null : await store.create(m.account, Buffer.from(m.key, 'base64'));
        if (child.connected) child.send({ id: m.id, value });
      } catch { if (child.connected) child.send({ id: m.id, failed: true }); }
    })();
  });
  // A daemon stays alive for its caller's assertions after readiness; ordinary CLI calls exit.
  const lifetime = args[0] === 'daemon' && args[1] === 'run' ? 3 * CHILD_START_HANG_MS : CHILD_START_HANG_MS;
  const timer = setTimeout(() => { console.error(output.diagnostic('CLI lifetime hang detector').message); child.kill('SIGKILL'); }, lifetime);
  const done = new Promise<{ code: number | null; out: string; err: string }>((resolve) => child.once('close', (code) => { clearTimeout(timer); resolve({ code, ...seen }); }));
  return { child, seen, done, output };
}
export async function cli(home: string, args: string[], store: FakeSystemStore, choice?: string, input = '', launchctlRunning = false) { return startCli(home, args, store, choice, input, launchctlRunning).done; }
export async function daemon(home: string, store: FakeSystemStore, choice?: string) {
  const started = startCli(home, ['daemon', 'run'], store, choice);
  // Selection refusals are expected exits in the table, never successful readiness.
  try { await started.output.waitForOutput(DAEMON_READY, { allowExit: true }); }
  catch (error) { started.child.kill('SIGKILL'); await started.done; throw error; }
  return started;
}
export function passed(result: { code: number | null; out: string; err: string }) { assert.equal(result.code, 0, result.err + result.out); assert.ok(!result.err.includes('TEST_EXTERNAL_NETWORK_REFUSED'), 'test attempted external network'); }
