import { TEST_HANG_MS, hangDetector } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {existsSync,mkdtempSync,readdirSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {CoreLink} from '../src/composition/core.ts';
import {auditProcessAlive,sweepAuditTemporary} from '../src/composition/audit-temporary.ts';
import {freshHome} from './helpers.ts';
test('a real pipe reader that stops reading cannot retain the copy, trust server or transaction',{timeout:TEST_HANG_MS * 4},async t=>{
  const home=freshHome(),root=mkdtempSync('/tmp/ast-');rmSync(join(home,'pg','external.json'),{force:true});
  const link=await hangDetector(CoreLink.open({home}), 'audit stall source database open');
  let receipts=0;
  try{await hangDetector((async()=>{for(;receipts<800;receipts++)await link.createTask(`Stall ${receipts}`);})(), 'audit stall source receipts', {diagnostic:()=>`${receipts}/800 created`});}
  finally{await hangDetector(link.close(), 'audit stall source database close');}
  const child=fork(join(import.meta.dirname,'fixtures/audit-stall-process.ts'),[home,root],{execArgv:[],stdio:['ignore','pipe','pipe','ipc']});
  child.stdout!.pause();let err='';child.stderr!.on('data',b=>err+=b);
  // stdout intentionally stays unread. Join exit and the flowing stderr pipe, not stdout EOF.
  const exited=new Promise<number|null>(resolve=>child.once('exit',resolve));
  const stderrEnded=new Promise<void>(resolve=>child.stderr!.once('end',resolve));
  const done=Promise.all([exited,stderrEnded]).then(([code])=>code);
  let folder='',clockExpired=false,phase='starting',bytesWritten=0,remaining=0;
  const deadlineObserved=new Promise<void>(resolve=>child.on('message',m=>{
    const event=m as {clockExpired?:boolean;phase?:string;bytesWritten?:number;remaining?:number};
    if(event.phase){phase=event.phase;bytesWritten=event.bytesWritten??bytesWritten;remaining=event.remaining??remaining;}
    if(event.clockExpired){clockExpired=true;resolve();}
  }));
  const diagnostic=()=>JSON.stringify({receipts,folder,phase,bytesWritten,remaining,clockExpired,exitCode:child.exitCode,signal:child.signalCode,stderr:err});
  try{
    ({folder}=await hangDetector(new Promise<{folder:string}>((resolve,reject)=>{child.once('message',m=>resolve(m as {folder:string}));child.once('exit',()=>reject(new Error(err)));}), 'audit copied server readiness', {diagnostic}));
    const server=Number(readFileSync(join(folder,'data','postmaster.pid'),'utf8').split('\n')[0]);
    assert.ok(Number.isSafeInteger(server)&&server>0,'the ready copy has a real server PID');
    child.send('reader-paused');
    assert.notEqual(await hangDetector(done, 'audit stalled-reader abort and cleanup', {diagnostic}),0);assert.match(err,/No audit output progress.*not written whole/);
    await hangDetector(deadlineObserved,'audit product clock expiry observation',{diagnostic});
    assert.equal(phase,'pipe-blocked','the native pipe reported actual backpressure');
    assert.ok(bytesWritten>0&&remaining>0,'real audit bytes filled the unread pipe and a write remains pending');
    assert.equal(clockExpired,true,'the product progress deadline was advanced only after a blocked pipe write');
    assert.equal(existsSync(folder),false);assert.equal(auditProcessAlive(server),false);assert.deepEqual(readdirSync(root),[]);
    t.diagnostic(JSON.stringify({phase,bytesWritten,remaining,clockExpired,exitCode:child.exitCode,serverStopped:true,copyRemoved:true}));
  }finally{
    try{
      if(child.exitCode===null&&child.signalCode===null){
        child.kill('SIGTERM');
        try{await hangDetector(done,'audit stalled-reader emergency cleanup',{diagnostic});}
        finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await hangDetector(done,'audit forced child exit',{diagnostic});}}
      }
    }finally{
      child.stdout!.destroy();
      // Use the product's recorded-owner sweep after an injected failure, never remove a live copy.
      await hangDetector(sweepAuditTemporary(root),'audit temporary cleanup sweep',{diagnostic});
      if(readdirSync(root).length===0)rmSync(root,{recursive:true,force:true});
    }
  }
});
