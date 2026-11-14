// Bounded real-Host crash/recovery cases, with a scripted native producer and no account/model call.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHost, removeDataHome, type Host } from '../src/composition/host.ts';
import { CoreLink } from '../src/composition/core.ts';
import { PIECE_DIRS } from '../src/composition/pieces.ts';
import { pieceDigest, pieceFiles } from '../src/pieces/digest.ts';
import { freshDataHome } from '../src/testing/data-home.ts';
import { waitFor } from '../../../scripts/lib/test-hang.ts';
import type { Receipt, Thread } from '../src/api.ts';

const value = <T>(receipt: Receipt<T>): T => { if (!receipt.ok) throw new Error(receipt.detail); return receipt.value; };

for (const mode of ['write-pending', 'write-completed', 'read-pending', 'read-completed', 'receipt'] as const) test(`kill and reopen after ${mode} native activity`, { timeout: 180_000 }, async t => {
  const savedModel=process.env.BACKBONE_CODEX_MODEL; process.env.BACKBONE_CODEX_MODEL='controlled';
  t.after(()=>{if(savedModel===undefined)delete process.env.BACKBONE_CODEX_MODEL;else process.env.BACKBONE_CODEX_MODEL=savedModel;});
  const readOnly = mode.startsWith('read-');
  const goal = mode !== 'read-completed';
  const home = freshDataHome('native-account-crash');
  const fixture = mkdtempSync(join(tmpdir(), 'native-account-producer-'));
  let host: Host | undefined;
  t.after(async () => { host?.close(); await CoreLink.whenClosed(home); await removeDataHome(home); rmSync(fixture, { recursive: true, force: true }); });
  for (const path of pieceFiles(PIECE_DIRS['harness-codex'])) { const to = join(fixture, path); mkdirSync(dirname(to), { recursive: true }); copyFileSync(join(PIECE_DIRS['harness-codex'], path), to); }
  writeFileSync(join(fixture, 'src/index.ts'), `export function createCodexHarness() { return {
    specificationVersion: 'v1', id: 'controlled-native', label: 'Controlled native account fixture',
    async listModels() { return [{id:'controlled',label:'Controlled',efforts:[3]}]; },
    start(request, {tools}) {
      if (request.text === 'Base' || request.resumed) return { events:(async function*(){})(), stop(){}, steer(){}, outcome:Promise.resolve({status:request.resumed?'failed':'done',answer:'Base ready.',error:request.resumed?'Native turns cannot replay.':undefined,usage:{input:0,output:0}}) };
      return { events:(async function*(){
        yield {type:'tool',tool:'native_connector',readOnly:${readOnly},id:'native-call',phase:'proposed',label:'Codex connector fake / tool',detail:'Running in Codex.'};
        if (${mode === 'receipt'}) {
          const result=await tools.writeIfVersion('receipt.md','Controlled receipt.',{targetVersion:null,sources:[]},new AbortController().signal);
          if(result.outcome!=='DONE'){ console.error('Expected a completed Core receipt: '+result.detail); process.exit(2); }
        }
        if (${mode === 'write-completed' || mode === 'read-completed'}) yield {type:'tool',tool:'native_connector',readOnly:${readOnly},id:'native-call',phase:'done',label:'Codex connector fake / tool'};
        await globalThis.prepareKill(); await new Promise(()=>{});
      })(), outcome:new Promise(()=>{}), stop(){}, steer(){} };
    }
  }; }`);
  const manifestPath = join(fixture, 'backbone.module.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, digest: pieceDigest(fixture) }));
  const runner = join(fixture, 'crash.mjs');
  writeFileSync(runner, `import {readFileSync,writeFileSync} from 'node:fs';
    import {join,dirname} from 'node:path';
    import {withHomeLock,assertHomeWriteAdmission} from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../src/composition/home-lock.ts')).href)};
    import {createHost} from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../src/composition/host.ts')).href)};
    let target;
    globalThis.prepareKill=async()=>{
      if(${mode === 'receipt'}) await withHomeLock(process.argv[2],async()=>{
        const path=join(process.argv[2],'threads',target.threadId+'.json');
        const thread=JSON.parse(readFileSync(path,'utf8'));
        thread.turns.at(-1).completed=true;
        assertHomeWriteAdmission(process.argv[2],dirname(path));writeFileSync(path,JSON.stringify(thread));
      });
      process.kill(process.pid,'SIGKILL');
    };
    const host=createHost({home:process.argv[2],harness:'harness-codex',pieceDirs:{'harness-codex':process.argv[3]}});
    const value=r=>{if(!r.ok)throw new Error(r.detail);return r.value};
    const settings={permission:'full',model:'controlled',effort:3,runsOn:'this-computer',mode:'chat'};
    const project=value(await host.call('projects.create',{name:'Crash',kind:'folder'}));
    const base=value(await host.call('turns.send',{projectId:project.id,text:'Base',attachments:[],settings,clientKey:'base'}));
    while(value(await host.call('threads.get',{id:base.threadId})).summary.running)await new Promise(r=>setTimeout(r,10));
    if(${goal}) value(await host.call('goals.set',{threadId:base.threadId,text:'Perform the controlled task',baseVersion:0}));
    console.log(JSON.stringify(base));
    target=base;
    if(${goal}) value(await host.call('goals.run',{threadId:base.threadId,budget:2,settings}));
    else value(await host.call('turns.send',{threadId:base.threadId,projectId:project.id,text:'Read',attachments:[],settings,clientKey:'read'}));
    await new Promise(()=>{});`);
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, digest: pieceDigest(fixture) }));
  const child = spawn(process.execPath, [runner, home, fixture], { env: { ...process.env, BACKBONE_HARNESS: 'harness-codex', BACKBONE_CODEX_MODEL: 'controlled', BACKBONE_MODEL_ENDPOINT: '', BACKBONE_KEYS: 'plaintext' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', bytes => { out += bytes; }); child.stderr.on('data', bytes => { err += bytes; });
  let deadlineKill=false;
  const timer = setTimeout(() => { deadlineKill=true;child.kill('SIGKILL'); }, 30_000);
  const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  clearTimeout(timer);
  assert.equal(deadlineKill,false,`The fixture did not reach its own crash cut: ${err}`);
  assert.equal(ended.signal, 'SIGKILL', err);
  const base = JSON.parse(out.trim().split('\n').find(line => line.startsWith('{')) ?? 'null');
  assert.ok(base?.threadId, err);
  host = createHost({ home, harness: 'harness-codex', pieceDirs: { 'harness-codex': fixture } });
  await host.resumeInterrupted();
  let thread: Thread | undefined;
  await waitFor(async () => { thread = value(await host!.call('threads.get', { id: base.threadId })); return !thread.summary.running && thread.goalRun?.status !== 'running'; }, 'native crash recovery settles');
  const recovered = thread!.turns.at(-1)!;
  assert.equal(recovered.unknownOutcome === true, !readOnly);
  assert.equal(recovered.nativeAccountActivity === true, !readOnly);
  if(mode === 'receipt') { assert.equal(recovered.completed,true); assert.ok(recovered.effects.some(e=>e.outcome==='DONE')); }
  assert.equal(recovered.status, 'stopped', JSON.stringify(recovered));
  if(!readOnly) assert.ok(recovered.work.steps.some(step => step.kind === 'note' && /Codex connector fake/.test(step.label)), 'native step survives resume');
  if(goal) assert.equal(thread!.goalRun?.status === 'blocked', !readOnly);
  const preview=await host.call('threads.rewindPreview',{threadId:base.threadId,turnId:base.turnId});
  assert.equal(preview.ok,readOnly,JSON.stringify(preview));
  if(goal && readOnly) return;
  const restart = await host.call('threads.restart', { threadId: base.threadId, turnId: recovered.id });
  assert.equal(restart.ok, readOnly, JSON.stringify(restart));
  if (!restart.ok) assert.match(restart.detail, /native|unknown|inspect/i);

});
