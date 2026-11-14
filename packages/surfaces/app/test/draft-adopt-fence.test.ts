import assert from 'node:assert/strict';
import { test } from 'node:test';

test('adopting a saved value fences an older request that arrives after the acknowledgement was lost', async () => {
  let saved = {key:'composer:fence',text:'Authoritative value',revision:1,updatedAt:'now'};
  let delayed: any;
  function apply(args: any) {
    if (args.baseRevision !== saved.revision) return {ok:false,reason:'STALE_BASE',detail:'Draft changed.'};
    saved = {key:args.key,text:args.text,revision:saved.revision+1,updatedAt:'now'};
    return {ok:true,value:saved};
  }
  Object.assign(globalThis,{window:{backbone:{async call(method:string,args:any) {
    if (method==='drafts.get') return {...saved};
    if (method==='drafts.put') {
      if (args.text==='Local value') { delayed=args; throw new Error('lost response'); }
      return apply(args);
    }
    throw new Error(method);
  }}}});
  const drafts = await import('../src/lib/drafts.ts');
  drafts.acceptDraftRead('composer:fence',1);
  await assert.rejects(drafts.persistDraftNow('composer:fence','Local value'),/lost response/);
  assert.equal((await drafts.readDraft('composer:fence'))?.text,'Local value');
  await drafts.useReviewedDraft('composer:fence',1);
  assert.equal(saved.revision,2);
  assert.equal(apply(delayed).ok,false);
  assert.equal(saved.text,'Authoritative value');
  assert.equal(drafts.hasUnconfirmedDraft('composer:fence'),false);
});
