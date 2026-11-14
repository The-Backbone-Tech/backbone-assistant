import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readAudit,type AuditOptions} from '../src/audit.ts';
import {AUDIT_PAGE_SIZE,auditReceipt,coreAuditSource,exportAudit as writeAudit} from '../src/composition/audit-export.ts';
import {exportAudit} from './fixtures/audit-collect.ts';
import {CoreLink} from '../src/composition/core.ts';
import {freshHome,value} from './helpers.ts';
import {AUDIT_PERIOD} from './fixtures/audit-activity.ts';
const facts=(file:string)=>readAudit(file).events.map(({previousHash,...event})=>event);
test('bounded sequence pages: three resumed files join and their union equals a full export', {timeout: TEST_HANG_MS * 2},async()=>{
  const link=await CoreLink.open({home:freshHome()});
  try{
    for(let i=0;i<160;i++)await link.createTask(`Backlog ${i}`);
    const source=coreAuditSource(link),sizes:number[]=[];
    const measured={...source,snapshot:async(sql:string,args:unknown[])=>{assert.equal(args[5],AUDIT_PAGE_SIZE);const page=await source.snapshot(sql,args);sizes.push(page.events.length);return page;}};
    const full=await exportAudit(measured,AUDIT_PERIOD);assert.ok(full.header.count>AUDIT_PAGE_SIZE);
    const chunks:ReturnType<typeof facts>=[];let previous:string|undefined,after:string|undefined;
    for(let run=0;run<3;run++){
      const made=await exportAudit(measured,{...AUDIT_PERIOD,limit:60,...(after?{after}:{})});
      const read=readAudit(made.jsonl,previous);chunks.push(...facts(made.jsonl));
      assert.ok(read.events.length<=60);previous=made.jsonl;after=made.trailer.cursor!.id;
    }
    assert.deepEqual(chunks,facts(full.jsonl));assert.equal(after,full.trailer.cursor!.id);assert.ok(sizes.length>3);assert.ok(sizes.every(n=>n<=AUDIT_PAGE_SIZE));
    let writes=0,inWrite=false;
    const gated={...source,snapshot:async(sql:string,args:unknown[])=>{assert.equal(inWrite,false,'next page waits for the preceding sink write');return source.snapshot(sql,args);}};
    await writeAudit(gated,AUDIT_PERIOD,async()=>{inWrite=true;await new Promise(r=>setTimeout(r,2));writes++;inWrite=false;});assert.ok(writes>1);
  }finally{await link.close();}
});

test('a holder has one export slot, with explicit refusal, continuation and cancellation', {timeout: TEST_HANG_MS * 2},async()=>{
  const link=await CoreLink.open({home:freshHome()});let session:string|null=null;
  try{
    for(let i=0;i<140;i++)await link.createTask(`Slot ${i}`);
    let page=value(await auditReceipt(link,AUDIT_PERIOD));session=page.session;assert.ok(session);const bytes=[page.jsonl];
    const other=await auditReceipt(link,AUDIT_PERIOD);assert.equal(other.ok,false);assert.match(other.ok?'':other.detail,/Another audit export is active/);
    while(session){page=value(await auditReceipt(link,{...AUDIT_PERIOD,session}));session=page.session;bytes.push(page.jsonl);}
    assert.ok(readAudit(bytes.join('')).events.length>140);
    page=value(await auditReceipt(link,AUDIT_PERIOD));session=page.session;assert.ok(session);
    value(await auditReceipt(link,{...AUDIT_PERIOD,session,cancel:true}));session=null;
    page=value(await auditReceipt(link,{...AUDIT_PERIOD,limit:3}));assert.equal(page.session,null);assert.ok(page.trailer);
  }finally{if(session)await auditReceipt(link,{...AUDIT_PERIOD,session,cancel:true});await link.close();}
});

test('a limit above one page pins every later page to the original scan boundary',{timeout: TEST_HANG_MS * 2},async()=>{
  const link=await CoreLink.open({home:freshHome()});
  try{
    for(let i=0;i<170;i++)await link.createTask(`Boundary ${i}`);
    const base=coreAuditSource(link);let reads=0;
    const source={...base,snapshot:async(sql:string,args:unknown[])=>{if(++reads===2)for(let i=0;i<5;i++)await link.createTask(`Concurrent boundary ${i}`);return base.snapshot(sql,args);}};
    const made=await exportAudit(source,{...AUDIT_PERIOD,limit:AUDIT_PAGE_SIZE+10}),record=readAudit(made.jsonl);
    assert.equal(record.events.length,AUDIT_PAGE_SIZE+10);assert.equal(made.trailer.cursor!.sequence,String(AUDIT_PAGE_SIZE+10));assert.equal(reads,2);
    assert.ok(BigInt(made.header.sourceHead!.sequence)>BigInt(made.trailer.cursor!.sequence));
  }finally{await link.close();}
});
