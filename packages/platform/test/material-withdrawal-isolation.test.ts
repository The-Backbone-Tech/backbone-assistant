// Offline delivery fairness and structured notices; historical receipts never restore access.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {MaterialStore} from '../src/stub/material.ts';
import {createMaterialWithdrawalDelivery,withdrawalDeliveryNotices} from '../src/composition/material-withdrawal-delivery.ts';
import {CoreRefusal} from '../src/composition/core.ts';
for(const mode of ['transport','invalid-reply','conflict'] as const)test(`${mode} for one event does not block another source in the same pass`,async t=>{
 const home=mkdtempSync(join(tmpdir(),'withdrawal-isolation-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
 const material=new MaterialStore(home,{},()=>{}),one=material.create('project','a.md','text/markdown',Buffer.from('a'),'original','person'),two=material.create('project','b.md','text/markdown',Buffer.from('b'),'original','person');
 material.withdraw(one.id);material.withdraw(two.id);const ordered=material.pendingWithdrawals('workspace'),bad=ordered[0].materialId,good=ordered[1].materialId,calls:string[]=[];
 const worker=createMaterialWithdrawalDelivery({home,material,workspace:'workspace',writable:()=>true,changed:()=>{},async record(event){calls.push(event.materialId);if(event.materialId===bad){
  if(mode==='transport')throw new Error('Synthetic transport failure');if(mode==='conflict')throw new CoreRefusal('conflict','conflict: synthetic history mismatch');return {workspace:'foreign',event:event.id,receipt:'wrong'};
 }return {workspace:'workspace',event:event.id,receipt:'receipt'};}});t.after(()=>worker.close());
 worker.request();await worker.whenIdle();assert.deepEqual(calls,[bad,good]);
 const pending=material.pendingWithdrawals('workspace');assert.equal(pending.some(event=>event.materialId===good),false);assert.equal(pending.some(event=>event.materialId===bad),true);
});
test('structured pending/conflict notices keep stable codes and source identity without exposing error text',()=>{
 const home=mkdtempSync(join(tmpdir(),'withdrawal-notices-'));try{
  const material=new MaterialStore(home,{},()=>{}),entry=material.create('project','source.md','text/markdown',Buffer.from('a'),'original','person');material.withdraw(entry.id);
  const event=material.pendingWithdrawals('workspace')[0],pending=withdrawalDeliveryNotices(material,'workspace','project');
  assert.deepEqual(pending,[{code:'material-withdrawal-pending',materialId:entry.id,message:'Withdrawal confirmation is pending for source.md.'}]);
  material.recordWithdrawalConflict(entry.id,event.id,'workspace');
  assert.deepEqual(withdrawalDeliveryNotices(material,'workspace','project'),[{code:'material-withdrawal-conflict',materialId:entry.id,message:'Withdrawal confirmation for source.md conflicts with saved history; review is required.'}]);
  assert.deepEqual(withdrawalDeliveryNotices(material,'workspace','foreign'),[]);
 }finally{rmSync(home,{recursive:true,force:true});}
});
