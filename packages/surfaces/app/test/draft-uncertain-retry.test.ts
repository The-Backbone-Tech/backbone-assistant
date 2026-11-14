import assert from 'node:assert/strict';
import { test } from 'node:test';

test('an explicit retry replays the exact uncertain request, then keeps newer typing', async () => {
  const calls:any[]=[]; let current:any=null, first=true;
  Object.assign(globalThis,{window:{backbone:{async call(method:string,args:any){
    if(method==='drafts.get') return current;
    if(method==='drafts.put') {
      calls.push(structuredClone(args));
      if(first) {first=false;current={key:args.key,text:args.text,meta:args.meta,revision:1,updatedAt:'now'};throw new Error('lost acknowledgement');}
      if(calls.length===2) return {ok:true,value:current}; // same operation had landed
      assert.equal(args.baseRevision,1);current={key:args.key,text:args.text,meta:args.meta,revision:2,updatedAt:'now'};return {ok:true,value:current};
    }
    throw new Error(method);
  }}}});
  const drafts=await import('../src/lib/drafts.ts');
  await assert.rejects(drafts.persistDraftNow('retry','first',{retryNotice:'warning'}),/lost acknowledgement/);
  await assert.rejects(drafts.persistDraftNow('retry','newer',{retryNotice:'warning'}),/lost acknowledgement/);
  assert.equal(calls.length,1);
  await drafts.retryUncertainDraft('retry');
  assert.deepEqual(calls[1],calls[0]);
  await drafts.flushDraft('retry');
  assert.equal(current.text,'newer');assert.equal(calls[2].baseRevision,1);
});

test('a stale explicit retry stays held for review and never replaces the newer saved draft', async () => {
  const calls:any[]=[];let first=true;const saved={key:'stale',text:'Other writer',revision:2,updatedAt:'now'};
  Object.assign(globalThis,{window:{backbone:{async call(method:string,args:any){
    if(method==='drafts.get') return saved;
    if(method==='drafts.put') {calls.push(structuredClone(args));if(first){first=false;throw new Error('lost acknowledgement');}return {ok:false,reason:'STALE_BASE',outcome:'REFUSED',detail:'Draft changed.'};}
    throw new Error(method);
  }}}});
  const path='../src/lib/drafts.ts?uncertain-stale';const drafts=await import(path);
  await assert.rejects(drafts.persistDraftNow('stale','Local'),/lost acknowledgement/);
  await assert.rejects(drafts.retryUncertainDraft('stale'),/Draft changed/);
  assert.deepEqual(calls[1],calls[0]);assert.equal(drafts.hasUncertainDraft('stale'),false);assert.equal(drafts.hasUnconfirmedDraft('stale'),true);
  await assert.rejects(drafts.persistDraftNow('stale','Newer local'),/Draft changed/);
  assert.equal(calls.length,2);assert.equal((await drafts.readDraft('stale'))?.text,'Newer local');assert.equal(saved.text,'Other writer');
});
