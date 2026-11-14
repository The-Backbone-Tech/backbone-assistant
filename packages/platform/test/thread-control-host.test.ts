// Exercise restart at the real Host admission/worker boundary, with disposable homes and no model.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostClosed } from '../src/composition/host.ts';
import { waitFor } from '../../../scripts/lib/test-hang.ts';
import { freshDir, idle, open, settings, value } from './helpers.ts';

const continuation = 'Continue this conversation from its recorded progress. Inspect completed work before doing more. Do not repeat any action whose outcome is unknown.';
function scripted() {
  const dir = freshDir('thread-control-script-');
  for (const name of ['plans', 'held', 'release']) mkdirSync(join(dir, name));
  process.env.BACKBONE_SCRIPT_DIR = dir;
  const plan = (text: string, body: unknown) => writeFileSync(join(dir, 'plans', `${createHash('sha256').update(text).digest('hex')}.json`), JSON.stringify(body));
  plan('Ready', { answer: 'Ready.' });
  plan(continuation, { read: ['brief.md'], answer: 'Continued from the inspected progress.' });
  return { dir, plan };
}

test('Host restart joins the exact worker, preserves the person edit and queue, and recovers its original continuation after reopening', async t => {
  const script = scripted();
  t.after(() => { delete process.env.BACKBONE_SCRIPT_DIR; });
  script.plan('Make a brief', { write: { title: 'brief.md', content: 'Agent draft.' }, answer: 'Drafted.' });
  script.plan('Hold the next write', { read: ['brief.md'], write: { title: 'brief.md', content: 'Must never replace the person.' }, hold: 'original', answer: 'Should not finish.' });
  script.plan('Keep this queued', { answer: 'Should stay queued.' });
  const { host, home } = open(undefined, { harness: 'scripted' });
  const project = value(await host.call('projects.create', { name: 'Control', kind: 'folder' }));
  const first = value(await host.call('turns.send', { projectId: project.id, text: 'Make a brief', attachments: [], settings, clientKey: 'first' }));
  await idle(host, first.threadId);
  const brief = (await host.call('material.list', { projectId: project.id }))[0];
  const saved = value(await host.call('material.save', { id: brief.id, baseVersion: brief.current, text: 'The person corrected the plan.' }));
  const original = value(await host.call('turns.send', { threadId: first.threadId, projectId: project.id, text: 'Hold the next write', attachments: [], settings, clientKey: 'held' }));
  await waitFor(() => existsSync(join(script.dir, 'held', 'original')), 'original Host worker reaches its hold');
  value(await host.call('queue.add', { threadId: first.threadId, text: 'Keep this queued', attachments: [], settings, clientKey: 'queued' }));
  const [restarted, retry] = await Promise.all([host.call('threads.restart', original), host.call('threads.restart', original)]);
  const admitted = value(restarted);
  assert.deepEqual(value(retry), admitted);
  const thread = await idle(host, first.threadId);
  assert.deepEqual(thread.turns.map(turn => turn.status), ['done', 'stopped', 'done']);
  assert.equal(thread.turns[2].restartOf, original.turnId);
  assert.notEqual(thread.turns[2].user.text, thread.turns[1].user.text);
  assert.deepEqual(thread.turns[2].user.settings, thread.turns[1].user.settings);
  assert.deepEqual(thread.queue?.map(message => message.text), ['Keep this queued']);
  assert.match(thread.queueHeld ?? '', /stopped/i);
  const current = value(await host.call('material.read', { id: brief.id }));
  assert.equal(current.text, 'The person corrected the plan.');
  assert.equal(current.entry.current, saved.current);
  assert.equal(current.entry.versions.at(-1)?.by, 'person');
  const seen = readFileSync(join(script.dir, 'seen.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.match(seen.at(-1).text, /The person corrected the plan/);
  host.close(); await hostClosed(home);
  const reopened = open(home, { harness: 'scripted' }).host;
  assert.deepEqual(value(await reopened.call('threads.restart', original)), admitted);
  const restored = value(await reopened.call('threads.get', { id: first.threadId }));
  assert.equal(restored.turns.length, 3);
  const queued = restored.queue![0];
  value(await reopened.call('queue.remove', { threadId: first.threadId, id: queued.id, baseVersion: queued.version }));
  const preview = value(await reopened.call('threads.rewindPreview', original));
  value(await reopened.call('threads.rewind', { ...original, revision: preview.revision, clientKey: 'rewind-continuation', choices: [] }));
  reopened.close(); await hostClosed(home);
  const afterRewind = open(home, { harness: 'scripted' }).host;
  const fresh = value(await afterRewind.call('threads.restart', original));
  assert.notEqual(fresh.turnId, admitted.turnId, 'a rewind starts a fresh continuation identity');
  await idle(afterRewind, first.threadId);
  const retained = value(await afterRewind.call('threads.get', { id: first.threadId }));
  assert.equal(retained.turns.length, 3, 'the new continuation is visible in the active branch');
  assert.equal(retained.turns.at(-1)!.id, fresh.turnId);
  assert.equal(retained.rewinds?.[0].turns[0].restartOf, original.turnId);
});

test('Host binds Stop and continuation admission to the displayed turn without stopping newer work', async t => {
  const script = scripted();
  t.after(() => { delete process.env.BACKBONE_SCRIPT_DIR; });
  script.plan('Hold newer work', { write: { title: 'later.md', content: 'Later.' }, hold: 'newer', answer: 'Later.' });
  const { host } = open(undefined, { harness: 'scripted' });
  const project = value(await host.call('projects.create', { name: 'Expected turn', kind: 'folder' }));
  const old = value(await host.call('turns.send', { projectId: project.id, text: 'Ready', attachments: [], settings, clientKey: 'old' }));
  await idle(host, old.threadId);
  const newer = value(await host.call('turns.send', { threadId: old.threadId, projectId: project.id, text: 'Hold newer work', attachments: [], settings, clientKey: 'newer' }));
  await waitFor(() => existsSync(join(script.dir, 'held', 'newer')), 'newer Host worker reaches its hold');
  const staleStop = await host.call('turns.stop', old);
  assert.deepEqual([staleStop.ok, !staleStop.ok && staleStop.reason], [false, 'STALE_BASE']);
  assert.equal(value(await host.call('threads.get', { id: old.threadId })).summary.running, true);
  value(await host.call('turns.stop', newer)); await idle(host, old.threadId);
  const staleSend = await host.call('turns.send', { threadId: old.threadId, projectId: project.id, text: 'A stale continuation', attachments: [], settings, clientKey: 'stale', afterTurnId: old.turnId });
  assert.deepEqual([staleSend.ok, !staleSend.ok && staleSend.reason], [false, 'STALE_BASE']);
  assert.equal(value(await host.call('threads.get', { id: old.threadId })).turns.length, 2);
});

test('Host restart stops a dispatched write but never continues past its unknown outcome, including after reopening', async () => {
  let dispatched!: () => void;
  const begun = new Promise<void>(resolve => { dispatched = resolve; });
  const { host, home } = open(undefined, { writeDelayMs: 1500, atPoint: point => { if (point === 'write.begun') dispatched(); } });
  const project = value(await host.call('projects.create', { name: 'Unknown action', kind: 'folder' }));
  const original = value(await host.call('turns.send', { projectId: project.id, text: 'Write an editable brief', attachments: [], settings, clientKey: 'write' }));
  await begun;
  const refused = await host.call('threads.restart', original);
  assert.equal(refused.ok, false);
  assert.match(!refused.ok ? refused.detail : '', /unknown outcome|inspection/i);
  const stopped = await idle(host, original.threadId);
  assert.equal(stopped.turns.length, 1);
  assert.equal(stopped.turns[0].effects[0].outcome, 'UNKNOWN');
  host.close(); await hostClosed(home);
  const reopened = open(home).host;
  assert.equal((await reopened.call('threads.restart', original)).ok, false);
  const retained = value(await reopened.call('threads.get', { id: original.threadId }));
  assert.equal(retained.turns.length, 1);
  assert.equal(retained.turns[0].effects[0].outcome, 'UNKNOWN');
});


test('Host restart after rewind starts a visible new continuation in the same process', async t => {
  const script = scripted();
  t.after(() => { delete process.env.BACKBONE_SCRIPT_DIR; });
  script.plan('Interrupted work', { write: { title: 'unused.md', content: 'Must not write.' }, hold: 'restart-rewind', answer: 'Should stop.' });
  const { host } = open(undefined, { harness: 'scripted' });
  const project = value(await host.call('projects.create', { name: 'Restart after rewind', kind: 'folder' }));
  const original = value(await host.call('turns.send', { projectId: project.id, text: 'Interrupted work', attachments: [], settings, clientKey: 'original' }));
  await waitFor(() => existsSync(join(script.dir, 'held', 'restart-rewind')), 'original worker reaches hold');
  const previous = value(await host.call('threads.restart', original));
  await idle(host, original.threadId);
  const preview = value(await host.call('threads.rewindPreview', original));
  value(await host.call('threads.rewind', { ...original, revision: preview.revision, clientKey: 'rewind', choices: [] }));
  const next = value(await host.call('threads.restart', original));
  assert.notEqual(next.turnId, previous.turnId);
  assert.deepEqual(value(await host.call('threads.restart', original)), next, 'same-generation retries find the same continuation');
  const thread = await idle(host, original.threadId);
  assert.deepEqual(thread.turns.map(turn => turn.id), [original.turnId, next.turnId]);
  assert.equal(thread.rewinds?.[0].turns[0].id, previous.turnId);
});
