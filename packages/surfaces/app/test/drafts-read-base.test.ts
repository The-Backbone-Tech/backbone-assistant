import assert from 'node:assert/strict';
import { test } from 'node:test';

test('unseen or discarded reads never silently advance a draft base', async () => {
  const puts: {key:string;baseRevision:number}[] = [];
  const records = new Map([['unseen',{key:'unseen', text:'newer', revision:3, updatedAt:'now'}], ['discarded',{key:'discarded', text:'newer', revision:4, updatedAt:'now'}], ['seen',{key:'seen', text:'shown', revision:5, updatedAt:'now'}]]);
  Object.assign(globalThis,{window:{backbone:{async call(method:string,args:any) {
    if (method==='drafts.get') return records.get(args.key) ?? null;
    if (method==='drafts.put') { puts.push(args); const current=records.get(args.key); if (args.baseRevision !== (current?.revision ?? 0)) return {ok:false,reason:'STALE_BASE',detail:'Draft changed.'}; const next={key:args.key,text:args.text,revision:args.baseRevision+1,updatedAt:'now'}; records.set(args.key,next);return {ok:true,value:next}; }
    throw new Error(method);
  }}}});
  const {persistDraftNow,readDraft,acceptDraftRead}=await import('../src/lib/drafts.ts');
  await assert.rejects(persistDraftNow('unseen','local'),/changed/);
  await readDraft('discarded'); // This response was discarded by the UI, not applied.
  await assert.rejects(persistDraftNow('discarded','local'),/changed/);
  const visible=await readDraft('seen'); acceptDraftRead('seen',visible!.revision);
  await persistDraftNow('seen','user edit');
  assert.deepEqual(puts.map(p=>[p.key,p.baseRevision]),[['unseen',0],['discarded',0],['seen',5]]);
  assert.equal(records.get('unseen')?.text,'newer'); assert.equal(records.get('discarded')?.text,'newer');
});
