// Actual Core: where a run's new document lands decides whether the rule of two treats the write as publishing.
// Use scripts/with-test-cluster.mjs.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { EffectRecord } from '../src/api.ts';
import { CoreLink } from '../src/composition/core.ts';
import { createDocumentGateway } from '../src/composition/document-writes.ts';
import { writeJson } from '../src/stub/fsx.ts';
import { MaterialStore } from '../src/stub/material.ts';
import { memoryKeychain } from '../src/testing/keys.ts';

async function taintedRun(t: TestContext, options: { visibility?: 'workspace'; taint?: false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agent-document-task-'));
  let core: CoreLink | undefined;
  t.after(async () => { try { await core?.close(); } finally { rmSync(home, { recursive: true, force: true }); } });
  core = await CoreLink.open({ home, keys: memoryKeychain() });
  const task = options.visibility
    ? await core.call<string>(core.person(), 'SELECT gov.create_task($1, $1, $2, NULL, $3)', [core.id.person, 'Synthetic workspace task', options.visibility])
    : await core.createTask('Synthetic private task');
  const handle = await core.startRun(task);
  // A restored original asserts no author (untrusted); the person's own words in a private task are private material.
  if (options.taint !== false) {
    // Arrange real typed file episodes through the system crossing: raw reserved material
    // inserts are now correctly refused. Keep both the unauthored and private-task sources.
    const record = async (material: string, content: string, author: string | null, sourceTask: string | null) => {
      const sha = (text: string) => createHash('sha256').update(text).digest('hex');
      await core!.call(core!.system(),
        'SELECT * FROM gov.record_material_source_read($1::text,$2::text,$3::integer,$4::integer,$5::text,$6::text,$7::jsonb,$8::text,$9::text,$10::text,$11::uuid,$12::uuid,$13::uuid,$14::uuid,$15::text)',
        ['project', material, 1, 0, sha(randomUUID()), sha(content), JSON.stringify({ kind: 'synthetic-rule-of-two-fixture', version: '1' }), 'file', content, content, author, handle.run, sourceTask, null, null]);
    };
    await record('restored', 'Synthetic restored source.', null, null);
    // The person's words from a private task of theirs are private material, whatever the run's own task.
    const privateTask = options.visibility ? await core.createTask('Synthetic private notes') : task;
    await record('person', 'Synthetic private note.', core.id.person, privateTask);
    const marks = (await core.read<{ untrusted: boolean; sensitive: boolean }>(core.system(),
      'SELECT tainted_untrusted AS untrusted, tainted_sensitive AS sensitive FROM app.runs WHERE id = $1', [handle.run])).rows[0];
    assert.deepEqual({ ...marks }, { untrusted: true, sensitive: true }, 'the run is marked both ways');
  }
  mkdirSync(join(home, 'threads'), { recursive: true });
  writeJson(join(home, 'threads', 'thread.json'), { summary: { id: 'thread', projectId: 'project' }, turns: [{ id: 'turn' }], task });
  const material = new MaterialStore(home, {}, () => {});
  let afterClaim: (() => Promise<void>) | undefined;
  let afterBegin: (() => Promise<void>) | undefined;
  // The real CoreLink; only claimEffect and beginDispatch are wrapped, to change the task's audience between routing and dispatch.
  const link = () => new Proxy(core!, { get(target, key, receiver) {
    if (key === 'claimEffect') return async (id: string) => { const claim = await target.claimEffect(id); await afterClaim?.(); return claim; };
    if (key === 'beginDispatch') return async (id: string, claim: string) => { const begun = await target.beginDispatch(id, claim); await afterBegin?.(); return begun; };
    const value = Reflect.get(target, key, receiver); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const gateway = (withTask: boolean, turnId = 'turn') => createDocumentGateway({ home, link: link(), handle, threadId: 'thread', turnId, projectId: 'project', material,
    projectDir: () => join(home, 'unused'), crash() {}, ...(withTask ? { task } : {}) });
  const write = async (withTask: boolean, name: string, document = randomUUID(), body = `Synthetic output for ${name}.`, turn = 'turn') => {
    const effect: EffectRecord = { key: '', kind: 'write-working-copy', target: name, outcome: 'UNKNOWN' };
    const existing = material.load(document);
    const entry = await gateway(withTask, turn).write({ document, name, body, baseVersion: existing?.current ?? null, sourceVersions: [] }, effect,
      async () => {
        if (!existing) return material.create('project', name, 'text/markdown', Buffer.from(body), 'working', 'agent', document);
        const saved = await material.save(document, body, existing.current, 'agent');
        if (!saved.ok) throw new Error(saved.detail);
        return saved.value;
      });
    const stored = (await core!.read<{ status: string; reason: string | null; task: string | null }>(core!.system(),
      "SELECT e.status, e.route_reason AS reason, d.task_id AS task FROM app.effects e LEFT JOIN app.documents d ON d.id = (e.args ->> 'document_id')::uuid WHERE e.id = $1", [effect.key])).rows[0];
    return { effect, entry, stored };
  };
  const share = async () => { await core!.call(core!.person(), 'SELECT gov.share_task($1)', [task]); };
  return { home, core, handle, task, material, write, shareAfterClaim() { afterClaim = share; }, shareAfterBegin() { afterBegin = share; } };
}

test('actual Core: a run marked both ways creates its new document in its own task without a checker', async t => {
  const s = await taintedRun(t);
  const { effect, entry, stored } = await s.write(true, 'inspection.md');
  assert.equal(effect.outcome, 'DONE');
  assert.ok(entry);
  assert.deepEqual({ ...stored }, { status: 'succeeded', reason: null, task: s.task }, 'the document lands in the run’s private task');
});

test('actual Core: the same write without a named task is publishing and waits for a checker, as before', async t => {
  const s = await taintedRun(t);
  const { effect, entry, stored } = await s.write(false, 'workspace.md');
  assert.equal(effect.outcome, 'REFUSED');
  assert.equal(entry, undefined);
  assert.deepEqual({ ...stored }, { status: 'awaiting_checker', reason: 'rule_of_two', task: null });
});

test('actual Core: a workspace-visible task is publishing, so the write is not given the task and waits for a checker', async t => {
  const s = await taintedRun(t, { visibility: 'workspace' });
  const { effect, stored } = await s.write(true, 'shared.md');
  assert.equal(effect.outcome, 'REFUSED');
  assert.deepEqual({ ...stored }, { status: 'awaiting_checker', reason: 'rule_of_two', task: null });
});

test('actual Core: a task shared after routing cancels the write before dispatch, and nothing is written', async t => {
  const s = await taintedRun(t);
  s.shareAfterClaim();
  const { effect, entry, stored } = await s.write(true, 'late-share.md');
  assert.equal(effect.outcome, 'REFUSED');
  assert.match(effect.detail ?? '', /shared after this write was routed/);
  assert.equal(entry, undefined);
  assert.deepEqual({ ...stored }, { status: 'cancelled', reason: null, task: null }, 'no document was created');
});

test('actual Core: a receipt proposed without a task keeps its original arguments when the write resumes', async t => {
  const s = await taintedRun(t, { taint: false });
  const document = randomUUID(), name = 'resumed.md', body = `Synthetic output for ${name}.`;
  const { sha256 } = await import('../src/stub/fsx.ts');
  const old = await s.core.proposeWrite(s.handle, { document_id: document, title: name, content_sha256: sha256(body), base_version: null }, 'Pre-upgrade receipt', `turn:${name}`);
  assert.equal(old.status, 'allowed');
  const { retainOriginalWrite } = await import('../src/composition/thread-custody.ts');
  await retainOriginalWrite(s.home, 'thread', s.handle.run, 'turn', 'project', { document, name, body, baseVersion: null, sourceVersions: [] });
  const { effect, stored } = await s.write(true, name, document);
  assert.equal(effect.outcome, 'DONE');
  assert.equal(effect.key, old.id, 'the original receipt was used, not a new proposal');
  assert.deepEqual({ ...stored }, { status: 'succeeded', reason: null, task: null }, 'the original task-less arguments were kept');
});

test('actual Core: a task shared after the Host’s last check and before Core records the document is refused by Core under lock', async t => {
  const s = await taintedRun(t);
  s.shareAfterBegin();
  const { effect, entry, stored } = await s.write(true, 'mid-dispatch-share.md');
  assert.equal(effect.outcome, 'REFUSED');
  assert.match(effect.detail ?? '', /shared during the write/);
  assert.equal(entry, undefined);
  assert.deepEqual({ ...stored }, { status: 'failed', reason: null, task: null }, 'Core recorded no document');
  const local = s.material.load(JSON.parse(JSON.stringify((await s.core.read<{ args: { document_id: string } }>(s.core.system(), 'SELECT args FROM app.effects WHERE id = $1', [effect.key])).rows[0].args)).document_id);
  assert.equal(local?.hidden, true, 'the new working copy was withdrawn, so the project agrees with the receipt');
});

test('actual Core: an update shared mid-dispatch is refused by Core and the working copy is put back', async t => {
  const s = await taintedRun(t);
  const document = randomUUID();
  const first = await s.write(true, 'kept.md', document, 'First version.');
  assert.equal(first.effect.outcome, 'DONE');
  s.shareAfterBegin();
  const { effect } = await s.write(true, 'kept.md', document, 'Second version.', 'turn2');
  assert.equal(effect.outcome, 'REFUSED');
  assert.match(effect.detail ?? '', /put back to its content at version 1/);
  const local = s.material.load(document)!;
  assert.equal(Buffer.from(s.material.bytes(document, local.current)).toString('utf8'), 'First version.');
  const core = (await s.core.read<{ content: string }>(s.core.system(), 'SELECT content FROM app.documents WHERE id = $1', [document])).rows[0];
  assert.equal(core.content, 'First version.', 'Core kept its version');
  assert.match(effect.detail ?? '', /refused version stays in this project's local history on this device and was never recorded in Core/);
  assert.equal(Buffer.from(s.material.bytes(document, local.current - 1)).toString('utf8'), 'Second version.', 'the residue is the local history the detail names');
  const versions = (await s.core.read<{ n: number }>(s.core.system(), 'SELECT count(*)::int AS n FROM app.document_versions WHERE document_id = $1', [document])).rows[0];
  assert.ok(versions.n <= 1, 'Core has no version of the refused content');
});

test('actual Core: an untainted run’s write is not cancelled when its task is shared; no exemption was used', async t => {
  const s = await taintedRun(t, { taint: false });
  s.shareAfterClaim();
  const { effect, stored } = await s.write(true, 'plain.md');
  assert.equal(effect.outcome, 'DONE');
  assert.deepEqual({ ...stored }, { status: 'succeeded', reason: null, task: s.task });
});

test('actual Core: dispatch writes only the document its receipt names', async t => {
  const s = await taintedRun(t, { taint: false });
  const named = randomUUID();
  const proposed = await s.core.proposeWrite(s.handle, { document_id: named, title: 'named.md', content_sha256: 'd'.repeat(64), base_version: null }, 'Named write', 'turn:named.md');
  const claim = await s.core.claimEffect(proposed.id);
  assert.equal(await s.core.beginDispatch(proposed.id, claim), true);
  await assert.rejects(s.core.writeDocument(proposed.id, randomUUID(), 'other.md', 'Other.'), /writes the document its arguments name/);
});

test('actual Core: a document write whose receipt names no document is never dispatched to one', async t => {
  const s = await taintedRun(t, { taint: false });
  const proposed = await s.core.proposeWrite(s.handle, { title: 'nameless.md', content_sha256: 'e'.repeat(64), base_version: null }, 'Nameless write', 'turn:nameless.md');
  const claim = await s.core.claimEffect(proposed.id);
  assert.equal(await s.core.beginDispatch(proposed.id, claim), true);
  await assert.rejects(s.core.writeDocument(proposed.id, randomUUID(), 'any.md', 'Any.'), /writes the document its arguments name/);
});

test('actual Core: the run\'s own task gives no exemption once it is shared; a write naming it waits for a checker', async t => {
  const s = await taintedRun(t);
  await s.core.call(s.core.person(), 'SELECT gov.share_task($1)', [s.task]);
  const proposed = await s.core.proposeWrite(s.handle, { document_id: randomUUID(), title: 'own.md', content_sha256: 'a'.repeat(64), base_version: null, task_id: s.task },
    'Write into the run\'s own, now shared, task', 'turn:own.md');
  assert.deepEqual({ status: proposed.status, reason: proposed.routeReason }, { status: 'awaiting_checker', reason: 'rule_of_two' });
});

test('actual Core: an UNKNOWN write without a task blocks the same write that now names one', async t => {
  const s = await taintedRun(t, { taint: false });
  const args = { document_id: randomUUID(), title: 'repeat.md', content_sha256: 'b'.repeat(64), base_version: null };
  const old = await s.core.proposeWrite(s.handle, args, 'Pre-upgrade receipt', 'turn:repeat.md');
  const claim = await s.core.claimEffect(old.id);
  assert.equal(await s.core.beginDispatch(old.id, claim), true);
  await s.core.observe(old.id, claim, 'unknown', 'c'.repeat(64), 'Synthetic unresolved write.');
  const again = await s.core.proposeWrite(s.handle, { ...args, task_id: s.task }, 'Same write, new format', 'turn2:repeat.md');
  assert.deepEqual({ status: again.status, reason: again.routeReason, repeatOf: again.repeatOf }, { status: 'denied', reason: 'repeat_unknown_blocked', repeatOf: old.id });
});
