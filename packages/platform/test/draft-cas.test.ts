import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transitionDraft } from '../src/composition/draft-cas.ts';

test('a tombstone rejects delayed writes, with operation identity bound to metadata', () => {
  const a = transitionDraft(null, {key:'k', text:'first', meta:{baseVersion:1}, clientKey:'a', baseRevision:0}, 'time');
  assert.equal(a.state, 'accepted'); if (a.state !== 'accepted') return;
  assert.equal(transitionDraft(a.record, {key:'k', text:'first', meta:{baseVersion:2}, clientKey:'a', baseRevision:0}, 'time').state, 'conflict');
  const b = transitionDraft(a.record, {key:'k', text:'', clientKey:'b', baseRevision:1}, 'time');
  assert.equal(b.state, 'accepted'); if (b.state !== 'accepted') return;
  assert.equal(b.record.operations.length, 1, 'the record retains only the latest receipt');
  assert.equal(transitionDraft(b.record, {key:'k', text:'late', clientKey:'late', baseRevision:0}, 'time').state, 'stale');
  assert.equal(transitionDraft(b.record, {key:'k', text:'first', meta:{baseVersion:2}, clientKey:'a', baseRevision:0}, 'time').state, 'stale');
  assert.equal(transitionDraft(b.record, {key:'k', text:'first', meta:{baseVersion:1}, clientKey:'a', baseRevision:0}, 'time').state, 'stale');
});

test('legacy records migrate without dropping data and revisionless writes cannot replace them', async () => {
  const { decodeDraft, publicDraft } = await import('../src/composition/draft-cas.ts');
  const legacy = decodeDraft({key:'k', text:'saved', meta:{baseVersion:7}, updatedAt:'yesterday', clientKey:'old'}, 'k')!;
  assert.deepEqual(publicDraft(legacy), {key:'k', text:'saved', meta:{baseVersion:7}, updatedAt:'yesterday', revision:0});
  assert.equal(transitionDraft(legacy, {key:'k', text:'late', clientKey:'old-client'}, 'now').state, 'stale');
  const next = transitionDraft(legacy, {key:'k', text:'updated', meta:{baseVersion:7}, clientKey:'new', baseRevision:0}, 'now');
  assert.equal(next.state, 'accepted'); if (next.state !== 'accepted') return;
  assert.equal(next.record.revision,1); assert.equal(transitionDraft(next.record, {key:'k', text:'updated', meta:{baseVersion:7}, clientKey:'new', baseRevision:0}, 'later').state, 'accepted');
  assert.throws(() => decodeDraft({key:'k', text:'saved', updatedAt:'yesterday', revision:3, operations:[]}, 'k'), /invalid/);
});

test('two independent processes cannot both advance one durable revision', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs'); const { join } = await import('node:path'); const { tmpdir } = await import('node:os'); const { spawn } = await import('node:child_process'); const { fileURLToPath } = await import('node:url');
  const home = mkdtempSync(join(tmpdir(),'draft-cas-process-')); const fixture = fileURLToPath(new URL('./fixtures/draft-cas-process.ts', import.meta.url));
  const run = (key: string) => new Promise<string>((resolve,reject) => { const child=spawn(process.execPath,[fixture,home,key],{stdio:['ignore','pipe','pipe']}); let out='',err=''; child.stdout.on('data',d=>out+=d); child.stderr.on('data',d=>err+=d); child.on('error',reject); child.on('exit',code=>code===0?resolve(out):reject(new Error(err))); });
  try { assert.deepEqual((await Promise.all([run('a'),run('b')])).sort(), ['accepted','stale']); }
  finally { rmSync(home,{recursive:true,force:true}); }
});
