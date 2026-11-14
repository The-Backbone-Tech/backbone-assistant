import { hangDetector } from '../../../scripts/lib/test-hang.ts';
import { waitFor } from '../../../scripts/lib/test-hang.ts';
import { childHangTimer } from '../../../scripts/lib/test-child.ts';
// Real gateway/SQL crash cuts on a controlled native-port producer. No vendor, external model,
// API credential, UI process or business-system effect. Run only in the allocated shared slot.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { pieceDigest, pieceFiles } from '../src/pieces/digest.ts';
import { createHost, removeDataHome, type Host } from '../src/composition/host.ts';
import { CoreLink } from '../src/composition/core.ts';
import { PIECE_DIRS } from '../src/composition/pieces.ts';
import { freshDataHome } from '../src/testing/data-home.ts';
import { MaterialStore } from '../src/stub/material.ts';
import { readJson, writeJson } from '../src/stub/fsx.ts';
import type { Thread, Receipt } from '../src/api.ts';

const homes = new Set<string>();
const hosts = new Set<Host>();
const savedHarness = process.env.BACKBONE_HARNESS;
const savedModel = process.env.BACKBONE_CODEX_MODEL;
const savedStarts = process.env.BACKBONE_TEST_STARTS;
process.env.BACKBONE_HARNESS = 'harness-codex';
process.env.BACKBONE_CODEX_MODEL = 'controlled';
const fixture = mkdtempSync(join(tmpdir(), 'backbone-controlled-native-'));
for (const rel of pieceFiles(PIECE_DIRS['harness-codex'])) {
  const to = join(fixture, rel); mkdirSync(dirname(to), { recursive: true }); copyFileSync(join(PIECE_DIRS['harness-codex'], rel), to);
}
writeFileSync(join(fixture, 'src', 'index.ts'), readFileSync(join(import.meta.dirname, 'fixtures', 'controlled-native.mjs')));
const manifestPath = join(fixture, 'backbone.module.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
writeJson(manifestPath, { ...manifest, digest: pieceDigest(fixture) });
after(async () => {
  for (const host of hosts) host.close();
  for (const home of homes) { await CoreLink.whenClosed(home); await removeDataHome(home); }
  rmSync(fixture, { recursive: true, force: true });
  if (savedHarness === undefined) delete process.env.BACKBONE_HARNESS; else process.env.BACKBONE_HARNESS = savedHarness;
  if (savedModel === undefined) delete process.env.BACKBONE_CODEX_MODEL; else process.env.BACKBONE_CODEX_MODEL = savedModel;
  if (savedStarts === undefined) delete process.env.BACKBONE_TEST_STARTS; else process.env.BACKBONE_TEST_STARTS = savedStarts;
});
function value<T>(receipt: Receipt<T>): T { if (!receipt.ok) throw new Error(receipt.detail); return receipt.value; }
async function settled(host: Host, thread: string): Promise<Thread> {
  let result: Thread | undefined;
  await waitFor(async()=>{result=value(await host.call('threads.get',{id:thread}));return !result.summary.running;},'original recovery settlement',{diagnostic:()=>JSON.stringify(result?.summary)});
  return result!;
}
async function scenario(t: TestContext, cut: string, twoWrites = false) {
  const home = freshDataHome('document-recovery-db'); homes.add(home);
  const localHosts = new Set<Host>();
  const close = (host: Host) => { host.close(); localHosts.delete(host); hosts.delete(host); };
  t.after(async () => {
    for (const host of localHosts) close(host);
    await CoreLink.whenClosed(home); await removeDataHome(home); homes.delete(home);
  });
  const starts = join(home, 'controlled-starts.txt');
  const child = spawn(process.execPath, [join(import.meta.dirname, 'crash-document.ts'), home, fixture], {
    env: { ...process.env, BACKBONE_CRASH_AT: cut, BACKBONE_CRASH_OCCURRENCE: twoWrites ? '2' : '1', BACKBONE_TEST_TWO_WRITES: twoWrites ? '1' : '', BACKBONE_TEST_CHECKPOINT: cut === 'checkpoint' ? '1' : cut === 'checkpoint-revision' ? 'revision' : '', BACKBONE_TEST_STARTS: starts, BACKBONE_MODEL_ENDPOINT: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  child.stdout.on('data', (bytes: Buffer) => { out += bytes.toString(); });
  child.stderr.on('data', (bytes: Buffer) => { err += bytes.toString(); });
  let timedOut = false;
  const timer = childHangTimer(child, 'crash fixture reaching its selected cut', () => { timedOut = true; });
  let exit: string | number | null;
  try { exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code, signal) => resolve(signal ?? code)); }); }
  finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  assert.equal(exit, 'SIGKILL', `${out}\n${err}`);
  assert.equal(timedOut, false, 'a deadline kill is not evidence that the selected crash cut ran');
  const data = JSON.parse(out.trim().split('\n')[0]) as { projectId: string; sourceId: string };
  const path = join(home, 'threads', readdirSync(join(home, 'threads')).find((name) => name.endsWith('.json'))!);
  const stored = readJson<Thread>(path, {} as Thread);
  assert.equal(stored.turns.length, 1);
  assert.equal(readFileSync(starts, 'utf8'), 'start\n');
  const open = (faults?: { saveDelayMs: number }) => {
    process.env.BACKBONE_TEST_STARTS = starts;
    const host = createHost({ home, faults, harness: 'harness-codex', pieceDirs: { 'harness-codex': fixture } }); hosts.add(host); localHosts.add(host); void host.resumeInterrupted().catch(() => {}); return host;
  };
  return { home, starts, path, stored, ...data, open, close };
}
async function rows(home: string) {
  const link = await CoreLink.open({ home });
  try { return (await link.read<{ id: string; status: string }>(link.system(), "SELECT id, status FROM app.effects WHERE operation = 'workspace.write_document' ORDER BY created_at")).rows; }
  finally { await link.release(); }
}

for (const cut of ['write.proposed', 'write.claimed', 'write.recorded', 'write.observed']) test(`${cut}: original managed write settles once with exact result and no producer replay`, { timeout: 600_000 }, async (t) => {
  const s = await scenario(t, cut);
  const before = await rows(s.home);
  assert.equal(before[0].status, cut === 'write.proposed' ? 'allowed' : cut === 'write.claimed' ? 'claimed' : cut === 'write.observed' ? 'succeeded' : 'dispatching');
  const host = s.open();
  const thread = await settled(host, s.stored.summary.id);
  assert.equal(thread.turns[0].status, 'stopped', thread.turns[0].answer?.text ?? 'No answer was recorded.');
  assert.equal(thread.turns[0].effects[0].key, before[0].id);
  assert.equal(thread.turns[0].effects[0].outcome, 'DONE');
  assert.equal(readFileSync(s.starts, 'utf8'), 'start\n');
  assert.deepEqual(thread.turns[0].work.steps, []);
  assert.equal(Object.hasOwn(thread, 'writeCustody'), false);
  const result = thread.turns[0].answer!.files[0];
  assert.equal(result.version, 1);
  assert.equal(value(await host.call('material.read', { id: result.materialId })).text, 'A fixed decision note from source v1.\n');
  assert.equal(value(await host.call('material.read', { id: result.materialId })).entry.projection, 'managed');
  assert.deepEqual((await rows(s.home)).map((row) => row.id), [before[0].id]);
  s.close(host); await CoreLink.whenClosed(s.home);
  assert.equal((await settled(s.open(), s.stored.summary.id)).turns[0].answer?.files[0].version, 1);
  assert.equal(readFileSync(s.starts, 'utf8'), 'start\n');
});

test('a newer person save remains current while recovery links the original agent version', { timeout: 600_000 }, async (t) => {
  const s = await scenario(t, 'write.recorded');
  const material = new MaterialStore(s.home, {}, () => {});
  const result = material.list(s.projectId).find((entry) => entry.name === 'result.md')!;
  assert.equal((await material.save(result.id, 'Newer person wording.\n', 1)).ok, true);
  const host = s.open();
  const thread = await settled(host, s.stored.summary.id);
  assert.equal(thread.turns[0].answer?.files[0].version, 1);
  const current = value(await host.call('material.read', { id: result.id }));
  assert.equal(current.entry.current, 2);
  assert.equal(current.text, 'Newer person wording.\n');
  assert.equal(readFileSync(s.starts, 'utf8'), 'start\n');
});

test('mixed completed and pending originals recover both exact results even with no model route', { timeout: 600_000 }, async (t) => {
  const s = await scenario(t, 'write.claimed', true);
  assert.deepEqual((await rows(s.home)).map((row) => row.status), ['succeeded', 'claimed']);
  const previous = process.env.BACKBONE_CODEX_MODEL;
  delete process.env.BACKBONE_CODEX_MODEL;
  try {
    const host = s.open();
    const thread = await settled(host, s.stored.summary.id);
    assert.equal((await host.call('settings.model.get', {})).active, null);
    assert.equal(thread.turns[0].status, 'stopped', thread.turns[0].answer?.text ?? 'No answer was recorded.');
    assert.deepEqual(thread.turns[0].answer?.files.map((file) => [file.name, file.version]), [['first.md', 1], ['result.md', 1]]);
    assert.deepEqual((await rows(s.home)).map((row) => row.status), ['succeeded', 'succeeded']);
    assert.equal(readFileSync(s.starts, 'utf8'), 'start\n');
  } finally { if (previous === undefined) delete process.env.BACKBONE_CODEX_MODEL; else process.env.BACKBONE_CODEX_MODEL = previous; }
});

for (const cut of ['write.begun', 'write.materialised']) test(`${cut}: uncertain original is retained without replay or invented success`, { timeout: 600_000 }, async (t) => {
  const s = await scenario(t, cut);
  const before = await rows(s.home);
  const thread = await settled(s.open(), s.stored.summary.id);
  assert.equal(thread.turns[0].status, 'stopped');
  assert.equal(thread.turns[0].effects[0].key, before[0].id);
  assert.equal(thread.turns[0].effects[0].outcome, 'UNKNOWN');
  assert.deepEqual(thread.turns[0].answer?.files, []);
  assert.equal((await rows(s.home))[0].status, 'unknown');
  assert.equal(readFileSync(s.starts, 'utf8'), 'start\n');
});

for (const change of ['source', 'missing-custody', 'corrupt-custody', 'stop']) test(`${change}: original pre-dispatch cancellation is established by SQL`, { timeout: 600_000 }, async (t) => {
  const s = await scenario(t, 'write.claimed');
  const before = await rows(s.home);
  if (change === 'source') await new MaterialStore(s.home, {}, () => {}).save(s.sourceId, 'person version two', 1);
  if (change.includes('custody')) {
    const stored = readJson<Record<string, unknown>>(s.path, {});
    if (change === 'missing-custody') delete stored.writeCustody;
    else stored.writeCustody = { version: 1, writes: { [`${s.stored.turns[0].id}:result.md`]: { version: 99 } } };
    writeJson(s.path, stored);
  }
  const host = s.open();
  if (change === 'stop') value(await host.call('turns.stop', { threadId: s.stored.summary.id }));
  const thread = await settled(host, s.stored.summary.id);
  assert.equal(thread.turns[0].status, 'stopped');
  assert.equal(thread.turns[0].effects[0].key, before[0].id);
  assert.equal(thread.turns[0].effects[0].outcome, 'REFUSED');
  assert.equal((await rows(s.home))[0].status, 'cancelled');
  assert.equal((await host.call('material.list', { projectId: s.projectId })).some((entry) => entry.name === 'result.md'), false);
  assert.equal(readFileSync(s.starts, 'utf8'), 'start\n');
});

test('a crash before the proposal closes the run and frees the thread, replaying nothing', { timeout: 600_000 }, async (t) => {
  const s = await scenario(t, 'write.custodied');
  const host = s.open();
  const thread = await settled(host, s.stored.summary.id);
  assert.equal(thread.turns[0].status, 'stopped');
  assert.match(thread.turns[0].answer?.text ?? '', /nothing was written/);
  assert.equal((await rows(s.home)).length, 0);
  assert.equal(readFileSync(s.starts, 'utf8'), 'start\n');
  assert.equal((await new MaterialStore(s.home, {}, () => {}).list(s.projectId)).some((entry) => entry.name === 'result.md'), false);
  value(await host.call('threads.update', { id: thread.summary.id, patch: { title: 'Free again' } }));
  value(await host.call('threads.delete', { id: thread.summary.id }));
});

test('a crash after closing the run still frees the thread on the next start', { timeout: 600_000 }, async (t) => {
  const s = await scenario(t, 'write.custodied');
  await CoreLink.whenClosed(s.home);
  const child = spawn(process.execPath, [join(import.meta.dirname, 'crash-recovery.ts'), s.home, fixture], { env: { ...process.env, BACKBONE_CRASH_AT: 'run.closed' } });
  assert.equal(await new Promise((resolve) => child.on('exit', (code, signal) => resolve(signal ?? code))), 'SIGKILL');
  const host = s.open();
  const thread = await settled(host, s.stored.summary.id);
  assert.equal(thread.turns[0].status, 'stopped');
  assert.match(thread.turns[0].answer?.text ?? '', /nothing was written/);
  value(await host.call('threads.delete', { id: thread.summary.id }));
  assert.equal(readFileSync(s.starts, 'utf8'), 'start\n');
});

test('a turn with one receipt says so when another original has none', { timeout: 600_000 }, async (t) => {
  const s = await scenario(t, 'write.custodied', true);
  const thread = await settled(s.open(), s.stored.summary.id);
  assert.equal(thread.turns[0].status, 'stopped');
  assert.match(thread.turns[0].answer?.text ?? '', /no confirmed receipt/);
});

test('an unreadable original cannot be deleted, moved, or replaced by a new turn', { timeout: 600_000 }, async (t) => {
  const s = await scenario(t, 'write.custodied');
  const stored = readJson<Record<string, unknown>>(s.path, {});
  stored.writeCustody = { version: 1, writes: { [`${s.stored.turns[0].id}:result.md`]: { version: 99 } } };
  writeJson(s.path, stored);
  const host = s.open();
  const thread = await settled(host, s.stored.summary.id);
  const other = value(await host.call('projects.create', { name: 'Other project', kind: 'folder' }));
  const removed = await host.call('threads.delete', { id: thread.summary.id });
  assert.equal(removed.ok, false, 'no SQL receipt is not evidence that the original proposal may be forgotten');
  const moved = await host.call('threads.update', { id: thread.summary.id, patch: { projectId: other.id } });
  assert.equal(moved.ok, false, 'moving the conversation would sever its original project binding');
  value(await host.call('threads.update', { id: thread.summary.id, patch: { title: 'Still recoverable' } }));
  const sent = await host.call('turns.send', { threadId: thread.summary.id, projectId: s.projectId, text: 'Start something else.', attachments: [],
    settings: { permission: 'full', model: 'controlled', effort: 4, runsOn: 'this-computer', mode: 'chat' }, clientKey: 'must-stay-unsent' });
  assert.equal(sent.ok, false);
  assert.equal(value(await host.call('threads.get', { id: thread.summary.id })).turns.length, 1);
  s.close(host); await CoreLink.whenClosed(s.home);
  const reopened = await settled(s.open(), thread.summary.id);
  assert.equal(reopened.summary.projectId, s.projectId);
  assert.equal(reopened.summary.title, 'Still recoverable');
  assert.match(reopened.turns[0].answer?.text ?? '', /no confirmed receipt/);
  assert.equal((await rows(s.home)).length, 0);
  assert.equal(readFileSync(s.starts, 'utf8'), 'start\n');
});

test('concurrent sends reserve one producer and retain its Stop controller', { timeout: 600_000 }, async (t) => {
  const s = await scenario(t, 'write.observed');
  const host = s.open();
  const thread = await settled(host, s.stored.summary.id);
  // Admission acknowledges a reserved turn before its asynchronous native startup finishes.
  // Observe the actual controlled producer before testing its retained Stop controller.
  const waitForStarts = async (count: number) => {
    await waitFor(()=>readFileSync(s.starts,'utf8').trim().split('\n').length>=count,'controlled producer starts',{diagnostic:()=>`expected=${count}; starts=${readFileSync(s.starts,'utf8')}`});
  };
  const request = { threadId: thread.summary.id, projectId: s.projectId, text: 'Hold before proposing (admission fixture).', attachments: [],
    settings: { permission: 'full' as const, model: 'controlled', effort: 4 as const, runsOn: 'this-computer' as const, mode: 'chat' as const }, clientKey: 'same-concurrent-send' };
  const duplicates = await Promise.all([host.call('turns.send', request), host.call('turns.send', request)]);
  assert.deepEqual(value(duplicates[0]), value(duplicates[1]), 'the same client key must acknowledge one admitted turn');
  assert.equal(value(await host.call('threads.get', { id: thread.summary.id })).summary.running, true);
  await waitForStarts(2);
  assert.equal(readFileSync(s.starts, 'utf8'), 'start\nstart\n');
  assert.equal(value(await host.call('turns.stop', { threadId: thread.summary.id })).stopped, true);
  const stopped = await settled(host, thread.summary.id);
  assert.equal(readFileSync(s.starts, 'utf8'), 'start\nstart\n', 'settlement retains the exact count of real producer starts');
  assert.equal(stopped.turns.length, 2);
  assert.equal(stopped.turns[1].status, 'stopped');
  assert.doesNotMatch(stopped.turns[1].answer?.text ?? '', /Stop did not reach/);
  const competing = await Promise.all(['other-key-a', 'other-key-b'].map((clientKey) => host.call('turns.send', { ...request, clientKey })));
  assert.equal(competing.filter((receipt) => receipt.ok).length, 1);
  await waitForStarts(3);
  assert.equal(readFileSync(s.starts, 'utf8'), 'start\nstart\nstart\n');
  assert.equal(value(await host.call('turns.stop', { threadId: thread.summary.id })).stopped, true);
  const final = await settled(host, thread.summary.id);
  assert.equal(readFileSync(s.starts, 'utf8'), 'start\nstart\nstart\n', 'settlement retains the exact count of real producer starts');
  assert.equal(final.turns.length, 3);
  assert.equal(final.turns[2].status, 'stopped');
  assert.doesNotMatch(final.turns[2].answer?.text ?? '', /Stop did not reach/);
  assert.equal((await rows(s.home)).length, 1, 'held producers never propose a document');
});

test('public reads join a live person Save instead of recovering it as a dead write', { timeout: 600_000 }, async (t) => {
  const s = await scenario(t, 'write.observed');
  const host = s.open({ saveDelayMs: 250 });
  const thread = await settled(host, s.stored.summary.id);
  const document = thread.turns[0].answer!.files[0].materialId;
  const saving = host.call('material.save', { id: document, text: 'Person version two', baseVersion: 1 });
  await waitFor(()=>existsSync(join(s.home,'material',document,'intent.json')),'person Save durable intent');
  assert.equal(existsSync(join(s.home, 'material', document, 'intent.json')), true, 'the Save must actually be in flight');
  const [saved, read, listed, files, projection, changes, sidechat] = await Promise.allSettled([
    saving, host.call('material.read', { id: document }), host.call('material.list', { projectId: s.projectId }),
    host.call('files.list', { projectId: s.projectId }), host.call('threads.get', { id: thread.summary.id }),
    host.call('changes.get', { projectId: s.projectId, threadId: thread.summary.id, scope: 'last-turn' }),
    host.call('sidechat.ask', { threadId: thread.summary.id, text: 'Which files are here?' }),
  ]);
  assert.equal(saved.status, 'fulfilled', saved.status === 'rejected' ? String(saved.reason) : '');
  assert.equal(read.status, 'fulfilled');
  assert.equal(listed.status, 'fulfilled');
  assert.equal(files.status, 'fulfilled');
  assert.equal(projection.status, 'fulfilled');
  assert.equal(changes.status, 'fulfilled');
  assert.equal(sidechat.status, 'fulfilled');
  if (saved.status === 'fulfilled') assert.equal(value(saved.value).current, 2);
  if (read.status === 'fulfilled') assert.deepEqual([value(read.value).entry.current, value(read.value).text], [2, 'Person version two']);
  if (listed.status === 'fulfilled') assert.equal(listed.value.find((entry) => entry.id === document)?.current, 2);
});

test('an in-flight keyed effect stays observable before Stop and dispatch completion', { timeout: 600_000 }, async (t) => {
  const home = freshDataHome('observable-dispatch'); homes.add(home);
  const previous = process.env.BACKBONE_HARNESS;
  process.env.BACKBONE_HARNESS = 'harness-stub';
  const host = createHost({ home, writeDelayMs: 2_000 }); hosts.add(host);
  t.after(async () => {
    host.close(); hosts.delete(host);
    await CoreLink.whenClosed(home); await removeDataHome(home); homes.delete(home);
    if (previous === undefined) delete process.env.BACKBONE_HARNESS; else process.env.BACKBONE_HARNESS = previous;
  });
  const project = value(await host.call('projects.create', { name: 'Observable dispatch', kind: 'folder' }));
  const sent = value(await host.call('turns.send', { projectId: project.id, text: 'Draft a brief', attachments: [],
    settings: { permission: 'full', model: 'stub', effort: 3, runsOn: 'this-computer', mode: 'chat' }, clientKey: 'observe-before-stop' }));
  const link = await CoreLink.open({ home });
  let effect: { id: string; status: string } | undefined;
  try {
    await waitFor(async()=>{effect=(await link.read<{id:string;status:string}>(link.system(),"SELECT id, status FROM app.effects WHERE operation = 'workspace.write_document'")).rows[0];return effect?.status==='dispatching';},'controlled dispatch window',{diagnostic:()=>JSON.stringify(effect)});
  } finally { await link.release(); }
  assert.equal(effect?.status, 'dispatching', 'the controlled dispatch window must actually be open');
  const projection = await hangDetector(host.call('threads.get', {id:sent.threadId}),'projection before dispatch completion');
  assert.ok(projection, 'the projection must be observable while dispatch is still held');
  const running = value(projection);
  assert.equal(running.summary.running, true);
  assert.equal(running.turns[0].effects[0].key, effect?.id);
  assert.equal(value(await host.call('turns.stop', { threadId: sent.threadId })).stopped, true);
  const stopped = await settled(host, sent.threadId);
  assert.equal(stopped.turns[0].effects[0].outcome, 'UNKNOWN');
  assert.equal((await rows(home))[0].status, 'unknown');
});

test('killed for real mid-turn: finished pieces land once, the producer never restarts, and the turn says it stopped', { timeout: 600_000 }, async (t) => {
  const s = await scenario(t, 'checkpoint');
  assert.ok(readdirSync(join(s.home, 'checkpoints')).length, 'the checkpoint was on disk before the kill');
  const host = s.open();
  const thread = await settled(host, s.stored.summary.id);
  const turn = thread.turns[0];
  assert.equal(turn.status, 'stopped');
  assert.match(turn.answer?.text ?? '', /interrupted/);
  assert.deepEqual(turn.effects.map((e) => [e.target, e.outcome]).sort(), [['note.md', 'DONE'], ['other.md', 'DONE']]);
  assert.equal(readFileSync(s.starts, 'utf8'), 'start\n');
  const docs = await host.call('material.list', { projectId: s.projectId });
  assert.equal(value(await host.call('material.read', { id: docs.find((m) => m.name === 'note.md')!.id })).text, 'A finished note.\n');
  assert.equal(value(await host.call('material.read', { id: docs.find((m) => m.name === 'other.md')!.id })).text, 'Another finished note.\n');
  const needsYou = (await host.call('work.now', { projectId: s.projectId })).needsYou;
  assert.ok(needsYou.some((n) => n.kind === 'stopped'));
  assert.deepEqual(needsYou.filter((n) => n.kind === 'unsure').map((n) => n.title).sort(), ['note.md', 'other.md']);
  assert.deepEqual(readdirSync(join(s.home, 'checkpoints')), []);
  const before = await rows(s.home);
  assert.equal(before.length, 2);
  s.close(host); await CoreLink.whenClosed(s.home);
  await settled(s.open(), s.stored.summary.id);
  assert.equal((await rows(s.home)).length, 2);
});

test('killed for real, then the person edits: their version stands and nothing is lost', { timeout: 600_000 }, async (t) => {
  const s = await scenario(t, 'checkpoint-revision');
  assert.equal((await new MaterialStore(s.home, {}, () => {}).save(s.sourceId, 'The person\'s words.\n', 1)).ok, true);
  const host = s.open();
  await settled(host, s.stored.summary.id);
  assert.equal(value(await host.call('material.read', { id: s.sourceId })).text, 'The person\'s words.\n');
  const all = await host.call('material.list', { projectId: s.projectId, includeHidden: true });
  assert.deepEqual(all.map((m) => m.name).sort(), ['note (held).md', 'source (revision of v1).md', 'source.md'].sort());
  assert.equal(all.find((m) => m.name === 'note (held).md')?.held?.changed, true);
});

test('Stop is on disk before it is acknowledged', { timeout: 600_000 }, async (t) => {
  const s = await scenario(t, 'write.observed');
  const host = s.open();
  const thread = await settled(host, s.stored.summary.id);
  value(await host.call('turns.send', { threadId: thread.summary.id, projectId: s.projectId, text: 'Hold before proposing (admission fixture).', attachments: [],
    settings: { permission: 'full', model: 'controlled', effort: 4, runsOn: 'this-computer', mode: 'chat' }, clientKey: 'stop-durable' }));
  assert.equal(value(await host.call('turns.stop', { threadId: thread.summary.id })).stopped, true);
  assert.equal(readJson<Thread>(s.path, {} as Thread).turns.at(-1)!.stopRequested, true);
  await settled(host, thread.summary.id);
});

test('killed before dispatch after an acknowledged Stop: recovery lands nothing', { timeout: 600_000 }, async (t) => {
  const s = await scenario(t, 'write.claimed');
  writeJson(s.path, { ...s.stored, turns: s.stored.turns.map((turn) => ({ ...turn, stopRequested: true })) });
  const host = s.open();
  const thread = await settled(host, s.stored.summary.id);
  assert.equal(thread.turns[0].status, 'stopped');
  assert.deepEqual((await host.call('material.list', { projectId: s.projectId })).map((m) => m.name), ['source.md']);
  assert.equal((await rows(s.home))[0].status, 'cancelled');
});

test('a write landed and the process died with no recorded completion: the turn is not done', { timeout: 600_000 }, async (t) => {
  const s = await scenario(t, 'write.observed');
  const host = s.open();
  const thread = await settled(host, s.stored.summary.id);
  assert.equal(thread.turns[0].effects[0].outcome, 'DONE');
  assert.equal(thread.turns[0].status, 'stopped');
  assert.match(thread.turns[0].answer?.text ?? '', /interrupted/);
});
