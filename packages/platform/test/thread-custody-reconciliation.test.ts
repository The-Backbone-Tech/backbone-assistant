// Actual Core tests for closed-run and reclaimed-run receipt crossings. Use scripts/with-test-cluster.mjs.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { CoreLink } from '../src/composition/core.ts';
import { reconcileClosedCustody, reconcileReclaimedCustody, retainOriginalWrite, originalWrite } from '../src/composition/thread-custody.ts';
import { readJson, sha256, writeJson } from '../src/stub/fsx.ts';
import { memoryKeychain } from '../src/testing/keys.ts';

async function scenario(t: TestContext, shared = false) {
  const home = mkdtempSync(join(tmpdir(), 'custody-closed-core-'));
  let core: CoreLink | undefined;
  t.after(async () => { try { await core?.close(); } finally { rmSync(home, { recursive: true, force: true }); } });
  core = await CoreLink.open({ home, keys: memoryKeychain() });
  const task = shared
    ? await core.call<string>(core.person(), 'SELECT gov.create_task($1, $1, $2, NULL, $3)', [core.id.person, 'Synthetic shared custody task', 'workspace'])
    : await core.createTask('Synthetic custody reconciliation');
  const handle = await core.startRun(task);
  const context = { home, thread: 'thread', run: handle.run, turn: 'turn', project: 'project' };
  mkdirSync(join(home, 'threads'), { recursive: true });
  const path = join(home, 'threads', 'thread.json');
  writeJson(path, { summary: { id: 'thread', projectId: 'project' }, turns: [{ id: 'turn' }] });
  const target = { document: randomUUID(), name: 'draft.md', body: 'Saved original body.', baseVersion: null, sourceVersions: [], managed: true as const };
  const retained = new Map<string, { name: string; body: string }>();
  const retain = async (input = target) => {
    const original = await retainOriginalWrite(home, 'thread', handle.run, 'turn', 'project', input);
    retained.set(input.name, { name: input.name, body: input.body }); return original;
  };
  const checkpoint = () => ({ files: [...retained.values()] });
  const original = (name = target.name) => originalWrite(home, 'thread', handle.run, 'turn', 'project', name);
  return { core, handle, context, path, target, retain, original, checkpoint };
}

test('actual Core: only a closed run permits deletion, and a late proposal cannot follow', async t => {
  const s = await scenario(t); await s.retain();
  const before = readJson(s.path, {});
  assert.deepEqual(await reconcileClosedCustody(s.context, s.core), { status: 'not-closed' });
  assert.deepEqual(readJson(s.path, {}), before);
  await s.core.finishRun(s.handle, 'failed');
  assert.deepEqual(await reconcileClosedCustody(s.context, s.core), { status: 'reconciled', removed: 1, retained: 0, receipts: 0 });
  assert.equal(await s.original(), null);
  await assert.rejects(s.core.proposeWrite(s.handle, { document_id: s.target.document, title: s.target.name, content_sha256: sha256(s.target.body), base_version: null }, 'Late write must be refused', 'turn:draft.md'), /not_in_run|stale/);
  const { rows } = await s.core.read<{ count: number }>(s.core.system(), 'SELECT count(*)::int AS count FROM app.effects WHERE run_id = $1', [s.handle.run]);
  assert.equal(rows[0].count, 0, 'a refused late proposal created no receipt');
});

test('actual Core: its complete read protects UNKNOWN while deleting only a different unproposed key', async t => {
  const s = await scenario(t); await s.retain();
  const orphan = { ...s.target, name: 'unproposed.md', document: randomUUID(), body: 'Unproposed body.' };
  await s.retain(orphan);
  const effect = await s.core.proposeWrite(s.handle, { document_id: s.target.document, title: s.target.name, content_sha256: sha256(s.target.body), base_version: null }, 'Controlled unknown write', 'turn:draft.md');
  assert.equal(effect.status, 'allowed');
  const claim = await s.core.claimEffect(effect.id);
  assert.equal(await s.core.beginDispatch(effect.id, claim), true);
  await s.core.observe(effect.id, claim, 'unknown', sha256('Synthetic interrupted dispatch.'), 'No external execution in this test.');
  await s.core.finishRun(s.handle, 'failed');
  assert.deepEqual(await reconcileClosedCustody(s.context, s.core), { status: 'reconciled', removed: 1, retained: 1, receipts: 1 });
  assert.equal((await s.original())?.target.body, s.target.body);
  assert.equal(await s.original(orphan.name), null);
  assert.equal((await s.core.effect(effect.id)).status, 'unknown');
});


test('actual Core: a fresh reclaim fences the prior holder without replacing its run or marks', async t => {
  // Workspace visibility makes the SQL authentication predicate independently necessary; RLS alone is insufficient.
  const s = await scenario(t, true), original = await s.retain();
  await s.core.recordRead(s.handle, 'synthetic-external-source', 'Untrusted synthetic words.', null);
  const before = readJson(s.path, {});
  assert.deepEqual(await reconcileReclaimedCustody(s.context, s.core, s.handle, s.checkpoint()), { status: 'not-current' });
  assert.deepEqual(readJson(s.path, {}), before);
  const current = await s.core.reclaimRun(s.handle.run);
  assert.ok(current.fence > s.handle.fence);
  assert.deepEqual(await reconcileReclaimedCustody(s.context, s.core, { ...s.handle, fence: current.fence }, s.checkpoint()), { status: 'not-current' }, 'an old secret cannot authenticate by guessing the new fence');
  assert.deepEqual(readJson(s.path, {}), before);
  const state = async () => (await s.core.read<{ tainted_untrusted: boolean; mandate: unknown }>(s.core.system(),
    'SELECT r.id, r.task_id, r.agent_id, r.mandate_id, r.status, r.fence, r.tokens_used, r.cost_micros, r.tainted_untrusted, r.tainted_sensitive, to_jsonb(m) AS mandate FROM app.runs r JOIN app.mandates m ON m.workspace_id = r.workspace_id AND m.id = r.mandate_id WHERE r.id = $1', [current.run])).rows[0];
  const claimed = await state();
  assert.equal(claimed.tainted_untrusted, true);
  assert.deepEqual(await reconcileReclaimedCustody(s.context, s.core, current, s.checkpoint()), { status: 'reconciled', removed: 1, retained: 0, receipts: 0 });
  assert.deepEqual(await state(), claimed, 'cleanup preserves the observed run identity, mandate, budgets, marks and status');
  assert.equal(await s.original(), null);
  const stored = readJson<{ writeCustody: { unproposed: Record<string, Record<string, typeof original>> } }>(s.path, null!);
  assert.deepEqual(stored.writeCustody.unproposed['turn:' + original.target.name][original.digest], original);
  await assert.rejects(s.core.proposeWrite(s.handle, { document_id: s.target.document, title: s.target.name, content_sha256: sha256(s.target.body), base_version: null }, 'Fenced old holder', 'turn:draft.md'), /not_in_run|stale/);
  assert.equal((await s.core.read<{ count: number }>(s.core.system(), 'SELECT count(*)::int AS count FROM app.effects WHERE run_id = $1', [current.run])).rows[0].count, 0);
});

test('actual Core: a reclaimed holder retains a mismatched UNKNOWN and only archives the unproposed key', async t => {
  const s = await scenario(t), recorded = await s.retain();
  const orphan = await s.retain({ ...s.target, name: 'unproposed.md', document: randomUUID(), body: 'Unproposed body.' });
  const effect = await s.core.proposeWrite(s.handle, { document_id: s.target.document, title: s.target.name, content_sha256: sha256('Different recorded body.'), base_version: null }, 'Synthetic mismatched unknown', 'turn:draft.md');
  assert.equal(effect.status, 'allowed');
  const dispatch = await s.core.claimEffect(effect.id);
  assert.equal(await s.core.beginDispatch(effect.id, dispatch), true);
  await s.core.observe(effect.id, dispatch, 'unknown', sha256('No external execution.'), 'Synthetic interrupted dispatch.');
  const current = await s.core.reclaimRun(s.handle.run);
  assert.deepEqual(await reconcileReclaimedCustody(s.context, s.core, current, s.checkpoint()), { status: 'reconciled', removed: 1, retained: 1, receipts: 1 });
  assert.equal((await s.original())?.digest, recorded.digest);
  assert.equal(await s.original(orphan.target.name), null);
  const stored = readJson<{ writeCustody: { unproposed: Record<string, Record<string, typeof orphan>> } }>(s.path, null!);
  assert.deepEqual(stored.writeCustody.unproposed['turn:' + orphan.target.name][orphan.digest], orphan);
  assert.equal((await s.core.effect(effect.id)).status, 'unknown');
  assert.equal((await s.core.read<{ count: number }>(s.core.system(), 'SELECT count(*)::int AS count FROM app.effects WHERE run_id = $1', [current.run])).rows[0].count, 1, 'no replacement or replay was proposed');
});
