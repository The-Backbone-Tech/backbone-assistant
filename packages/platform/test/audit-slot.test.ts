import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {join} from 'node:path';
import {test} from 'node:test';
import type {Receipt} from '../src/api.ts';
import type {AuditPage} from '../src/audit.ts';
import {auditReceipt} from '../src/composition/audit-export.ts';
import {serveApiLine} from '../src/composition/api-line.ts';
import {attachApi} from '../src/doors/api-line.ts';
import {CoreLink} from '../src/composition/core.ts';
import {freshHome,value} from './helpers.ts';
import {AUDIT_PERIOD} from './fixtures/audit-activity.ts';
import {waitFor} from '../../../scripts/lib/test-hang.ts';
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
test('a holder session has a maximum lifetime which page progress cannot extend',{timeout: TEST_HANG_MS * 2},async t=>{
  const link=await CoreLink.open({home:freshHome()});
  try{
    for(let i=0;i<270;i++)await link.createTask(`Cap ${i}`);
    t.mock.timers.enable({apis:['setTimeout']});
    const timeouts={idleMs:1000,lifetimeMs:400};
    let first=value(await auditReceipt(link,AUDIT_PERIOD,timeouts));assert.ok(first.session);
    t.mock.timers.tick(150);first=value(await auditReceipt(link,{...AUDIT_PERIOD,session:first.session!},timeouts));assert.ok(first.session);
    t.mock.timers.tick(250);
    const expired=await auditReceipt(link,{...AUDIT_PERIOD,session:first.session!},timeouts);assert.equal(expired.ok,false);
    const next=value(await auditReceipt(link,AUDIT_PERIOD,timeouts));assert.ok(next.session);value(await auditReceipt(link,{...AUDIT_PERIOD,session:next.session!,cancel:true},timeouts));
  }finally{t.mock.timers.reset();await link.close();}
});
test('another same-user connection cannot extend a session; killing its owning client releases the slot',{timeout: TEST_HANG_MS * 2},async()=>{
  const home=freshHome(),link=await CoreLink.open({home});let child:ReturnType<typeof fork>|undefined;
  let server:Awaited<ReturnType<typeof serveApiLine>>|undefined;
  try{
    for(let i=0;i<90;i++)await link.createTask(`Client ${i}`);
    server=await serveApiLine({home,call:((method:string,args:never)=>{assert.equal(method,'audit.export');return auditReceipt(link,args);}) as never});
    child=fork(join(import.meta.dirname,'fixtures/audit-line-client.mjs'),[home],{execArgv:[],stdio:['ignore','ignore','inherit','ipc']});
    const first=value(await new Promise<Receipt<AuditPage>>(resolve=>child!.once('message',resolve)));assert.ok(first.session);
    const second=await attachApi(home);assert.ok(second);
    try{
      const stolen=await second.call('audit.export',{...AUDIT_PERIOD,session:first.session});assert.equal(stolen.ok,false);if(!stolen.ok)assert.match(stolen.detail,/another connection/);
      const blocked=await second.call('audit.export',AUDIT_PERIOD);assert.equal(blocked.ok,false);
      const gone=new Promise(resolve=>child!.once('exit',resolve));child.kill('SIGKILL');await gone;
      let next:Receipt<AuditPage>|undefined;
      await waitFor(async()=>{next=await second.call('audit.export',AUDIT_PERIOD);return next.ok;},'dead audit client releases its export slot',{diagnostic:()=>JSON.stringify(next)});
      assert.ok(next?.ok,'dead socket releases the slot without waiting for idle expiry');if(next.ok&&next.value.session)value(await second.call('audit.export',{...AUDIT_PERIOD,session:next.value.session,cancel:true}));
    }finally{second.close();}
  }finally{if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await server?.close();await link.close();}
});
