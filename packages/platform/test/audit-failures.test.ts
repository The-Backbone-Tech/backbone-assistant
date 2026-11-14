import { childHangTimer } from '../../../scripts/lib/test-child.ts';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {after,before,test} from 'node:test';
import {CoreLink} from '../src/composition/core.ts';
import {exportAuditHome} from '../src/composition/audit-home.ts';
import {auditProcessAlive,auditTemporaryRoot,sweepAuditTemporary} from '../src/composition/audit-temporary.ts';
import {freshHome} from './helpers.ts';
import {AUDIT_PERIOD} from './fixtures/audit-activity.ts';
let home:string,root:string;
before(async()=>{root=fs.mkdtempSync('/tmp/bf-');home=freshHome();fs.rmSync(join(home,'pg','external.json'),{force:true});const link=await CoreLink.open({home});await link.createTask('Failures');await link.close();});
after(()=>fs.rmSync(root,{recursive:true,force:true}));
const run=(atPoint?:NonNullable<Parameters<typeof exportAuditHome>[3]>['atPoint'])=>exportAuditHome(home,AUDIT_PERIOD,async()=>{},{temporaryRoot:root,atPoint});
test('a source changed during copying is refused and the private copy is removed',async()=>{
  const control=join(home,'pg','data','global','pg_control'),original=fs.readFileSync(control);
  try{await assert.rejects(run(point=>{if(point==='copying'){const changed=Buffer.from(original);changed[changed.length-1]^=1;fs.writeFileSync(control,changed);}}),/source database.*changed/);}
  finally{fs.writeFileSync(control,original);}
  assert.deepEqual(fs.readdirSync(root),[]);
});
for(const kind of ['symbolic','hard'] as const)test(`${kind} links are refused before copying vault bytes`,async()=>{
  const name=join(home,'pg','data','audit-test-link');
  try{if(kind==='symbolic')fs.symlinkSync(join(home,'keys','vault.json'),name);else fs.linkSync(join(home,'keys','vault.json'),name);
    await assert.rejects(run(),/without links/);
  }finally{fs.rmSync(name,{force:true});}assert.deepEqual(fs.readdirSync(root),[]);
});
test('the 8 GiB free-space guard refuses before copying and cleans up',async()=>{
  const original=fs.statfsSync;
  try{fs.statfsSync=((...args:Parameters<typeof original>)=>({...original(...args),bavail:0})) as typeof original;syncBuiltinESMExports();await assert.rejects(run(),/less than 8 GiB/);}
  finally{fs.statfsSync=original;syncBuiltinESMExports();}assert.deepEqual(fs.readdirSync(root),[]);
});
test('a failure after server startup removes the folder and stops its server',async()=>{
  let server=0;
  await assert.rejects(run((point,folder)=>{if(point==='server-ready'){server=Number(fs.readFileSync(join(folder,'data','postmaster.pid'),'utf8').split('\n')[0]);throw new Error('Fixture cleanup failure');}}),/Fixture cleanup failure/);
  assert.ok(server);assert.equal(auditProcessAlive(server),false);assert.deepEqual(fs.readdirSync(root),[]);
});
test('a dead owner and dead supervisor leave an attributable orphan which startup sweep stops and removes',{timeout:240_000},async()=>{
  const child=fork(join(import.meta.dirname,'fixtures/audit-copy-process.mjs'),[home,root,'server-ready'],{stdio:['ignore','ignore','ignore','ipc'],execArgv:[]});
  const exited=new Promise(resolve=>child.once('exit',resolve));const timer=childHangTimer(child,'audit snapshot server-ready cut');
  try{
    const {folder}=await new Promise<{folder:string}>((resolve,reject)=>{child.once('message',m=>resolve(m as {folder:string}));child.once('exit',()=>reject(new Error('fixture ended early')));});
    const record=JSON.parse(fs.readFileSync(join(folder,'owner.json'),'utf8'));
    process.kill(record.supervisor,'SIGKILL');child.kill('SIGKILL');await exited;
    await sweepAuditTemporary(root);assert.equal(fs.existsSync(folder),false);assert.equal(auditProcessAlive(record.server),false);
  }finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}}
});


test('a malformed or reused live source PID gives a truthful refusal without removing the source PID',async()=>{
  const file=join(home,'pg','data','postmaster.pid');
  try{
    fs.writeFileSync(file,'invalid\n');await assert.rejects(run(),/PID file is invalid/);assert.equal(fs.readFileSync(file,'utf8'),'invalid\n');
    fs.writeFileSync(file,String(process.pid)+'\n');await assert.rejects(run(),/live process but no API line is available/);assert.equal(fs.readFileSync(file,'utf8'),String(process.pid)+'\n');
  }finally{fs.rmSync(file,{force:true});}
  assert.deepEqual(fs.readdirSync(root),[]);
});

test('a supervisor killed alone aborts its owner, which stops the known server before removing the copy',{timeout:240_000},async()=>{
  const child=fork(join(import.meta.dirname,'fixtures/audit-copy-process.mjs'),[home,root,'server-ready'],{stdio:['ignore','ignore','pipe','ipc'],execArgv:[]});
  let errors='';child.stderr!.on('data',b=>errors+=b);const exited=new Promise(resolve=>child.once('exit',resolve));
  try{
    const {folder}=await new Promise<{folder:string}>(resolve=>child.once('message',m=>resolve(m as {folder:string})));
    const record=JSON.parse(fs.readFileSync(join(folder,'owner.json'),'utf8'));process.kill(record.supervisor,'SIGKILL');
    assert.notEqual(await exited,0);assert.match(errors,/supervisor ended/);assert.equal(auditProcessAlive(record.server),false);assert.equal(fs.existsSync(folder),false);
  }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}}
});

test('standalone startup sweeps its supplied root only',async()=>{
  // 10 November 2026: the earlier version planted a stale folder in the SHARED global root and asserted that it
  // survived; another audit test file running in parallel could sweep it as stale (gate of b2be3c19). The property is
  // that a run given its own root never lists or removes anything in the global root, so observe that directly.
  const make=(parent:string)=>{const folder=fs.mkdtempSync(join(parent,'backbone-audit-v1-2147483647-'));fs.writeFileSync(join(folder,'owner.json'),JSON.stringify({format:'backbone.audit.temp.v1',owner:2147483647,server:null}));return folder;};
  const own=make(root),global=auditTemporaryRoot(),touched:string[]=[];
  const inGlobal=(path:unknown)=>{const text=String(path);return text===global||text.startsWith(global+'/');};
  const {readdirSync,rmSync}=fs;
  fs.readdirSync=((...args:Parameters<typeof readdirSync>)=>{if(inGlobal(args[0]))touched.push(`list ${String(args[0])}`);return readdirSync(...args);}) as typeof readdirSync;
  fs.rmSync=((...args:Parameters<typeof rmSync>)=>{if(inGlobal(args[0]))touched.push(`remove ${String(args[0])}`);return rmSync(...args);}) as typeof rmSync;
  syncBuiltinESMExports();
  try{await run((point)=>{if(point==='allocated'){assert.equal(fs.existsSync(own),false);throw new Error('stop after root observation');}}).then(()=>assert.fail('expected observation failure'),e=>assert.match(e.message,/root observation/));}
  finally{fs.readdirSync=readdirSync;fs.rmSync=rmSync;syncBuiltinESMExports();}
  assert.deepEqual(touched,[],'a run given its own root must not list or remove anything in the global root');
});
