import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AUDIT_SLOT_BUSY} from '@backbone-next/platform/audit';
import {waitForAuditSlot} from '../src/audit-slot.ts';
const busy={ok:false as const,reason:'INVALID' as const,detail:AUDIT_SLOT_BUSY,outcome:'REFUSED' as const};
test('CLI waits on an explicit slot refusal, announces once, retries and observes its bound',async()=>{
  let now=0,calls=0,messages=0;
  const clock={now:()=>now,sleep:async(ms:number)=>{now+=ms;}};
  assert.deepEqual(await waitForAuditSlot(async()=>++calls<4?busy:{ok:true as const,value:'ready'},()=>messages++,{waitMs:100,retryMs:10},clock),{ok:true,value:'ready'});
  assert.equal(calls,4);assert.equal(messages,1);assert.equal(now,30);
  await assert.rejects(waitForAuditSlot(async()=>busy,()=>{}, {waitMs:50,retryMs:10},clock),/within 3 minutes/);assert.equal(now,80);
  calls=0;assert.deepEqual(await waitForAuditSlot(async()=>{calls++;return{...busy,detail:'a different refusal'};},()=>assert.fail('must not wait')), {...busy,detail:'a different refusal'});assert.equal(calls,1);
});
