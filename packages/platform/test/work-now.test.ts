// The project's current view and temporary output's lifecycle: concise, derived, and unable to hide
// unfinished work or lose a person's edit.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { workNow } from '../src/composition/work-now.ts';
import { startScriptedModel, type ScriptedModel } from '../src/testing/scripted-model.ts';
import { freshHome, idle, open, settings, value } from './helpers.ts';

let model: ScriptedModel;
before(async () => {
  model = await startScriptedModel();
  process.env.BACKBONE_MODEL_ENDPOINT = model.url;
  process.env.BACKBONE_MODEL_ID = model.model;
});
after(async () => {
  delete process.env.BACKBONE_MODEL_ENDPOINT;
  delete process.env.BACKBONE_MODEL_ID;
  await model.close();
});

/** A project with brief.md written by an agent in a thread the person has since archived. */
async function superseded() {
  const { host } = open(undefined, { harness: 'harness-pi' });
  const p = value(await host.call('projects.create', { name: 'Now', kind: 'folder' }));
  const first = value(await host.call('turns.send', { projectId: p.id, text: 'Write an editable brief', attachments: [], settings, clientKey: 'a' }));
  await idle(host, first.threadId);
  const brief = (await host.call('material.list', { projectId: p.id })).find((m) => m.name === 'brief.md')!;
  const before = await host.call('work.now', { projectId: p.id });
  assert.deepEqual([before.temporary.length, before.current.map((d) => d.id)], [0, [brief.id]], 'the latest answer is current');
  assert.equal((await host.call('material.lifecycle', { id: brief.id, version: brief.current, state: 'retired' })).ok, false);
  value(await host.call('threads.update', { id: first.threadId, patch: { archived: true } }));
  return { host, p, brief, threadId: first.threadId };
}

test('retiring temporary output hides it, keeps its versions and can be undone', async () => {
  const { host, p, brief } = await superseded();
  assert.deepEqual((await host.call('work.now', { projectId: p.id })).temporary.map((d) => d.id), [brief.id]);
  value(await host.call('material.lifecycle', { id: brief.id, version: brief.current, state: 'retired' }));
  const later = await host.call('work.now', { projectId: p.id });
  assert.deepEqual([later.temporary.length, later.retired.map((d) => d.id)], [0, [brief.id]]);
  assert.ok(value(await host.call('material.read', { id: brief.id })).text!.length > 0);
  value(await host.call('material.lifecycle', { id: brief.id, version: brief.current, state: 'current', lifecycle: 1 }));
  assert.equal((await host.call('work.now', { projectId: p.id })).retired.length, 0);
});

test('a stale view cannot retire a document the person has since edited', async () => {
  const { host, p, brief } = await superseded();
  value(await host.call('material.save', { id: brief.id, text: '# Mine\n', baseVersion: brief.current }));
  const refused = await host.call('material.lifecycle', { id: brief.id, version: brief.current, state: 'retired' });
  assert.deepEqual([refused.ok, !refused.ok && refused.reason], [false, 'STALE_BASE']);
  const again = await host.call('material.lifecycle', { id: brief.id, version: brief.current + 1, state: 'retired' });
  assert.equal(again.ok, false, "a person's version is never temporary");
  assert.ok((await host.call('work.now', { projectId: p.id })).current.some((d) => d.id === brief.id));
});

test('an unsaved edit keeps a document out of temporary output, and a Save on a retired document brings it back', async () => {
  const { host, p, brief } = await superseded();
  value(await host.call('drafts.put', { key: `edit:${brief.id}`, text: 'typing', meta: {}, clientKey: 'd' } as never));
  assert.ok(!(await host.call('work.now', { projectId: p.id })).temporary.some((d) => d.id === brief.id));
  value(await host.call('drafts.put', { key: `edit:${brief.id}`, text: '', meta: {}, clientKey: 'e', baseRevision: 1 } as never));
  value(await host.call('material.lifecycle', { id: brief.id, version: brief.current, state: 'retired' }));
  const saved = value(await host.call('material.save', { id: brief.id, text: '# From the open editor\n', baseVersion: brief.current }));
  assert.equal(saved.hidden, false);
  assert.ok((await host.call('work.now', { projectId: p.id })).current.some((d) => d.id === brief.id));
});

test('an interrupted write stays first in the view and cannot be cleaned away', async () => {
  const home = freshHome();
  const child = spawn(process.execPath, [join(import.meta.dirname, 'crash-turn.ts'), home], {
    env: { ...process.env, BACKBONE_HARNESS: 'harness-pi', BACKBONE_CRASH_AT: 'write.begun' }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  let out = '';
  child.stdout.on('data', (b: Buffer) => (out += b));
  await new Promise((r) => child.on('exit', r));
  const { threadId, projectId } = JSON.parse(out.trim().split('\n').at(-1)!) as { threadId: string; projectId: string };
  const { host } = open(home, { harness: 'harness-pi' });
  await new Promise((r) => setTimeout(r, 7000));
  await idle(host, threadId);
  const now = await host.call('work.now', { projectId });
  assert.equal(now.needsYou[0].kind, 'unknown');
  assert.equal(now.needsYou[0].threadId, threadId);
  assert.deepEqual(now.temporary, []);
});

test('archiving a thread settles nothing: its UNKNOWN stays first and still guards retirement', async () => {
  const home = freshHome();
  const child = spawn(process.execPath, [join(import.meta.dirname, 'crash-turn.ts'), home], {
    env: { ...process.env, BACKBONE_HARNESS: 'harness-pi', BACKBONE_CRASH_AT: 'write.begun' }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  let out = '';
  child.stdout.on('data', (b: Buffer) => (out += b));
  await new Promise((r) => child.on('exit', r));
  const { threadId, projectId } = JSON.parse(out.trim().split('\n').at(-1)!) as { threadId: string; projectId: string };
  const { host } = open(home, { harness: 'harness-pi' });
  await new Promise((r) => setTimeout(r, 7000));
  await idle(host, threadId);
  value(await host.call('threads.update', { id: threadId, patch: { archived: true } }));
  const now = await host.call('work.now', { projectId });
  assert.deepEqual(now.needsYou.map((n) => [n.kind, n.threadId]), [['unknown', threadId]]);
  // Material of that name appearing later is still guarded by the unresolved write.
  const attached = value(await host.call('material.attach', { projectId, name: 'brief.md', base64: Buffer.from('x').toString('base64'), mediaType: 'text/markdown' }));
  assert.equal((await host.call('material.lifecycle', { id: attached.id, version: attached.current, state: 'retired' })).ok, false);
});

test('archiving a running thread leaves its work in the view', () => {
  const summary = { id: 't', title: 'T', archived: true, running: true } as never;
  assert.deepEqual(workNow([{ summary, turns: [] }], [], () => false).running, [{ threadId: 't', title: 'T' }]);
});

test('a person can keep agent output; it stops being temporary', async () => {
  const { host, p, brief } = await superseded();
  value(await host.call('material.lifecycle', { id: brief.id, version: brief.current, state: 'kept' }));
  const now = await host.call('work.now', { projectId: p.id });
  assert.ok(!now.temporary.some((d) => d.id === brief.id));
  assert.equal((await host.call('material.lifecycle', { id: brief.id, version: brief.current, state: 'retired' })).ok, false);
});

test('progress is one line per piece of work, and a stopped turn is never reported as finished', async () => {
  const { host } = open(undefined, { harness: 'harness-pi' });
  const p = value(await host.call('projects.create', { name: 'Now', kind: 'folder' }));
  const sent = value(await host.call('turns.send', { projectId: p.id, text: 'Write an editable brief', attachments: [], settings, clientKey: 'a' }));
  await idle(host, sent.threadId);
  const now = await host.call('work.now', { projectId: p.id });
  assert.equal(now.progress.length, 1);
  assert.match(now.progress[0].line, /brief\.md/);
  assert.ok(!now.progress[0].line.includes('\n'));
});

test('a refused latest turn is unfinished work, not nothing', () => {
  const turn = { effects: [], status: 'refused', answer: { text: 'A write was refused.', files: [] }, user: { at: '2026-10-31' }, work: {} };
  const view = workNow([{ summary: { id: 't', title: 'Plan', archived: false, running: false }, turns: [turn] }] as never, [], () => false);
  assert.deepEqual(view.needsYou.map((n) => [n.threadId, n.detail]), [['t', 'A write was refused.']]);
  assert.equal(view.progress.length, 0);
});

test('an archived UNKNOWN protects matching agent-only working material, not just immutable originals', () => {
  const entry = { id: 'draft', name: 'brief.md', class: 'working', hidden: false, current: 1, versions: [{ n: 1, by: 'agent', at: '2026-11-02' }] };
  const thread = { summary: { id: 't', title: 'Archived work', archived: true, running: false }, turns: [{ status: 'done', effects: [{ outcome: 'UNKNOWN', target: 'brief.md' }], work: {} }] };
  const view = workNow([thread] as never, [entry] as never, () => false);
  assert.deepEqual(view.needsYou.map((n) => n.kind), ['unknown']);
  assert.deepEqual(view.temporary, [], 'ordinary retirement consumes this classification');
  assert.deepEqual(view.current.map((d) => d.id), ['draft']);
  const settled = { ...thread, turns: [{ ...thread.turns[0], effects: [] }] };
  assert.deepEqual(workNow([settled] as never, [entry] as never, () => false).temporary.map((d) => d.id), ['draft'], 'the control must be otherwise eligible for retirement');
});
