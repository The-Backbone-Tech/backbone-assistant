import assert from 'node:assert/strict';
import { test } from 'node:test';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return {promise, resolve};
}

test('a new view cannot replace an acknowledged clear revision with its earlier local read', async () => {
  const clear = deferred();
  const clearing = deferred();
  const puts: {text:string;baseRevision:number}[] = [];
  let saved = {key:'composer:project', text:'First', revision:1, updatedAt:'now'};
  Object.assign(globalThis, {window:{backbone:{async call(method:string, args:any) {
    if (method === 'drafts.get') return {...saved};
    if (method === 'drafts.put') {
      puts.push(structuredClone(args));
      if (args.text === '') { clearing.resolve(); await clear.promise; }
      if (args.baseRevision !== saved.revision) return {ok:false, reason:'STALE_BASE', detail:'Draft changed.'};
      saved = {...saved, text:args.text, revision:saved.revision + 1};
      return {ok:true, value:saved};
    }
    throw new Error(method);
  }}}});
  const drafts = await import('../src/lib/drafts.ts');
  drafts.acceptDraftRead(saved.key, 1);
  const cleared = drafts.persistDraftNow(saved.key, '');
  await clearing.promise;
  const opening = await drafts.readDraft(saved.key);
  assert.equal(opening?.text, '');
  clear.resolve();
  await cleared;
  // The composer also reads the unassigned draft before applying the opening read.
  // Its own clear can finish during that await.
  drafts.acceptDraftRead(saved.key, opening!.revision);
  await drafts.persistDraftNow(saved.key, 'Second', {sendKey:'second', sendHow:'send'});
  assert.deepEqual(puts.map(p => [p.text, p.baseRevision]), [['',1], ['Second',2]]);
});

test('an immediate send joins an in-flight autosave and uses its returned base', async () => {
  const started = deferred();
  const release = deferred();
  const bases: number[] = [];
  let revision = 0;
  Object.assign(globalThis, {window:{backbone:{async call(method:string, args:any) {
    assert.equal(method, 'drafts.put');
    bases.push(args.baseRevision);
    if (!args.meta?.sendKey) { started.resolve(); await release.promise; }
    if (args.baseRevision !== revision) return {ok:false, reason:'STALE_BASE', detail:'Draft changed.'};
    return {ok:true, value:{...args, revision:++revision, updatedAt:'now'}};
  }}}});
  const drafts = await import('../src/lib/drafts.ts');
  const autosave = drafts.persistDraftNow('composer:in-flight', 'Second');
  await started.promise;
  const send = drafts.persistDraftNow('composer:in-flight', 'Second', {sendKey:'second',sendHow:'send'});
  release.resolve();
  await Promise.all([autosave, send]);
  assert.deepEqual(bases, [0,1]);
});
