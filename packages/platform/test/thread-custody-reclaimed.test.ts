// Private metadata controls only; real-Core and actual Host recovery have separate tests.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import {replaceHeldHomeLock} from './native-lock-observation.ts';
import type { CoreLink, RunHandle } from '../src/composition/core.ts';
import { custodyRun, originalWrite, reconcileReclaimedCustody, retainOriginalWrite, saveThreadProjection, type WriteTarget } from '../src/composition/thread-custody.ts';
import { readJson, sha256, writeJson } from '../src/stub/fsx.ts';

type View = Pick<CoreLink, 'system' | 'runOf' | 'read'>;
function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'custody-reclaimed-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, 'threads'));
  const path = join(home, 'threads', 'thread.json');
  const projection = { summary: { id: 'thread', projectId: 'project' }, turns: [{ id: 'turn' }] };
  writeJson(path, projection);
  const context = { home, thread: 'thread', run: 'run', turn: 'turn', project: 'project' };
  const handle: RunHandle = { run: 'run', fence: 2, secret: 'synthetic-not-a-real-claim' };
  const target: WriteTarget = { name: 'draft.md', document: 'draft', body: 'Original checkpoint body.', baseVersion: null, managed: true as const,
    sourceVersions: [{ id: 'source', name: 'source.md', version: 1 }] };
  const retained = new Map<string, { name: string; body: string }>();
  const retain = async (input = target, options?: { checkpointRecovery?: true }) => {
    const original = await retainOriginalWrite(home, 'thread', 'run', 'turn', 'project', input, options);
    retained.set(input.name, { name: input.name, body: input.body }); return original;
  };
  const checkpoint = () => ({ files: [...retained.values()] });
  return { home, path, projection, context, handle, target, retain, checkpoint, bytes: () => readFileSync(path, 'utf8') };
}
function view(rows: unknown[] = []) {
  const calls: { kind: string; sql: string; params: unknown[] }[] = [];
  const control: {authenticated:boolean;afterRead:(kind:string)=>void|Promise<void>} = { authenticated: true, afterRead: () => {} };
  const core = {
    system: () => ({ kind: 'system' }),
    runOf: (h: RunHandle) => ({ kind: 'claim', run: h.run, secret: h.secret }),
    async read(actor: { kind: string }, sql: string, params: unknown[] = []) {
      calls.push({ kind: actor.kind, sql, params });
      const result = actor.kind === 'claim' ? control.authenticated ? [{ id: 'run' }] : [] : rows;
      await control.afterRead(actor.kind);
      return { rows: result };
    },
  } as unknown as View;
  return { core, calls, control };
}

test('a reclaimed boundary archives only unproposed originals and preserves every recorded key', async t => {
  const s = setup(t), recorded = await s.retain();
  const pending = await s.retain({ ...s.target, name: 'pending.md', document: 'pending', body: 'Unproposed work.' });
  const v = view([{ run: 'run', key: 'turn:draft.md' }, { run: 'run', key: 'turn:another-operation' }]);
  assert.deepEqual(await reconcileReclaimedCustody(s.context, v.core, s.handle, s.checkpoint()), { status: 'reconciled', removed: 1, retained: 1, receipts: 2 });
  assert.equal((await originalWrite(s.home, 'thread', 'run', 'turn', 'project', 'draft.md'))?.digest, recorded.digest);
  assert.equal(await originalWrite(s.home, 'thread', 'run', 'turn', 'project', 'pending.md'), null);
  const stored = readJson<{ writeCustody: { unproposed: Record<string, Record<string, typeof pending>> } }>(s.path, null!);
  assert.deepEqual(stored.writeCustody.unproposed['turn:' + pending.target.name][pending.digest], pending, 'exact body and original source binding stay private and inert');
  assert.deepEqual(v.calls.map(call => call.kind), ['claim', 'system', 'claim']);
  assert.deepEqual(v.calls[1].params, ['run']);
  assert.doesNotMatch(v.calls[1].sql, /operation|LIKE|LIMIT/i, 'read the complete run key set, not only document receipts');
});

test('an initial, foreign or unauthenticated handle cannot remove private custody', async t => {
  const s = setup(t); await s.retain(); const before = s.bytes();
  for (const handle of [{ ...s.handle, fence: 1 }, { ...s.handle, run: 'other' }, { ...s.handle, secret: '' }]) {
    const v = view();
    assert.deepEqual(await reconcileReclaimedCustody(s.context, v.core, handle, s.checkpoint()), { status: 'not-current' });
    assert.equal(s.bytes(), before); assert.equal(v.calls.length, 0);
  }
  const v = view(); v.control.authenticated = false;
  assert.deepEqual(await reconcileReclaimedCustody(s.context, v.core, s.handle, s.checkpoint()), { status: 'not-current' });
  assert.equal(s.bytes(), before); assert.deepEqual(v.calls.map(call => call.kind), ['claim']);
});

test('losing the current claim during the receipt read preserves all active originals', async t => {
  const s = setup(t); await s.retain(); const before = s.bytes(); const v = view();
  v.control.afterRead = kind => { if (kind === 'system') v.control.authenticated = false; };
  assert.deepEqual(await reconcileReclaimedCustody(s.context, v.core, s.handle, s.checkpoint()), { status: 'not-current' });
  assert.equal(s.bytes(), before);
});

test('foreign or malformed receipt rows never become proof that an original is unproposed', async t => {
  const s = setup(t); await s.retain(); const before = s.bytes();
  for (const row of [{ run: 'foreign', key: 'turn:draft.md' }, { run: 'run' }, { run: 'run', key: null }]) {
    assert.deepEqual(await reconcileReclaimedCustody(s.context, view([row]).core, s.handle, s.checkpoint()), { status: 'invalid' });
    assert.equal(s.bytes(), before);
  }
});

test('historical custody stays inert and survives a stale ordinary projection', async t => {
  const s = setup(t), original = await s.retain();
  assert.equal((await reconcileReclaimedCustody(s.context, view().core, s.handle, s.checkpoint())).status, 'reconciled');
  assert.equal(await custodyRun(s.home, 'thread', 'turn', 'project'), null, 'inert history never requests recovery or authorizes a replay');
  await saveThreadProjection(s.home, s.projection);
  const stored = readJson<{ writeCustody: { unproposed: Record<string, Record<string, typeof original>> } }>(s.path, null!);
  assert.deepEqual(stored.writeCustody.unproposed['turn:' + original.target.name][original.digest], original);
});

test('a conflicting historical entry cannot be replaced while clearing its active original', async t => {
  const s = setup(t), original = await s.retain();
  const stored = readJson<{ writeCustody: Record<string, unknown> }>(s.path, null!);
  stored.writeCustody.unproposed = { ['turn:' + s.target.name]: { [original.digest]: { version: 1 } } }; writeJson(s.path, stored);
  const before = s.bytes();
  assert.deepEqual(await reconcileReclaimedCustody(s.context, view().core, s.handle, s.checkpoint()), { status: 'invalid' });
  assert.equal(s.bytes(), before);
});

for (const phase of [1, 2, 3]) test('a lost home lock at Core wait ' + phase + ' preserves active and historical custody', async t => {
  const s = setup(t); await s.retain(); const before = s.bytes();
  const v = view(); let reads = 0;
  v.control.afterRead = async () => { if (++reads === phase) { const observed=await replaceHeldHomeLock(s.home);assert.ok(observed.aborted); } };
  await assert.rejects(reconcileReclaimedCustody(s.context, v.core, s.handle, s.checkpoint()), /data folder lock was lost/);
  assert.equal(s.bytes(), before);
});

for (const phase of [1, 2, 3]) test('a Core failure at wait ' + phase + ' cannot clear private originals', async t => {
  const s = setup(t); await s.retain(); const before = s.bytes(); const v = view(); let reads = 0;
  v.control.afterRead = () => { if (++reads === phase) throw new Error('Controlled Core read failure.'); };
  await assert.rejects(reconcileReclaimedCustody(s.context, v.core, s.handle, s.checkpoint()), /Core read failure/);
  assert.equal(s.bytes(), before);
});


test('retirement requires the exact original body in its durable checkpoint identity', async t => {
  const s = setup(t); await s.retain(); const before = s.bytes();
  for (const checkpoint of [undefined, { files: [] }, { files: [{ name: 'elsewhere.md', body: s.target.body }] }, { files: [{ name: s.target.name, body: 'Different body.' }] }]) {
    assert.deepEqual(await reconcileReclaimedCustody(s.context, view().core, s.handle, checkpoint), { status: 'invalid' });
    assert.equal(s.bytes(), before);
  }
});

test('an archived turn and name cannot accept a changed body as a new original', async t => {
  const s = setup(t); await s.retain();
  assert.equal((await reconcileReclaimedCustody(s.context, view().core, s.handle, s.checkpoint())).status, 'reconciled');
  const before = s.bytes();
  await assert.rejects(s.retain({ ...s.target, body: 'A changed intent.' }), /archived original/);
  await assert.rejects(s.retain({ ...s.target, sourceVersions: [] }, { checkpointRecovery: true }), /archived original/);
  await assert.rejects(s.retain({ ...s.target, held: { id: 'withdrawn', name: 'withdrawn.md' }, sourceVersions: [] }, { checkpointRecovery: true }), /archived original/);
  assert.equal(s.bytes(), before);
});

test('only checkpoint recovery may narrow held source preconditions, never change its intent or add a source', async t => {
  const s = setup(t);
  const held = { ...s.target, held: { id: 'withdrawn', name: 'withdrawn.md' } };
  await s.retain(held);
  assert.equal((await reconcileReclaimedCustody(s.context, view().core, s.handle, s.checkpoint())).status, 'reconciled');
  const narrowed = { ...held, sourceVersions: [] };
  await assert.rejects(s.retain(narrowed), /archived original/);
  await assert.rejects(s.retain({ ...narrowed, body: 'Changed body.' }, { checkpointRecovery: true }), /archived original/);
  await assert.rejects(s.retain({ ...s.target, sourceVersions: [] }, { checkpointRecovery: true }), /archived original/);
  await assert.rejects(s.retain({ ...narrowed, sourceVersions: [{ id: 'added', name: 'added.md', version: 1 }] }, { checkpointRecovery: true }), /archived original/);
  for (const marker of [{ ...held.held, id: 'unrelated-source' }, { ...held.held, name: 'unrelated.md' }, { ...held.held, changed: true as const }]) {
    await assert.rejects(s.retain({ ...narrowed, held: marker }, { checkpointRecovery: true }), /archived original/);
  }
  const original = await s.retain(narrowed, { checkpointRecovery: true });
  assert.deepEqual(original.target.sourceVersions, []);
  assert.equal(original.target.body, held.body);
});


test('unrelated inert history stays opaque and cannot block a current retirement', async t => {
  const s = setup(t), original = await s.retain();
  const stored = readJson<{ writeCustody: Record<string, unknown> }>(s.path, null!);
  const legacy = { version: 99, opaque: ['retained, unsupported historical evidence'] };
  stored.writeCustody.unproposed = { 'old-turn:legacy.md': legacy }; writeJson(s.path, stored);
  assert.equal((await reconcileReclaimedCustody(s.context, view().core, s.handle, s.checkpoint())).status, 'reconciled');
  const kept = readJson<{ writeCustody: { unproposed: Record<string, unknown> } }>(s.path, null!);
  assert.deepEqual(kept.writeCustody.unproposed['old-turn:legacy.md'], legacy);
  assert.ok(kept.writeCustody.unproposed['turn:' + original.target.name]);
});

test('a held alias requires a connected Host-owned checkpoint route with the same bytes', async t => {
  const s = setup(t);
  const held = { ...s.target, name: 'reports/draft (held).md', held: { id: 'withdrawn', name: 'source.md' } };
  await s.retain(held); const before = s.bytes();
  const file = { name: 'reports/draft.md', body: held.body };
  assert.deepEqual(await reconcileReclaimedCustody(s.context, view().core, s.handle, { files: [file], imports: [{ name: 'orphan.md', target: held.name, requested: file.name }] }), { status: 'invalid' });
  assert.equal(s.bytes(), before);
  assert.equal((await reconcileReclaimedCustody(s.context, view().core, s.handle, { files: [file], imports: [{ name: file.name, target: held.name, requested: file.name }] })).status, 'reconciled');
});


test('historical v1 data remains readable when current source eligibility is stricter', async t => {
  const s = setup(t), held = { id: 'withdrawn', name: 'withdrawn.md' };
  // A checksum-valid older record; the old source name is ineligible for a new proposal today.
  const data = { version: 1, run: 'run', turn: 'turn', project: 'project', target: {
    document: s.target.document, name: s.target.name, body: s.target.body, baseVersion: s.target.baseVersion,
    sourceVersions: [{ id: 'legacy-source', name: 'x'.repeat(1100), version: 1 }], managed: true, held,
  } };
  const original = { ...data, digest: sha256(JSON.stringify(data)) };
  const stored = readJson<Record<string, unknown>>(s.path, {});
  stored.writeCustody = { version: 1, writes: {}, unproposed: { ['turn:' + s.target.name]: { [original.digest]: original } } };
  writeJson(s.path, stored);
  const retained = await s.retain({ ...s.target, held, sourceVersions: [] }, { checkpointRecovery: true });
  assert.deepEqual(retained.target.sourceVersions, []);
  assert.equal(retained.target.body, original.target.body, 'history checks data identity, not permission to read its old source');
});


test('held recovery cannot change the document, base version or managed mode of an archived intent', async t => {
  const s = setup(t), held = { ...s.target, held: { id: 'withdrawn', name: 'withdrawn.md' } };
  await s.retain(held);
  assert.equal((await reconcileReclaimedCustody(s.context, view().core, s.handle, s.checkpoint())).status, 'reconciled');
  const narrowed = { ...held, sourceVersions: [] };
  const unmanaged = { ...narrowed }; delete unmanaged.managed;
  const before = s.bytes();
  for (const target of [{ ...narrowed, document: 'other-document' }, { ...narrowed, baseVersion: 1 }, unmanaged]) {
    await assert.rejects(s.retain(target, { checkpointRecovery: true }), /archived original/);
    assert.equal(s.bytes(), before);
  }
});

test('retirement never overwrites different historical evidence with the same canonical digest', async t => {
  const s = setup(t), original = await s.retain();
  const stored = readJson<{ writeCustody: Record<string, unknown> }>(s.path, null!);
  stored.writeCustody.unproposed = { ['turn:' + original.target.name]: { [original.digest]: { ...original, historicalNote: 'Preserve this existing evidence.' } } };
  writeJson(s.path, stored); const before = s.bytes();
  assert.deepEqual(await reconcileReclaimedCustody(s.context, view().core, s.handle, s.checkpoint()), { status: 'invalid' });
  assert.equal(s.bytes(), before);
});


test('a checkpoint before the first reservation needs no custody cleanup, while a present malformed envelope stays invalid', async t => {
  const s = setup(t), before = s.bytes();
  const v = view();
  assert.deepEqual(await reconcileReclaimedCustody(s.context, v.core, s.handle, { files: [{ name: 'draft.md', body: 'Checkpoint predates custody.' }] }), { status: 'reconciled', removed: 0, retained: 0, receipts: 0 });
  assert.equal(s.bytes(), before, 'absence does not create a private envelope');
  assert.deepEqual(v.calls.map(call => call.kind), ['claim', 'system', 'claim'], 'empty custody still requires current authenticated ownership');
  writeJson(s.path, { ...s.projection, writeCustody: null });
  const malformed = s.bytes();
  assert.deepEqual(await reconcileReclaimedCustody(s.context, view().core, s.handle, s.checkpoint()), { status: 'invalid' });
  assert.equal(s.bytes(), malformed, 'a corrupt present envelope is never treated as absent');
});


test('only checkpoint recovery can locate the original run through inert history', async t => {
  const s = setup(t); await s.retain();
  await reconcileReclaimedCustody(s.context, view().core, s.handle, s.checkpoint());
  assert.equal(await custodyRun(s.home, 'thread', 'turn', 'project'), null, 'ordinary admission does not revive history');
  assert.equal(await custodyRun(s.home, 'thread', 'turn', 'project', true), 'run', 'the durable checkpoint keeps the exact original run discoverable');
  const stored = JSON.parse(s.bytes());
  const history = stored.writeCustody.unproposed['turn:draft.md'];
  const original = Object.values(history)[0] as { digest: string; run: string };
  const cleanHistory = JSON.stringify(history);
  (original as unknown as { target: { body: string } }).target.body = 'Changed without a matching checksum.';
  writeJson(s.path, stored);
  await assert.rejects(custodyRun(s.home, 'thread', 'turn', 'project', true), /original run|invalid/i);
  stored.writeCustody.unproposed['turn:draft.md'] = JSON.parse(cleanHistory);
  const restored = Object.values(stored.writeCustody.unproposed['turn:draft.md'])[0] as { digest: string; run: string };
  const { digest: _, ...payload } = restored;
  const conflicting = { ...payload, run: 'other-run' };
  stored.writeCustody.unproposed['turn:draft.md'][sha256(JSON.stringify(conflicting))] = { ...conflicting, digest: sha256(JSON.stringify(conflicting)) };
  writeJson(s.path, stored);
  await assert.rejects(custodyRun(s.home, 'thread', 'turn', 'project', true), /original run|ambiguous/i, 'conflicting inert data never falls back to the newest task run');
});
