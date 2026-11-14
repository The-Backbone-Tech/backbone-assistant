import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createThreadRewind, rewindControl, syncRewindVersions } from '../src/composition/thread-rewind.ts';
import { CoreLink } from '../src/composition/core.ts';
import { inActiveHomeLockScope } from '../src/composition/home-lock.ts';
import { ThreadJournal, type StoredThread } from '../src/composition/thread-journal.ts';
import { MaterialStore } from '../src/stub/material.ts';
import { freshDir, value, open, settings, idle, pollUntil } from './helpers.ts';
import { hostClosed } from '../src/composition/host.ts';
import { saveThreadProjection } from '../src/composition/thread-custody.ts';
import { WorkspaceStore } from '../src/workspace/store.ts';
import { writeJson } from '../src/stub/fsx.ts';
import { scriptedStep, startScriptedModel } from '../src/testing/scripted-model.ts';
import type { Turn } from '../src/api.ts';

function setup(beforeMove?: (home: string) => void) {
  const home = freshDir('rewind-');
  const material = new MaterialStore(home, { beforeFolderMove: () => beforeMove?.(home) }, (entry, bytes) => writeFileSync(join(home, entry.name), bytes), entry => join(home, entry.name));
  const first = material.create('project', 'note.md', 'text/markdown', Buffer.from('Before'), 'working', 'agent');
  const turn = (id: string, files: { materialId: string; name: string; version: number }[] = []): Turn => ({ id, side: false, user: { text: id, attachments: [], at: new Date().toISOString() }, work: { startedAt: '', steps: [], harness: 'test' }, effects: files.map(file => ({ key: `${id}:${file.name}`, kind: 'write-working-copy' as const, target: file.name, materialId: file.materialId, version: file.version, outcome: 'DONE' as const })), status: 'done', answer: { text: id, files } });
  const thread: StoredThread = { summary: { id: 'thread', projectId: 'project', title: 'Test', pinned: false, unread: false, archived: false, running: false, updatedAt: '' }, turns: [turn('earlier'), turn('later', [{ materialId: first.id, name: first.name, version: 2 }])], sideTurns: [], clientKeys: ['earlier', 'later'] };
  const threads = new Map([[thread.summary.id, thread]]);
  const journal = new ThreadJournal(home);
  const rewind = createThreadRewind({ home, material, threads, journal, projectDir: () => home, busy: () => false, save: async () => {}, changed: () => {} });
  return { home, material, first, thread, threads, journal, rewind, turn };
}

test('rewind restores agent versions, preserves later person edits and refuses silent overwrite', async () => {
  const s = setup();
  value(await s.material.save(s.first.id, 'Agent edit', 1, 'agent'));
  value(await s.material.save(s.first.id, 'Person edit', 2));
  const args = { threadId: 'thread', turnId: 'earlier' };
  const plan = value(await s.rewind.preview(args));
  assert.equal(plan.files[0].conflict, true);
  const refused = await s.rewind.apply({ ...args, revision: plan.revision, clientKey: 'rewind', choices: [] });
  assert.equal(refused.ok, false);
  assert.equal(readFileSync(join(s.home, 'note.md'), 'utf8'), 'Person edit');
  value(await s.rewind.apply({ ...args, revision: plan.revision, clientKey: 'rewind', choices: [{ materialId: s.first.id, action: 'keep' }] }));
  assert.equal(readFileSync(join(s.home, 'note.md'), 'utf8'), 'Person edit');
  assert.deepEqual(s.thread.turns.map(t => t.id), ['earlier']);
  assert.equal(s.thread.rewinds?.[0].turns[0].id, 'later');
  const replay = new Map<string, StoredThread>();
  // A file-free replay recovers the completed rewind and its receipts from journal truth.
  replay.set('thread', { ...s.thread, turns: [s.turn('earlier'), s.turn('later')], rewinds: undefined });
  s.journal.rebuild(replay);
  assert.deepEqual(replay.get('thread')!.turns.map(t => t.id), ['earlier']);
});

test('rewind restores bytes and removes new files while keeping every version', async () => {
  const s = setup();
  value(await s.material.save(s.first.id, 'Agent edit', 1, 'agent'));
  const added = s.material.create('project', 'added.md', 'text/markdown', Buffer.from('New'), 'working', 'agent');
  s.thread.turns[1].answer!.files.push({ materialId: added.id, name: added.name, version: 1 });
  s.thread.turns[1].effects.push({ key: 'added', kind: 'write-working-copy', target: added.name, materialId: added.id, version: 1, outcome: 'DONE' });
  const args = { threadId: 'thread', turnId: 'earlier' };
  const plan = value(await s.rewind.preview(args));
  value(await s.rewind.apply({ ...args, revision: plan.revision, clientKey: 'restore', choices: [] }));
  assert.equal(readFileSync(join(s.home, 'note.md'), 'utf8'), 'Before');
  assert.equal(existsSync(join(s.home, 'added.md')), false);
  assert.equal(s.material.load(added.id)!.hidden, true);
  assert.equal(s.material.bytes(added.id, 1).toString(), 'New');
  const n = s.material.load(s.first.id)!.current;
  value(await s.rewind.apply({ ...args, revision: plan.revision, clientKey: 'restore', choices: [] }));
  assert.equal(s.material.load(s.first.id)!.current, n, 'lost replies do not repeat restores');
});

test('a stale preview and direct folder edit refuse before changing any file', async () => {
  const s = setup();
  value(await s.material.save(s.first.id, 'Agent edit', 1, 'agent'));
  const args = { threadId: 'thread', turnId: 'earlier' };
  const plan = value(await s.rewind.preview(args));
  writeFileSync(join(s.home, 'note.md'), 'External edit');
  assert.equal((await s.rewind.apply({ ...args, revision: plan.revision, clientKey: 'stale', choices: [] })).ok, false);
  const refreshed = value(await s.rewind.preview(args));
  assert.equal(refreshed.files[0].conflict, true);
  value(await s.rewind.apply({ ...args, revision: refreshed.revision, clientKey: 'keep', choices: [{ materialId: s.first.id, action: 'keep' }] }));
  assert.equal(readFileSync(join(s.home, 'note.md'), 'utf8'), 'External edit');
});

test('the Host restores files and retains the rewound branch across a cold restart', async () => {
  const { home, host } = open();
  const project = value(await host.call('projects.create', { name: 'Rewind', kind: 'folder' }));
  const first = value(await host.call('turns.send', { projectId: project.id, text: 'Write a first brief', attachments: [], settings, clientKey: 'first' }));
  const original = await idle(host, first.threadId);
  const file = original.turns[0].answer!.files[0];
  const before = value(await host.call('material.read', { id: file.materialId })).text;
  value(await host.call('turns.send', { projectId: project.id, threadId: first.threadId, text: 'Write a later brief', attachments: [], settings, clientKey: 'second' }));
  await idle(host, first.threadId);
  const args = { threadId: first.threadId, turnId: first.turnId };
  const plan = value(await host.call('threads.rewindPreview', args));
  assert.equal(plan.files.length, 1);
  assert.equal(plan.files[0].conflict, false);
  value(await host.call('threads.rewind', { ...args, revision: plan.revision, clientKey: 'rewind', choices: [] }));
  assert.equal(value(await host.call('material.read', { id: file.materialId })).text, before);
  value(await host.call('turns.send', { projectId: project.id, threadId: first.threadId, text: 'Write a continuing brief', attachments: [], settings, clientKey: 'continuing' }));
  const continued = await idle(host, first.threadId);
  assert.equal(continued.turns.at(-1)!.effects[0].outcome, 'DONE', 'the next edit uses the restored Core and material versions');
  assert.equal(continued.turns.at(-1)!.effects[0].version, 4);
  const steps = structuredClone(continued.turns.at(-1)!.work.steps);
  assert.ok(steps.length > 0, 'the new branch has an inspectable work trace');
  host.close(); await hostClosed(home);
  const reopened = open(home).host;
  const thread = value(await reopened.call('threads.get', { id: first.threadId }));
  assert.equal(thread.turns.length, 2);
  assert.deepEqual(thread.turns.at(-1)!.work.steps, steps, 'replaying rewind removes archived ids, not later cached work');
  assert.equal(thread.rewinds?.[0].turns.length, 1);
  assert.equal(thread.rewinds?.[0].turns[0].effects[0].outcome, 'DONE');
  const exported = freshDir('rewind-export-');
  value(await reopened.call('backup.export', { to: exported }));
  const transcript = readFileSync(join(exported, 'threads', 't001.md'), 'utf8');
  assert.match(transcript, /Rewound branch/);
  assert.match(transcript, /Write a later brief/);
  assert.match(transcript, /DONE/);
  const retried = value(await reopened.call('turns.send', { projectId: project.id, threadId: first.threadId, text: 'Write a later brief', attachments: [], settings, clientKey: 'second' }));
  assert.equal(retried.turnId, thread.rewinds![0].turns[0].id);
  assert.equal(value(await reopened.call('threads.get', { id: first.threadId })).turns.length, 2);
});

test('an explicit restore choice replaces a later person edit while retaining its version', async () => {
  const s = setup();
  value(await s.material.save(s.first.id, 'Agent edit', 1, 'agent'));
  value(await s.material.save(s.first.id, 'Person edit', 2));
  const args = { threadId: 'thread', turnId: 'earlier' };
  const plan = value(await s.rewind.preview(args));
  value(await s.rewind.apply({ ...args, revision: plan.revision, clientKey: 'restore-person', choices: [{ materialId: s.first.id, action: 'restore' }] }));
  assert.equal(readFileSync(join(s.home, 'note.md'), 'utf8'), 'Before');
  assert.equal(s.material.bytes(s.first.id, 3).toString(), 'Person edit');
});

test('an interrupted file restore can be resumed from a fresh preview without repeating it', async () => {
  const s = setup();
  value(await s.material.save(s.first.id, 'Agent edit', 1, 'agent'));
  const args = { threadId: 'thread', turnId: 'earlier' };
  const plan = value(await s.rewind.preview(args));
  const id = 'interrupted-operation';
  const record = { id, turnId: 'earlier', turns: [s.thread.turns[1]], files: plan.files, choices: [] };
  const event = s.journal.append({ kind: 'thread.rewind.started', threadId: 'thread', record });
  s.thread.rewindPending = event.record;
  s.material.rewind(s.first.id, 1, id);
  const version = s.material.load(s.first.id)!.current;
  const resumed = value(await s.rewind.preview(args));
  value(await s.rewind.apply({ ...args, revision: resumed.revision, clientKey: resumed.pendingKey!, choices: [] }));
  assert.equal(s.material.load(s.first.id)!.current, version);
  assert.equal(s.thread.rewindPending, undefined);
  assert.equal(s.thread.turns.length, 1);
  value(await s.rewind.apply({ ...args, revision: resumed.revision, clientKey: resumed.pendingKey!, choices: [] }));
  assert.equal(s.material.load(s.first.id)!.current, version);
});

test('receipt ownership ignores cited files and restores before the first of several writes in one turn', async () => {
  const s = setup();
  s.thread.turns[1].effects = [];
  assert.equal(value(await s.rewind.preview({ threadId: 'thread', turnId: 'earlier' })).files.length, 0);
  value(await s.material.save(s.first.id, 'First write', 1, 'agent'));
  value(await s.material.save(s.first.id, 'Second write', 2, 'agent'));
  s.thread.turns[1].effects = [2, 3].map(version => ({ key: `write-${version}`, kind: 'write-working-copy', target: s.first.name, materialId: s.first.id, version, outcome: 'DONE' }));
  s.thread.turns[1].answer!.files[0].version = 3;
  const args = { threadId: 'thread', turnId: 'earlier' };
  const preview = value(await s.rewind.preview(args));
  assert.equal(preview.files[0].restore, 1);
  value(await s.rewind.apply({ ...args, revision: preview.revision, clientKey: 'multiple-writes', choices: [] }));
  assert.equal(readFileSync(join(s.home, 'note.md'), 'utf8'), 'Before');
});

test('interleaved person or other-conversation versions require a conflict choice', async () => {
  for (const by of ['person', 'agent'] as const) {
    const s = setup();
    value(await s.material.save(s.first.id, 'This branch v2', 1, 'agent'));
    value(await s.material.save(s.first.id, 'Someone else v3', 2, by));
    value(await s.material.save(s.first.id, 'This branch v4', 3, 'agent'));
    s.thread.turns[1].effects.push({ ...s.thread.turns[1].effects[0], key: 'last', version: 4 });
    const args = { threadId: 'thread', turnId: 'earlier' };
    const plan = value(await s.rewind.preview(args));
    assert.equal(plan.files[0].conflict, true);
    assert.deepEqual(plan.files[0].foreignVersions, [3]);
    assert.equal((await s.rewind.apply({ ...args, revision: plan.revision, clientKey: by, choices: [] })).ok, false);
    assert.equal(readFileSync(join(s.home, 'note.md'), 'utf8'), 'This branch v4');
    value(await s.rewind.apply({ ...args, revision: plan.revision, clientKey: by, choices: [{ materialId: s.first.id, action: 'keep' }] }));
    assert.equal(s.material.load(s.first.id)!.current, 4);
  }
});

test('a Save or folder edit after interruption still requires a fresh conflict choice', async () => {
  for (const saved of [false, true]) {
    const s = setup();
    value(await s.material.save(s.first.id, 'Agent edit', 1, 'agent'));
    const args = { threadId: 'thread', turnId: 'earlier' };
    const plan = value(await s.rewind.preview(args)), id = 'interrupted';
    s.thread.rewindPending = { id, turnId: 'earlier', turns: [s.thread.turns[1]], files: plan.files, choices: [] };
    s.material.rewind(s.first.id, 1, id);
    if (saved) value(await s.material.save(s.first.id, 'Person after interruption', 3));
    else writeFileSync(join(s.home, 'note.md'), 'Person after interruption');
    const preview = value(await s.rewind.preview(args));
    assert.equal(preview.files[0].conflict, true);
    assert.equal((await s.rewind.apply({ ...args, revision: preview.revision, clientKey: id, choices: [] })).ok, false);
    assert.equal(readFileSync(join(s.home, 'note.md'), 'utf8'), 'Person after interruption');
    value(await s.rewind.apply({ ...args, revision: preview.revision, clientKey: id, choices: [{ materialId: s.first.id, action: 'restore' }] }));
    assert.equal(readFileSync(join(s.home, 'note.md'), 'utf8'), 'Before');
  }
});

test('pending side recovery, unknown outcomes and linked project roots hold rewind', async () => {
  const s = setup();
  value(await s.material.save(s.first.id, 'Agent edit', 1, 'agent'));
  const args = { threadId: 'thread', turnId: 'earlier' };
  s.thread.sideTurns = [{ ...s.turn('side'), side: true, sideRecoveryPending: true }];
  assert.equal((await s.rewind.preview(args)).ok, false);
  s.thread.sideTurns = [];
  s.thread.turns[1].effects[0].outcome = 'UNKNOWN';
  assert.equal((await s.rewind.preview(args)).ok, false);
  s.thread.turns[1].effects[0].outcome = 'DONE';
  mkdirSync(join(s.home, 'projects'));
  symlinkSync(freshDir('rewind-outside-'), join(s.home, 'projects', 'linked'));
  const guarded = createThreadRewind({ ...s, projectDir: () => join(s.home, 'projects', 'linked'), busy: () => false, save: async () => {}, changed: () => {} });
  assert.equal((await guarded.preview(args)).ok, false);
});

test('native or connector uncertainty without a document receipt cannot leave active history through rewind', async () => {
  for (const side of [false, true]) {
    const s = setup();
    const uncertain = side ? s.turn('side') : s.thread.turns[1];
    uncertain.status = 'stopped';
    uncertain.effects = [];
    uncertain.unknownOutcome = true;
    if (side) s.thread.sideTurns.push({ ...uncertain, side: true });
    const preview = await s.rewind.preview({ threadId: 'thread', turnId: 'earlier' });
    assert.equal(preview.ok, false, side ? 'uncertain side work stays visible' : 'uncertain native or connector work stays visible');
    assert.equal(s.thread.turns.length, 2);
    assert.equal(side ? s.thread.sideTurns[0].unknownOutcome : s.thread.turns[1].unknownOutcome, true);
  }
});

test('retrying a side question archived by rewind returns its original answer without another model call', async () => {
  const model = await startScriptedModel();
  const previousEndpoint = process.env.BACKBONE_MODEL_ENDPOINT, previousModel = process.env.BACKBONE_MODEL_ID;
  process.env.BACKBONE_MODEL_ENDPOINT = model.url; process.env.BACKBONE_MODEL_ID = model.model;
  const { home, host } = open(undefined, { harness: 'harness-pi' });
  try {
    const project = value(await host.call('projects.create', { name: 'Side rewind', kind: 'folder' }));
    const first = value(await host.call('turns.send', { projectId: project.id, text: 'First conversation', attachments: [], settings, clientKey: 'side-first' }));
    await idle(host, first.threadId);
    const question = { threadId: first.threadId, text: 'What files are here?', clientKey: 'side-question' };
    const answer = value(await host.call('sidechat.ask', question));
    value(await host.call('turns.send', { projectId: project.id, threadId: first.threadId, text: 'Later conversation', attachments: [], settings, clientKey: 'side-later' }));
    await idle(host, first.threadId);
    const args = { threadId: first.threadId, turnId: first.turnId };
    const plan = value(await host.call('threads.rewindPreview', args));
    value(await host.call('threads.rewind', { ...args, revision: plan.revision, clientKey: 'side-rewind', choices: [] }));
    const requests = model.requests.length;
    assert.equal(value(await host.call('sidechat.ask', question)).id, answer.id);
    assert.equal(model.requests.length, requests);
    assert.equal(value(await host.call('threads.get', { id: first.threadId })).sideTurns.length, 0);
  } finally {
    host.close(); await hostClosed(home); await model.close();
    if (previousEndpoint === undefined) delete process.env.BACKBONE_MODEL_ENDPOINT; else process.env.BACKBONE_MODEL_ENDPOINT = previousEndpoint;
    if (previousModel === undefined) delete process.env.BACKBONE_MODEL_ID; else process.env.BACKBONE_MODEL_ID = previousModel;
  }
});

test('a racing folder edit is shown and an explicit retirement retry can complete', async () => {
  let racing = true;
  const s = setup(home => { if (racing) { racing = false; writeFileSync(join(home, 'note.md'), 'Racing person edit'); } });
  s.thread.turns[1].effects[0].version = 1;
  const args = { threadId: 'thread', turnId: 'earlier' };
  const plan = value(await s.rewind.preview(args));
  assert.equal((await s.rewind.apply({ ...args, revision: plan.revision, clientKey: 'race', choices: [] })).ok, false);
  assert.equal(readFileSync(join(s.home, 'note.md'), 'utf8'), 'Racing person edit');
  const retry = value(await s.rewind.preview(args));
  assert.equal(retry.files[0].conflict, true);
  value(await s.rewind.apply({ ...args, revision: retry.revision, clientKey: retry.pendingKey!, choices: [{ materialId: s.first.id, action: 'restore' }] }));
  assert.equal(existsSync(join(s.home, 'note.md')), false);
  assert.equal(s.thread.rewindPending, undefined);
});

test('Core person revisions run outside the home lock and a lost reply is inspected on retry', async () => {
  const s = setup();
  value(await s.material.save(s.first.id, 'Agent edit', 1, 'agent'));
  let known = 2, calls = 0, loseReply = true;
  const link = { documentVersion: async () => known, reviseDocument: async () => { calls++; known++; if (loseReply) { loseReply = false; throw new Error('Lost reply after commit'); } return known; } };
  const rewind = createThreadRewind({ ...s, projectDir: () => s.home, busy: () => false, save: async () => {}, changed: () => {}, sync: async revisions => {
    assert.equal(inActiveHomeLockScope(s.home), false);
    await syncRewindVersions(link, revisions);
  } });
  const args = { threadId: 'thread', turnId: 'earlier' }, plan = value(await rewind.preview(args));
  assert.equal((await rewind.apply({ ...args, revision: plan.revision, clientKey: 'core-lost-reply', choices: [] })).ok, false);
  assert.equal(s.thread.rewindPending?.files[0].core, 'failed', 'an unconfirmed Core response is a visible recorded outcome');
  assert.ok(s.thread.rewindPending);
  const retry = value(await rewind.preview(args));
  value(await rewind.apply({ ...args, revision: retry.revision, clientKey: retry.pendingKey!, choices: [] }));
  assert.equal(known, 3); assert.equal(calls, 1);
  assert.equal(s.thread.rewindPending, undefined);
});

test('overlapping rewind requests cannot append the same Core person revision twice', async () => {
  const s = setup();
  value(await s.material.save(s.first.id, 'Agent edit', 1, 'agent'));
  let release!: () => void, entered!: () => void, known = 2, calls = 0;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const syncing = new Promise<void>(resolve => { entered = resolve; });
  const rewind = createThreadRewind({ ...s, projectDir: () => s.home, busy: () => false, save: async () => {}, changed: () => {}, sync: async revisions => {
    entered(); await paused;
    await syncRewindVersions({ documentVersion: async () => known, reviseDocument: async () => { calls++; return ++known; } }, revisions);
  } });
  const args = { threadId: 'thread', turnId: 'earlier' }, plan = value(await rewind.preview(args));
  const first = rewind.apply({ ...args, revision: plan.revision, clientKey: 'overlap', choices: [] });
  try {
    await syncing;
    const pending = value(await rewind.preview(args));
    assert.equal((await rewind.apply({ ...args, revision: pending.revision, clientKey: pending.pendingKey!, choices: [] })).ok, false);
  } finally { release(); }
  value(await first);
  assert.equal(known, 3); assert.equal(calls, 1);
});

test('an unrelated running conversation remains stoppable while rewind waits for Core', async () => {
  let releaseOther!: () => void;
  const otherPaused = new Promise<void>(resolve => { releaseOther = resolve; });
  const model = await startScriptedModel('rewind-controls', scriptedStep, { before: async messages => {
    const content = messages.findLast(message => message.role === 'user')?.content;
    const text = typeof content === 'string' ? content : (content ?? []).map(part => part.text ?? '').join('');
    // The request waits until Stop aborts it, rather than racing a step budget or delay.
    if (text.includes('Keep working in the other project')) await otherPaused;
  } });
  const previousEndpoint = process.env.BACKBONE_MODEL_ENDPOINT, previousModel = process.env.BACKBONE_MODEL_ID;
  process.env.BACKBONE_MODEL_ENDPOINT = model.url; process.env.BACKBONE_MODEL_ID = model.model;
  const clock = { now: new Date(2026, 10, 12, 8, 0).getTime() };
  const { home, host } = open(undefined, { harness: 'harness-pi', schedules: { now: () => clock.now, tickMs: 25 }, triggers: { debounceMs: 20 } });
  const revise = CoreLink.prototype.reviseDocument;
  let release = () => {};
  try {
    const project = value(await host.call('projects.create', { name: 'Restore', kind: 'folder' }));
    const first = value(await host.call('turns.send', { projectId: project.id, text: 'Write the first brief', attachments: [], settings, clientKey: 'stop-first' }));
    const initial = await idle(host, first.threadId), file = initial.turns[0].answer!.files[0];
    value(await host.call('turns.send', { projectId: project.id, threadId: first.threadId, text: 'Write the next brief', attachments: [], settings, clientKey: 'stop-next' }));
    await idle(host, first.threadId);
    const other = value(await host.call('projects.create', { name: 'Other project', kind: 'folder' }));
    const otherFirst = value(await host.call('turns.send', { projectId: other.id, text: 'Write the other brief', attachments: [], settings, clientKey: 'other-first' }));
    const untouched = (await idle(host, otherFirst.threadId)).turns[0].answer!.files[0];
    const full = { ...settings, permission: 'full' as const };
    const schedule = value(await host.call('schedules.create', { projectId: project.id, text: 'Scheduled work', when: 'every day at 9:00', settings: full, clientKey: 'rewind-schedule' }));
    const hook = value(await host.call('triggers.create', { kind: 'webhook', projectId: project.id, text: 'Triggered work', settings: full, clientKey: 'rewind-trigger' }));
    const active = value(await host.call('turns.send', { projectId: other.id, text: 'Keep working in the other project', attachments: [], settings, clientKey: 'other-active' }));
    const args = { threadId: first.threadId, turnId: first.turnId }, plan = value(await host.call('threads.rewindPreview', args));
    let entered!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; }), syncing = new Promise<void>(resolve => { entered = resolve; });
    CoreLink.prototype.reviseDocument = async function(id, content) { if (id === file.materialId) { entered(); await paused; } return revise.call(this, id, content); };
    const action = host.call('threads.rewind', { ...args, revision: plan.revision, clientKey: 'stop-rewind', choices: [] });
    try {
      await Promise.race([syncing, action.then(() => { throw new Error('Rewind did not reach its Core synchronization.'); })]);
      const pending = value(await host.call('threads.get', { id: first.threadId })).rewindPending;
      assert.equal(pending?.turnId, first.turnId, 'the pending decision is visible in the public thread');
      value(await host.call('projects.create', { name: 'Available during rewind', kind: 'folder' }));
      value(await host.call('material.save', { id: untouched.materialId, text: 'Still editable', baseVersion: 1 }));
      const unrelated = value(await host.call('turns.send', { projectId: other.id, text: 'Another conversation', attachments: [], settings, clientKey: 'other-new' }));
      await idle(host, unrelated.threadId);
      assert.equal((await host.call('material.save', { id: file.materialId, text: 'Too early', baseVersion: 3 })).ok, false);
      assert.equal((await host.call('terminal.run', { projectId: project.id, command: 'exit 0' })).ok, false, 'a project command could touch affected files');
      const sameProject = await host.call('turns.send', { projectId: project.id, text: 'Too early', attachments: [], settings, clientKey: 'same-project' });
      assert.equal(sameProject.ok, false);
      if (!sameProject.ok) assert.ok(sameProject.detail.includes(first.turnId));
      const requestCount = model.requests.length;
      clock.now = new Date(2026, 10, 12, 9, 0).getTime();
      assert.equal((await fetch(hook.trigger.url!, { method: 'POST', headers: { Authorization: `Bearer ${hook.secret}` }, body: 'Local fake event' })).status, 202);
      await pollUntil(async active => {
        while (active()) {
          const scheduled = (await host.call('schedules.get', {})).runs.find(run => run.scheduleId === schedule.id && run.outcome === 'skipped');
          const triggered = (await host.call('triggers.get', {})).runs.find(run => run.triggerId === hook.trigger.id && run.outcome === 'skipped');
          if (scheduled && triggered) { assert.ok(scheduled.summary.includes(first.turnId)); assert.ok(triggered.summary.includes(first.turnId)); return; }
          await new Promise(resolve => setTimeout(resolve, 15));
        }
      }, 'rewind automation holds');
      // The held automations do not start their model jobs.
      assert.equal(model.requests.slice(requestCount).some(request => request.body.includes('Scheduled work') || request.body.includes('Triggered work')), false);
      assert.ok(Array.isArray(await host.call('goals.runs', {})), 'the sidebar receives an array while rewind is pending');
      const prefs = await host.call('viewer.get', {});
      assert.deepEqual(await host.call('viewer.put', { prefs }), prefs, 'saving UI selection keeps the ViewerPrefs return contract');
      assert.equal(value(await host.call('turns.stop', { threadId: active.threadId })).stopped, true);
      assert.equal(rewindControl('connectors.set', { serverId: 'test', enabled: false }), true);
      assert.equal(rewindControl('connectors.decide', { verdict: 'discard' }), true);
      assert.equal(rewindControl('connectors.decide', { verdict: 'release' }), false);
    } finally { release(); CoreLink.prototype.reviseDocument = revise; }
    value(await action);
    assert.equal((await idle(host, active.threadId)).turns[0].status, 'stopped');
  } finally {
    release(); releaseOther(); CoreLink.prototype.reviseDocument = revise;
    host.close(); await hostClosed(home); await model.close();
    if (previousEndpoint === undefined) delete process.env.BACKBONE_MODEL_ENDPOINT; else process.env.BACKBONE_MODEL_ENDPOINT = previousEndpoint;
    if (previousModel === undefined) delete process.env.BACKBONE_MODEL_ID; else process.env.BACKBONE_MODEL_ID = previousModel;
  }
});

test('a shorter projection needs the exact completed rewind archive on the journal', async () => {
  const s = setup();
  mkdirSync(join(s.home, 'threads'));
  writeJson(join(s.home, 'threads', 'thread.json'), s.thread);
  const record = { id: 'rewind-record', turnId: 'earlier', turns: [s.thread.turns[1]], files: [], choices: [] };
  const projection = { ...s.thread, turns: [s.thread.turns[0]], rewinds: [record] };
  await assert.rejects(saveThreadProjection(s.home, projection), /stale projection/);
  s.journal.append({ kind: 'thread.rewound', threadId: 'thread', record });
  await saveThreadProjection(s.home, projection);
  assert.equal(JSON.parse(readFileSync(join(s.home, 'threads', 'thread.json'), 'utf8')).rewinds[0].turns[0].id, 'later');
});

test('an unsaved folder edit becomes an inspectable person version before explicit restore', async () => {
  const s = setup();
  value(await s.material.save(s.first.id, 'Agent edit', 1, 'agent'));
  writeFileSync(join(s.home, 'note.md'), 'Unsaved person edit');
  const args = { threadId: 'thread', turnId: 'earlier' }, plan = value(await s.rewind.preview(args));
  value(await s.rewind.apply({ ...args, revision: plan.revision, clientKey: 'preserve-folder', choices: [{ materialId: s.first.id, action: 'restore' }] }));
  assert.equal(s.material.bytes(s.first.id, 3).toString(), 'Unsaved person edit');
  assert.equal(s.material.load(s.first.id)!.versions[2].by, 'person');
  assert.equal(readFileSync(join(s.home, 'note.md'), 'utf8'), 'Before');
});

test('keeping a racing retirement edit reconciles the visible material with its folder', async () => {
  let racing = true;
  const s = setup(home => { if (racing) { racing = false; writeFileSync(join(home, 'note.md'), 'Keep this person edit'); } });
  s.thread.turns[1].effects[0].version = 1;
  const args = { threadId: 'thread', turnId: 'earlier' }, plan = value(await s.rewind.preview(args));
  assert.equal((await s.rewind.apply({ ...args, revision: plan.revision, clientKey: 'keep-race', choices: [] })).ok, false);
  const preview = value(await s.rewind.preview(args));
  const beforeKeep = s.material.load(s.first.id)!.lifecycle ?? 0;
  value(await s.rewind.apply({ ...args, revision: preview.revision, clientKey: preview.pendingKey!, choices: [{ materialId: s.first.id, action: 'keep' }] }));
  const entry = s.material.load(s.first.id)!;
  assert.equal(entry.hidden, false);
  assert.equal(entry.folderConflict, undefined);
  assert.ok((entry.lifecycle ?? 0) > beforeKeep, 'a stale lifecycle decision cannot undo the explicit keep');
  assert.equal(s.material.bytes(entry.id, entry.current).toString(), 'Keep this person edit');
  assert.equal(readFileSync(join(s.home, 'note.md'), 'utf8'), 'Keep this person edit');
});

test('a symlink at the file name refuses rewind without changing its target', async () => {
  const s = setup();
  value(await s.material.save(s.first.id, 'Agent edit', 1, 'agent'));
  const outside = join(freshDir('rewind-target-'), 'outside.md');
  writeFileSync(outside, 'Outside');
  renameSync(join(s.home, 'note.md'), join(s.home, 'old-note.md'));
  symlinkSync(outside, join(s.home, 'note.md'));
  assert.equal((await s.rewind.preview({ threadId: 'thread', turnId: 'earlier' })).ok, false);
  assert.equal(readFileSync(outside, 'utf8'), 'Outside');
});

test('Core version drift is recorded per file and finish releases the pending rewind', async () => {
  const s = setup();
  value(await s.material.save(s.first.id, 'Agent edit', 1, 'agent'));
  let coreWrites = 0;
  const rewind = createThreadRewind({ ...s, projectDir: () => s.home, busy: () => false, save: async () => {}, changed: () => {}, sync: revisions => syncRewindVersions({ documentVersion: async () => 99, reviseDocument: async () => { coreWrites++; throw new Error('must not write divergent Core'); } }, revisions) });
  const args = { threadId: 'thread', turnId: 'earlier' }, plan = value(await rewind.preview(args));
  assert.equal((await rewind.apply({ ...args, revision: plan.revision, clientKey: 'drift', choices: [] })).ok, false);
  assert.equal(s.thread.rewindPending?.files[0].core, 'failed');
  assert.equal(coreWrites, 0, 'version drift never grants another Core write');
  assert.match(s.thread.rewindPending!.files[0].problem!, /Core/);
  const record = value(await rewind.finish({ threadId: 'thread', pendingKey: s.thread.rewindPending!.id }));
  assert.equal(record.resolution, 'without-remaining-files');
  assert.equal(record.files[0].outcome, 'restored');
  assert.equal(record.files[0].core, 'failed');
  assert.equal(s.thread.rewindPending, undefined);
  assert.equal(value(await rewind.finish({ threadId: 'thread', pendingKey: record.id })).id, record.id);
});

for (const point of ['rewind-after-version', 'rewind-after-meta', 'rewind-after-aside'] as const) {
  test(`a process killed at ${point} recovers the journal and folder without a duplicate restore`, async () => {
    const s = setup();
    value(await s.material.save(s.first.id, 'Agent edit', 1, 'agent'));
    writeJson(join(s.home, 'crash-thread.json'), s.thread);
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./crash-rewind.ts', import.meta.url)), s.home, s.home, point], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const material = new MaterialStore(s.home, {}, (entry, bytes) => writeFileSync(join(s.home, entry.name), bytes), entry => join(s.home, entry.name));
    // Host startup settles recorded projection intents before admitting any API call.
    material.settleProjections();
    const thread: StoredThread = JSON.parse(readFileSync(join(s.home, 'crash-thread.json'), 'utf8'));
    const threads = new Map([['thread', thread]]);
    s.journal.rebuild(threads);
    assert.ok(thread.rewindPending, 'the started decision survives the killed process');
    const rewind = createThreadRewind({ ...s, material, threads, projectDir: () => s.home, busy: () => false, save: async () => {}, changed: () => {} });
    const args = { threadId: 'thread', turnId: 'earlier' }, preview = value(await rewind.preview(args));
    value(await rewind.apply({ ...args, revision: preview.revision, clientKey: preview.pendingKey!, choices: preview.files.filter(file => file.conflict).map(file => ({ materialId: file.materialId, action: 'restore' as const })) }));
    assert.equal(thread.rewindPending, undefined);
    assert.equal(material.load(s.first.id)!.current, 3);
    assert.equal(material.load(s.first.id)!.versions.length, 3);
    assert.equal(readFileSync(join(s.home, 'note.md'), 'utf8'), 'Before');
  });
}

test('a killed rewind with a renamed project folder can finish without touching remaining files', async () => {
  const s = setup();
  value(await s.material.save(s.first.id, 'Agent edit', 1, 'agent'));
  const root = join(s.home, 'workspace'); mkdirSync(root);
  renameSync(join(s.home, 'note.md'), join(root, 'note.md'));
  writeJson(join(s.home, 'crash-thread.json'), s.thread);
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./crash-rewind.ts', import.meta.url)), s.home, root, 'rewind-after-version'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  renameSync(root, root + '-moved');
  const thread: StoredThread = JSON.parse(readFileSync(join(s.home, 'crash-thread.json'), 'utf8'));
  const threads = new Map([['thread', thread]]); s.journal.rebuild(threads);
  const rewind = createThreadRewind({ ...s, threads, projectDir: () => root, busy: () => false, save: async () => {}, changed: () => {} });
  const preview = value(await rewind.preview({ threadId: 'thread', turnId: 'earlier' }));
  assert.match(preview.files[0].problem!, /folder/);
  const record = value(await rewind.finish({ threadId: 'thread', pendingKey: preview.pendingKey! }));
  assert.equal(record.files[0].outcome, 'not-restored');
  assert.equal(thread.rewindPending, undefined);
  assert.equal(existsSync(root), false);
  assert.equal(readFileSync(join(root + '-moved', 'note.md'), 'utf8'), 'Agent edit');
  assert.ok(s.journal.read().some(event => event.kind === 'thread.rewound' && event.record.resolution === 'without-remaining-files'));
});

test('rewind retires command scratch even when no source material version changed', async () => {
  const s = setup(); s.thread.turns[1].effects = [];
  const store = new WorkspaceStore(s.home);
  const folder = join(store.directory, createHash('sha256').update('thread').digest('hex'));
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  writeJson(join(folder, 'record.json'), { createdAt: Date.now(), expiresAt: Date.now() + 86_400_000, sources: [] });
  writeFileSync(join(folder, 'derived.txt'), 'Discarded work without sources');
  const args = { threadId: 'thread', turnId: 'earlier' }, plan = value(await s.rewind.preview(args));
  try {
    value(await s.rewind.apply({ ...args, revision: plan.revision, clientKey: 'scratch', choices: [] }));
    assert.equal(await store.inspect('thread'), null);
    assert.equal(existsSync(folder), false);
  } finally { await store.remove('thread'); }
});

test('a held file in a pending rewind can reach a recorded end without being restored', async () => {
  const s = setup(); value(await s.material.save(s.first.id, 'Agent edit', 1, 'agent'));
  const plan = value(await s.rewind.preview({ threadId: 'thread', turnId: 'earlier' }));
  const record = { id: 'held-rewind', turnId: 'earlier', turns: [s.thread.turns[1]], files: plan.files, choices: [] };
  s.thread.rewindPending = s.journal.append({ kind: 'thread.rewind.started', threadId: 'thread', record }).record;
  s.material.mark(s.first.id, { hidden: true, held: { id: 'held-source', name: 'Held original' } });
  const preview = value(await s.rewind.preview({ threadId: 'thread', turnId: 'earlier' }));
  assert.match(preview.files[0].problem!, /held/);
  const result = value(await s.rewind.finish({ threadId: 'thread', pendingKey: record.id }));
  assert.equal(result.files[0].outcome, 'not-restored');
  assert.equal(s.material.load(s.first.id)!.held?.id, 'held-source');
  assert.equal(s.thread.rewindPending, undefined);
});

test('a side question asked during the kept turn remains with that turn', async () => {
  const s = setup(); value(await s.material.save(s.first.id, 'Agent edit', 1, 'agent'));
  s.thread.turns[0].user.at = '2026-11-12T08:00:00Z';
  s.thread.turns[0].work.endedAt = '2026-11-12T08:10:00Z';
  const during = { ...s.turn('during'), side: true, user: { ...s.turn('during').user, at: '2026-11-12T08:05:00Z' } };
  const after = { ...s.turn('after'), side: true, user: { ...s.turn('after').user, at: '2026-11-12T08:15:00Z' } };
  s.thread.sideTurns = [during, after];
  const args = { threadId: 'thread', turnId: 'earlier' }, plan = value(await s.rewind.preview(args));
  value(await s.rewind.apply({ ...args, revision: plan.revision, clientKey: 'side-timing', choices: [] }));
  assert.deepEqual(s.thread.sideTurns.map(turn => turn.id), ['during']);
  assert.deepEqual(s.thread.rewinds![0].sideTurns!.map(turn => turn.id), ['after']);
});

test('a matching Core version with different bytes is not a confirmed restore', async () => {
  let writes = 0;
  const link = {
    documentVersion: async () => 3,
    reviseDocument: async () => { writes++; return 1; },
    person: (() => ({})) as CoreLink['person'],
    read: (async () => ({ rows: [{ content: 'Another person changed Core' }], command: 'SELECT', rowCount: 1, oid: 0, fields: [] })) as CoreLink['read'],
  };
  await assert.rejects(syncRewindVersions(link, [{ id: 'document', current: 3, versions: [{ n: 3, text: 'Expected restored bytes' }] }]), /content differs/);
  assert.equal(writes, 0, 'an unrelated matching-number revision is never overwritten or claimed');
  await assert.rejects(syncRewindVersions({ ...link, documentVersion: async () => null }, [{ id: 'document', current: 3, versions: [] }]), /unavailable/);
});

test('startup after a restore kill never follows a replaced project symlink', async () => {
  const s = setup(); value(await s.material.save(s.first.id, 'Agent edit', 1, 'agent'));
  const root = join(s.home, 'workspace'); mkdirSync(root);
  renameSync(join(s.home, 'note.md'), join(root, 'note.md'));
  writeJson(join(s.home, 'crash-thread.json'), s.thread);
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./crash-rewind.ts', import.meta.url)), s.home, root, 'rewind-after-meta'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  renameSync(root, root + '-moved');
  const outside = freshDir('rewind-outside-root-'); writeFileSync(join(outside, 'note.md'), 'Outside bytes');
  symlinkSync(outside, root);
  const material = new MaterialStore(s.home, {}, (entry, bytes) => writeFileSync(join(root, entry.name), bytes), entry => join(root, entry.name));
  material.settleProjections();
  assert.equal(readFileSync(join(outside, 'note.md'), 'utf8'), 'Outside bytes');
  assert.equal(material.load(s.first.id)!.folderConflict, true);
  const thread: StoredThread = JSON.parse(readFileSync(join(s.home, 'crash-thread.json'), 'utf8'));
  const threads = new Map([['thread', thread]]); s.journal.rebuild(threads);
  const rewind = createThreadRewind({ ...s, material, threads, projectDir: () => root, busy: () => false, save: async () => {}, changed: () => {} });
  const record = value(await rewind.finish({ threadId: 'thread', pendingKey: thread.rewindPending!.id }));
  assert.equal(record.files[0].outcome, 'not-restored');
  assert.equal(readFileSync(join(outside, 'note.md'), 'utf8'), 'Outside bytes');
  assert.equal(thread.rewindPending, undefined);
});

test('finish remains available when the pending project path is now an ordinary file', async () => {
  const s = setup(); value(await s.material.save(s.first.id, 'Agent edit', 1, 'agent'));
  const plan = value(await s.rewind.preview({ threadId: 'thread', turnId: 'earlier' }));
  const record = { id: 'blocked-root', turnId: 'earlier', turns: [s.thread.turns[1]], files: plan.files, choices: [] };
  s.thread.rewindPending = s.journal.append({ kind: 'thread.rewind.started', threadId: 'thread', record }).record;
  const root = join(s.home, 'blocked'); writeFileSync(root, 'Keep this ordinary file');
  const rewind = createThreadRewind({ ...s, projectDir: () => root, busy: () => false, save: async () => {}, changed: () => {} });
  const preview = value(await rewind.preview({ threadId: 'thread', turnId: 'earlier' }));
  assert.ok(preview.files[0].problem);
  value(await rewind.finish({ threadId: 'thread', pendingKey: record.id }));
  assert.equal(s.thread.rewindPending, undefined);
  assert.equal(readFileSync(root, 'utf8'), 'Keep this ordinary file');
});

test('retrying an old finish never retires workspace for a different pending rewind', async () => {
  const s = setup(); value(await s.material.save(s.first.id, 'Agent edit', 1, 'agent'));
  let retired = 0;
  const rewind = createThreadRewind({ ...s, projectDir: () => s.home, busy: () => false, save: async () => {}, changed: () => {}, retireWorkspace: async () => { retired++; } });
  const args = { threadId: 'thread', turnId: 'earlier' }, plan = value(await rewind.preview(args));
  const first = value(await rewind.apply({ ...args, revision: plan.revision, clientKey: 'old-finish', choices: [] }));
  const next = { id: 'different-rewind', turnId: 'earlier', turns: [], files: [], choices: [] };
  s.thread.rewindPending = s.journal.append({ kind: 'thread.rewind.started', threadId: 'thread', record: next }).record;
  assert.equal(value(await rewind.finish({ threadId: 'thread', pendingKey: first.id })).id, first.id);
  assert.equal(retired, 1);
  assert.equal(s.thread.rewindPending!.id, next.id);
});

test('rewind accepts ended stopped and failed targets but refuses a running target', async () => {
  for (const status of ['stopped', 'failed', 'running'] as const) {
    const s = setup();
    s.thread.turns[0].status = status === 'failed' ? 'stopped' : status;
    if (status === 'failed') s.thread.turns[0].failure = { detail: 'Synthetic engine failure' };
    const result = await s.rewind.preview({ threadId: 'thread', turnId: 'earlier' });
    assert.equal(result.ok, status !== 'running', `selected ${status} turn`);
    if (!result.ok) assert.match(result.detail, /still running/i);
  }
});
