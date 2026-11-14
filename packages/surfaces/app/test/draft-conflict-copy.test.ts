import assert from 'node:assert/strict';
import { test } from 'node:test';

test('a blocked local draft is durably copied before close and may be reviewed or discarded after restart', async () => {
  const records = new Map<string, any>([['composer:a',{key:'composer:a',text:'saved elsewhere',revision:1,updatedAt:'now'}]]);
  let failCopies = false;
  Object.assign(globalThis,{window:{backbone:{async call(method:string,args:any){
    if (method==='drafts.get') return records.get(args.key) ?? null;
    if (method==='drafts.put') {
      if (args.key.startsWith('draft-conflict:') && failCopies) throw new Error('offline');
      const old=records.get(args.key); if (args.baseRevision !== (old?.revision ?? 0)) return {ok:false,reason:'STALE_BASE',detail:'Draft changed.'};
      const next={key:args.key,text:args.text,meta:args.meta,revision:args.baseRevision+1,updatedAt:'now'};records.set(args.key,next);return {ok:true,value:next};
    }
    throw new Error(method);
  }}}});
  const drafts=await import('../src/lib/drafts.ts');
  await assert.rejects(drafts.persistDraftNow('composer:a','my local words',{attachments:'source'}),/changed/);
  await drafts.flushDrafts();
  assert.equal(records.get('composer:a').text,'saved elsewhere');
  const copies=await drafts.readConflictCopies('composer:a'); assert.equal(copies.length,1); assert.deepEqual({text:copies[0].text,meta:copies[0].meta},{text:'my local words',meta:{attachments:'source'}});
  const storedCopy = records.get('draft-conflict:composer:a');
  records.set('draft-conflict:composer:a', {...storedCopy, text:JSON.stringify([copies[0], copies[0]])});
  await assert.rejects(drafts.readConflictCopies('composer:a'), /duplicate identities/);
  records.set('draft-conflict:composer:a', storedCopy);
  const reopenedPath='../src/lib/drafts.ts?cold-conflict'; const reopened=await import(reopenedPath);
  assert.equal((await reopened.readConflictCopies('composer:a'))[0].text,'my local words');
  await drafts.useReviewedDraft('composer:a', 1);
  await reopened.discardConflictCopy('composer:a',copies[0].id); assert.deepEqual(await reopened.readConflictCopies('composer:a'),[]);
  assert.equal(records.get('composer:a').text,'saved elsewhere');
  records.set('composer:b',{key:'composer:b',text:'other',revision:1,updatedAt:'now'});
  await assert.rejects(drafts.persistDraftNow('composer:b','cannot save copy'),/changed/); failCopies=true;
  await assert.rejects(drafts.flushDrafts(), (e:unknown) => e instanceof drafts.ConflictCopyError && e.keys.includes('composer:b'));
  drafts.approveCloseWithoutConflictCopies(['composer:b']);
  await assert.rejects(drafts.persistDraftNow('composer:b','a newer local edit'), /changed/);
  await assert.rejects(drafts.flushDrafts(), (e:unknown) => e instanceof drafts.ConflictCopyError && e.keys.includes('composer:b'));
  drafts.approveCloseWithoutConflictCopies(['composer:b']);
  await drafts.flushDrafts(); // Explicit acknowledgement is required for exactly this local revision.
});
