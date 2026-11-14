import assert from 'node:assert/strict';
import { test } from 'node:test';

test('an uncertain write stays local and does not block another draft or retry itself', async () => {
  const puts: { key: string; baseRevision: number; text: string }[] = [];
  const saved = new Map<string, {revision:number; text:string}>();
  Object.assign(globalThis, {window: {backbone: {async call(method: string, args: any) {
    if (method === 'drafts.get') return saved.get(args.key) ?? null;
    if (method === 'drafts.put') {
      puts.push(args);
      if (args.key === 'a') throw new Error('lost acknowledgement');
      const record = {key:args.key, text:args.text, revision:args.baseRevision + 1, updatedAt:'now'}; saved.set(args.key,record); return {ok:true, value:record};
    }
    throw new Error(method);
  }}}});
  const {persistDraftNow, readDraft} = await import('../src/lib/drafts.ts');
  await assert.rejects(persistDraftNow('a', 'unsent words'), /lost acknowledgement/);
  await persistDraftNow('b', 'other document');
  assert.equal(saved.get('b')?.text, 'other document');
  assert.equal((await readDraft('a'))?.text, 'unsent words');
  await assert.rejects(persistDraftNow('a', 'newer local words'), /lost acknowledgement/);
  assert.equal((await readDraft('a'))?.text, 'newer local words');
  assert.equal(puts.filter(p => p.key === 'a').length, 1);
  assert.equal(puts.find(p => p.key === 'b')?.baseRevision, 0);
});
