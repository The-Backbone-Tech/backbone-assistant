import {exportAuditHome} from '../../src/composition/audit-home.ts';
import {AuditInvalid} from '../../src/audit.ts';
import assert from 'node:assert/strict';
import {mock} from 'node:test';
import {writeSync} from 'node:fs';
import {productClock} from '../../../../scripts/lib/test-clock.ts';
const progressTimeoutMs=Number(process.env.BACKBONE_AUDIT_STALL_DEADLINE_MS??300);
let clock: ReturnType<typeof productClock> | undefined;
let advanced=false,aborted=false;
let bytesWritten=0;
// Initialise Node's Unix pipe as nonblocking, then use native writes to observe actual EAGAIN.
// Writable.write()'s boolean only describes its JS high-water mark: one small serial write
// can return true even when its completion callback is stuck behind a full, unread pipe.
const outputFd=process.stdout.fd;
let clockSent=Promise.resolve();
let readerReady!: () => void,stopping=false;
const readerPaused=new Promise<void>(resolve=>{readerReady=resolve;});
process.on('message',message=>{if(message==='reader-paused')readerReady();});
process.once('SIGTERM',()=>{stopping=true;readerReady();});
const originalAbort=AbortController.prototype.abort;
mock.method(AbortController.prototype,'abort',function(this: AbortController,reason?: unknown){
  if(reason instanceof AuditInvalid)aborted=true;
  return originalAbort.call(this,reason);
});
try{
  const exporting=exportAuditHome(process.argv[2],{since:'2000-01-01T00:00:00Z',until:'2100-01-01T00:00:00Z'},bytes=>new Promise<void>((resolve,reject)=>{
    const encoded=Buffer.from(bytes,'utf8');
    try{
      for(let offset=0;offset<encoded.length;){
        let count;
        try{count=writeSync(outputFd,encoded,offset,encoded.length-offset,null);}
        catch(error){
          if(!['EAGAIN','EWOULDBLOCK'].includes((error as NodeJS.ErrnoException).code??''))throw error;
          assert.equal(advanced,false,'the first native blocked write owns clock advancement');
          advanced=true;
          process.send!({phase:'pipe-blocked',bytesWritten,remaining:encoded.length-offset});
          // The product armed its deadline before calling this writer. EAGAIN proves the
          // parent's real unread pipe is full; no stream callback or scheduler delay is needed.
          assert.ok(clock,'the product deadline clock is armed before output');
          clock.tick(299);
          assert.equal(aborted,false,'a blocked write remains live before its progress deadline');
          clock.tick(1);
          assert.equal(aborted,true,'the product must abort at the progress deadline');
          clockSent=new Promise<void>(resolve=>process.send!({clockExpired:true},()=>resolve()));
          return; // This write stays pending; only the product's deadline releases the export.
        }
        assert.ok(count>0,'a native pipe write makes progress or reports backpressure');
        offset+=count;bytesWritten+=count;
      }
      resolve();
    }catch(error){reject(error);}
  }),{
    // A fixture-only override makes a missing/late watchdog a fast, cleanup-safe red control.
    temporaryRoot:process.argv[3],progressTimeoutMs,
    atPoint:async(point,folder)=>{if(point==='server-ready'){
      process.send!({folder});
      // Parent has paused stdout and captured the live server PID before cleanup can race it.
      await readerPaused;
      if(!stopping){clock=productClock(mock,[progressTimeoutMs]);process.send!({phase:'clock-armed'});}
    }}
  });
  await exporting;
  clock?.reset();
  await clockSent;
  process.exit(0);
}catch(error){
  clock?.reset();await clockSent;
  // The parent joins stderr EOF: flush the diagnostic before an explicit child exit.
  await new Promise<void>(resolve=>process.stderr.write((error instanceof Error?error.message:String(error))+'\n',()=>resolve()));
  process.exit(1);
}
