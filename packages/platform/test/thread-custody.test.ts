import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import {replaceHeldHomeLock} from './native-lock-observation.ts';
import { originalWrite, retainOriginalWrite, saveThreadProjection, custodyRun, unconfirmedCustody, settleUnproposedWrites, reconcileClosedCustody } from '../src/composition/thread-custody.ts';
import type { CoreLink } from '../src/composition/core.ts';
import type { StoredWrite } from '../src/composition/recovered-writes.ts';
import { readJson, sha256, writeJson } from '../src/stub/fsx.ts';

function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'thread-custody-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, 'threads', 'thread.json');
  mkdirSync(join(home, 'threads'));
  const projection = { summary: { id: 'thread', projectId: 'project', title: 'Original' }, turns: [{ id: 'turn' }], task: 'task', clientKeys: ['original-key'] };
  writeJson(path, projection);
  const target = { name: 'draft.md', document: 'draft', body: 'original body', baseVersion: null, managed: true as const,
    sourceVersions: [{ id: 'source', name: 'source.md', version: 1 }] };
  const retain = () => retainOriginalWrite(home, 'thread', 'run', 'turn', 'project', target);
  const original = () => originalWrite(home, 'thread', 'run', 'turn', 'project', target.name);
  return { home, path, projection, target, retain, original };
}

test('private custody freezes detached exact text, sources, target and managed mode', async (t) => {
  const s = setup(t);
  await s.retain();
  s.target.body = 'changed by caller';
  s.target.sourceVersions[0].version = 2;
  const original = await s.original();
  assert.equal(original?.target.body, 'original body');
  assert.equal(original?.target.sourceVersions?.[0].version, 1);
  assert.equal(original?.target.managed, true);
  await assert.rejects(s.retain(), /changed proposal/);
  assert.equal((await s.original())?.target.body, 'original body');
});

test('ordinary stale lifecycle writes cannot erase or forge private custody', async (t) => {
  const s = setup(t);
  const stale = structuredClone(s.projection);
  await Promise.all([s.retain(), saveThreadProjection(s.home, { ...stale, writeCustody: { version: 1, writes: {} } })]);
  assert.equal((await s.original())?.target.body, 'original body');
  await saveThreadProjection(s.home, { ...stale, summary: { ...stale.summary, title: 'Renamed' } });
  assert.equal((await s.original())?.target.sourceVersions?.[0].version, 1);
  assert.equal(readJson<typeof s.projection>(s.path, s.projection).summary.title, 'Renamed');
  await assert.rejects(saveThreadProjection(s.home, { ...stale, turns: [] }), /cannot remove stored work/);
  await assert.rejects(saveThreadProjection(s.home, { ...stale, task: 'different-task' }), /task cannot be replaced/);
  assert.equal((await s.original())?.run, 'run');
});

test('missing or corrupt custody never becomes a new valid original', async (t) => {
  const s = setup(t);
  assert.equal(await s.original(), null);
  await s.retain();
  const stored = readJson<Record<string, unknown>>(s.path, {});
  stored.writeCustody = { version: 1, writes: { 'turn:draft.md': { version: 1, target: s.target, digest: 'wrong' } } };
  writeJson(s.path, stored);
  assert.equal(await s.original(), null);
  await assert.rejects(s.retain(), /changed proposal/);
  stored.writeCustody = { version: 99, writes: {} };
  writeJson(s.path, stored);
  await assert.rejects(s.retain(), /custody is invalid/);
});

test('a proposal cannot cross the private thread project or bounded text identity', async (t) => {
  const s = setup(t);
  await assert.rejects(retainOriginalWrite(s.home, 'thread', 'run', 'turn', 'other-project', s.target), /owner could not be verified/);
  await assert.rejects(retainOriginalWrite(s.home, 'thread', 'run', 'turn', 'project', { ...s.target, name: '../escape.md' }), /bounded recoverable/);
  await assert.rejects(retainOriginalWrite(s.home, 'thread', 'run', 'turn', 'project', { ...s.target, body: 'x'.repeat(2_000_001) }), /bounded recoverable/);
  assert.equal(await s.original(), null);
});

test('lost proposal acknowledgement retains its original run without inventing a receipt', async (t) => {
  const s = setup(t);
  await s.retain();
  assert.equal(await custodyRun(s.home, 'thread', 'turn', 'project'), 'run');
  assert.equal(await unconfirmedCustody(s.home, 'thread', 'run', 'turn', 'project', []), true);
  const row = { id: 'original-effect', run: 'run', key: 'turn:draft.md', status: 'cancelled', args: { document_id: 'draft', title: 'draft.md', content_sha256: sha256(s.target.body), base_version: null } };
  assert.equal(await unconfirmedCustody(s.home, 'thread', 'run', 'turn', 'project', [row]), false);
  assert.equal((await s.original())?.target.body, 'original body');
});

test('a terminal receipt with the same title cannot clear a different original proposal', async (t) => {
  const s = setup(t);
  await s.retain();
  const row = { id: 'other-effect', run: 'run', key: 'turn:draft.md', status: 'cancelled',
    args: { document_id: 'different-document', title: 'draft.md', content_sha256: sha256('different body'), base_version: null } };
  assert.equal(await unconfirmedCustody(s.home, 'thread', 'run', 'turn', 'project', [row]), true);
  assert.equal(await unconfirmedCustody(s.home, 'thread', 'other-run', 'turn', 'project', [{ ...row, args: { ...row.args, document_id: 'draft', content_sha256: sha256(s.target.body) } }]), true);
});

// These reader fakes test private metadata handling only. The separate Core suite proves the
// closed-run crossing and complete receipt query against actual SQL.
function reader(rows: readonly StoredWrite[], status = 'failed') {
  const queries: string[] = [];
  const core = { system: () => ({ workspace: 'workspace' }), async read(_actor: unknown, sql: string) {
    queries.push(sql);
    return { rows: sql.includes('FROM app.runs') ? status === 'missing' ? [] : [{ status }] : rows };
  } } as unknown as Pick<CoreLink, 'system' | 'read'>;
  return { core, queries };
}
const reconcile = (s: ReturnType<typeof setup>, rows: readonly StoredWrite[], status = 'failed') =>
  reconcileClosedCustody({ home: s.home, thread: 'thread', run: 'run', turn: 'turn', project: 'project' }, reader(rows, status).core);
test('settlement keeps every recorded original while clearing only the unproposed name', async t => {
  const s = setup(t); await s.retain();
  const orphan = { ...s.target, name: 'pending.md', document: 'pending', body: 'Unproposed body.' };
  await retainOriginalWrite(s.home, 'thread', 'run', 'turn', 'project', orphan);
  const row = { id: 'recorded', run: 'run', key: 'turn:draft.md', status: 'unknown', args: { document_id: 'draft', title: 'draft.md', content_sha256: sha256(s.target.body), base_version: null } };
  assert.deepEqual(await reconcile(s, [row]), { status: 'reconciled', removed: 1, retained: 1, receipts: 1 });
  assert.equal((await s.original())?.target.body, 'original body');
  assert.equal(await originalWrite(s.home, 'thread', 'run', 'turn', 'project', orphan.name), null);
  assert.equal(await unconfirmedCustody(s.home, 'thread', 'run', 'turn', 'project', [row]), false);
});

test('settlement cannot erase an original behind a same-key mismatched receipt', async t => {
  const s = setup(t); await s.retain();
  const row = { id: 'recorded', run: 'run', key: 'turn:draft.md', status: 'succeeded', args: { document_id: 'other', title: 'draft.md', content_sha256: sha256('Different.'), base_version: null } };
  assert.deepEqual(await reconcile(s, [row]), { status: 'reconciled', removed: 0, retained: 1, receipts: 1 });
  assert.equal((await s.original())?.target.body, 'original body');
  assert.equal(await unconfirmedCustody(s.home, 'thread', 'run', 'turn', 'project', [row]), true);
});

for (const field of ['turn', 'project'] as const) test(`settlement preserves a valid-digest original with a foreign ${field}`, async t => {
  const s = setup(t); await s.retain();
  const stored = readJson<Record<string, unknown>>(s.path, {});
  const custody = stored.writeCustody as { writes: Record<string, Record<string, unknown>> };
  const original = custody.writes['turn:draft.md'];
  original[field] = 'another';
  const { digest: _digest, ...normalized } = original;
  original.digest = sha256(JSON.stringify(normalized));
  writeJson(s.path, stored);
  assert.equal(await settleUnproposedWrites(s.home, 'thread', 'run', 'turn', 'project'), false);
  assert.deepEqual(readJson(s.path, {}), stored);
});

test('settlement refuses an incomplete or foreign receipt list without changing custody', async t => {
  const s = setup(t); await s.retain();
  const before = readJson(s.path, {});
  for (const row of [
    { id: 'missing-key', run: 'run', status: 'unknown', args: { document_id: 'draft', title: 'draft.md', content_sha256: sha256(s.target.body), base_version: null } },
    { id: 'other-run', run: 'different', key: 'turn:draft.md', status: 'succeeded', args: { document_id: 'draft', title: 'draft.md', content_sha256: sha256(s.target.body), base_version: null } },
  ]) {
    assert.deepEqual(await reconcile(s, [row]), { status: 'invalid' });
    assert.deepEqual(readJson(s.path, {}), before);
  }
});

test('settlement of an unproposed original leaves another turn and thread projection intact', async t => {
  const s = setup(t); await s.retain();
  await retainOriginalWrite(s.home, 'thread', 'run-other', 'other-turn', 'project', { ...s.target, body: 'Other turn body.' });
  assert.equal(await settleUnproposedWrites(s.home, 'thread', 'run', 'turn', 'project'), true);
  assert.equal(await s.original(), null);
  assert.equal((await originalWrite(s.home, 'thread', 'run-other', 'other-turn', 'project', s.target.name))?.target.body, 'Other turn body.');
  const stored = readJson<typeof s.projection>(s.path, s.projection);
  assert.equal(stored.task, 'task'); assert.deepEqual(stored.turns, s.projection.turns);
});

for (const status of ['running', 'queued', 'waiting', 'missing']) test(`reconciliation never reads receipts or changes custody for a ${status} run`, async t => {
  const s = setup(t); await s.retain();
  const before = readJson(s.path, {}), fake = reader([], status);
  assert.deepEqual(await reconcileClosedCustody({ home: s.home, thread: 'thread', run: 'run', turn: 'turn', project: 'project' }, fake.core), { status: 'not-closed' });
  assert.equal(fake.queries.length, 1);
  assert.deepEqual(readJson(s.path, {}), before);
});

test('an unreadable Core receipt query leaves every original untouched', async t => {
  const s = setup(t); await s.retain();
  const before = readJson(s.path, {});
  const fake = reader([]);
  const read = fake.core.read;
  fake.core.read = async (...args) => { if (args[1].includes('FROM app.effects')) throw Error('Core unavailable.'); return read(...args); };
  await assert.rejects(reconcileClosedCustody({ home: s.home, thread: 'thread', run: 'run', turn: 'turn', project: 'project' }, fake.core), /Core unavailable/);
  assert.deepEqual(readJson(s.path, {}), before);
});

test('a lock-loss notification during a Core read keeps the private original intact', async t => {
  const s = setup(t); await s.retain();
  const before = readJson(s.path, {});
  const fake = reader([]);
  const read = fake.core.read;
  fake.core.read = async (...args) => {
    if (args[1].includes('FROM app.effects')) {
      const observed = await replaceHeldHomeLock(s.home);
      assert.ok(observed.aborted, 'the real home lock registered and delivered its integrity notification');
    }
    return read(...args);
  };
  await assert.rejects(reconcileClosedCustody({ home: s.home, thread: 'thread', run: 'run', turn: 'turn', project: 'project' }, fake.core), /home lock was lost/);
  assert.deepEqual(readJson(s.path, {}), before);
});
