import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { b64, idle, open, settings, value } from './helpers.ts';

async function projectWithBrief() {
  const ctx = open();
  const { host } = ctx;
  const p = value(await host.call('projects.create', { name: 'Q4 review', kind: 'folder' }));
  const note = value(await host.call('material.attach', { projectId: p.id, name: 'note.md', base64: b64('# Revenue\nUp 4%.\n'), mediaType: 'text/markdown' }));
  const sheet = value(await host.call('material.attach', { projectId: p.id, name: 'data.xlsx', base64: b64('PK\u0003\u0004'), mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const sent = value(await host.call('turns.send', { projectId: p.id, text: 'Write an editable brief from these', attachments: [note.id, sheet.id], settings, clientKey: 'c1' }));
  const thread = await idle(host, sent.threadId);
  return { ...ctx, p, note, sheet, sent, thread };
}

test('R-BASE-01, R-UX-THREAD-01: a turn produces an editable brief beside the conversation, with a work block and a pinned summary', async () => {
  const { thread, p } = await projectWithBrief();
  assert.equal(thread.summary.projectId, p.id);
  const turn = thread.turns[0];
  assert.equal(turn.status, 'done');
  assert.ok(turn.work.endedAt, 'the work block can say "worked for N"');
  assert.equal(turn.answer?.files[0].name, 'brief.md');
  assert.equal(thread.card.project, 'Q4 review');
  assert.deepEqual(thread.card.sources.map((s) => s.name), ['note.md', 'data.xlsx']);
  assert.ok(thread.card.changes.added > 0);
  assert.equal(thread.card.changes.files, 1);
});

test('a document version opens as its own diff, only for a version of this project', async () => {
  const { host, p, note } = await projectWithBrief();
  const brief = (await host.call('material.list', { projectId: p.id })).find((m) => m.name === 'brief.md')!;
  value(await host.call('material.save', { id: brief.id, text: '# Brief\nPerson wording: ship Friday.\n', baseVersion: 1 }));
  const v2 = value(await host.call('changes.get', { projectId: p.id, scope: 'last-turn', version: { materialId: brief.id, version: 2 } }));
  assert.equal(v2.base, 'v1');
  assert.deepEqual(v2.files.map((f) => f.path), ['brief.md']);
  assert.match(v2.files[0].patch, /\+Person wording: ship Friday\./);
  const v1 = value(await host.call('changes.get', { projectId: p.id, scope: 'last-turn', version: { materialId: brief.id, version: 1 } }));
  assert.equal(v1.base, 'empty');
  assert.equal(v1.files[0].removed, 0);
  const missing = await host.call('changes.get', { projectId: p.id, scope: 'last-turn', version: { materialId: brief.id, version: 9 } });
  assert.equal(!missing.ok && missing.reason, 'NOT_FOUND');
  const other = value(await host.call('projects.create', { name: 'Other', kind: 'folder' }));
  const elsewhere = await host.call('changes.get', { projectId: other.id, scope: 'last-turn', version: { materialId: note.id, version: 1 } });
  assert.equal(!elsewhere.ok && elsewhere.reason, 'NOT_FOUND', 'another project names no document here');
});

test('R-BASE-02: a follow-up in the same thread reads the version the person saved', async () => {
  const { host, thread, p } = await projectWithBrief();
  const brief = (await host.call('material.list', { projectId: p.id })).find((m) => m.name === 'brief.md')!;
  value(await host.call('material.save', { id: brief.id, text: '# Brief\nPerson wording: ship Friday.\n', baseVersion: 1 }));
  value(await host.call('turns.send', { threadId: thread.summary.id, projectId: p.id, text: 'What does the brief say now?', attachments: [], settings, clientKey: 'c2' }));
  const after = await idle(host, thread.summary.id);
  const last = after.turns.at(-1)!;
  assert.match(last.answer!.text, /v2/);
  assert.match(last.answer!.text, /ship Friday/);
});

test('side questions refuse honestly when the selected runtime has no model', async () => {
  const { host, thread, p } = await projectWithBrief();
  const before = (await host.call('material.list', { projectId: p.id })).find((m) => m.name === 'brief.md')!;
  const r = await host.call('sidechat.ask', { threadId: thread.summary.id, text: 'Change the brief to say we ship Monday' });
  assert.ok(!r.ok);
  assert.equal(r.reason, 'NOT_AVAILABLE');
  assert.match(r.detail, /model runtime/i);
  const after = (await host.call('material.list', { projectId: p.id })).find((m) => m.name === 'brief.md')!;
  assert.equal(after.current, before.current, 'no effect');
  const main = value(await host.call('threads.get', { id: thread.summary.id }));
  assert.equal(main.turns.length, 1);
  assert.equal(main.sideTurns.length, 0, 'a model-free response is not presented as a completed side turn');
});

test('R-BASE-04, J-01 A2: Stop during a write records UNKNOWN, and the exact copy is not resent', async () => {
  let inWrite = () => {};
  const begun = new Promise<void>((resolve) => { inWrite = resolve; });
  const { host } = open(undefined, { writeDelayMs: 1500, atPoint: (point) => { if (point === 'write.begun') inWrite(); } });
  const p = value(await host.call('projects.create', { name: 'P', kind: 'folder' }));
  const sent = value(await host.call('turns.send', { projectId: p.id, text: 'Draft a brief', attachments: [], settings, clientKey: 'a' }));
  await begun; // Stop inside the write: earlier than this is a clean cancel, correctly REFUSED.
  value(await host.call('turns.stop', { threadId: sent.threadId }));
  const t = await idle(host, sent.threadId);
  assert.equal(t.turns[0].status, 'stopped');
  assert.equal(t.turns[0].effects[0].outcome, 'UNKNOWN');
  value(await host.call('turns.send', { threadId: sent.threadId, projectId: p.id, text: 'Draft a brief', attachments: [], settings, clientKey: 'b' }));
  const t2 = await idle(host, sent.threadId);
  const again = t2.turns[1];
  assert.equal(again.effects[0].outcome, 'REFUSED');
  assert.match(again.effects[0].detail ?? '', /UNKNOWN/);
});

test('Stop before a write begins is reported as stopped, with nothing written', async () => {
  const { host } = open(undefined, { writeDelayMs: 300 });
  const p = value(await host.call('projects.create', { name: 'P', kind: 'folder' }));
  const sent = value(await host.call('turns.send', { projectId: p.id, text: 'Draft a brief', attachments: [], settings, clientKey: 'a' }));
  value(await host.call('turns.stop', { threadId: sent.threadId }));
  const t = await idle(host, sent.threadId);
  assert.equal(t.turns[0].status, 'stopped');
  assert.equal(t.turns[0].effects[0].outcome, 'REFUSED');
  assert.equal((await host.call('material.list', { projectId: p.id })).length, 0);
});

test('R-BASE-03: threads, unsent drafts and viewer prefs survive a cold start', async () => {
  const { host, home, thread } = await projectWithBrief();
  value(await host.call('drafts.put', { key: `composer:${thread.summary.id}`, text: 'half a thought', clientKey: 'd1' }));
  value(await host.call('drafts.put', { key: 'edit:x', text: 'unsaved edit', meta: { baseVersion: 1 }, clientKey: 'd2' }));
  await host.call('viewer.put', { prefs: { theme: 'dark', selectedThreadId: thread.summary.id, pane: { open: true, tabs: [{ id: 'files', kind: 'files' }], active: 'files' } } });
  host.close();
  const { host: again } = open(home);
  assert.equal((await again.call('drafts.get', { key: `composer:${thread.summary.id}` }))?.text, 'half a thought');
  assert.equal((await again.call('drafts.get', { key: 'edit:x' }))?.meta?.baseVersion, 1);
  assert.equal((await again.call('viewer.get', {})).pane.active, 'files');
  assert.equal(value(await again.call('threads.get', { id: thread.summary.id })).turns.length, 1);
});

test('drafts.put is idempotent by client key', async () => {
  const { host } = open();
  const a = value(await host.call('drafts.put', { key: 'k', text: 'one', clientKey: 'same' }));
  const b = value(await host.call('drafts.put', { key: 'k', text: 'one', clientKey: 'same' }));
  assert.equal(a.updatedAt, b.updatedAt);
});

test('R-UX-SIDEBAR-01: rows can be renamed, pinned, marked unread, moved to a section or project, archived and deleted', async () => {
  const { host, thread } = await projectWithBrief();
  const id = thread.summary.id;
  const other = value(await host.call('projects.create', { name: 'Other', kind: 'folder' }));
  value(await host.call('threads.update', { id, patch: { title: 'Renamed', pinned: true, unread: true, section: 'Workstreams' } }));
  value(await host.call('threads.update', { id, patch: { projectId: other.id } }));
  const row = (await host.call('threads.list', {})).find((t) => t.id === id)!;
  assert.deepEqual([row.title, row.pinned, row.unread, row.section, row.projectId], ['Renamed', true, true, 'Workstreams', other.id]);
  value(await host.call('threads.update', { id, patch: { archived: true } }));
  value(await host.call('threads.delete', { id }));
  assert.equal((await host.call('threads.list', {})).length, 0);
});

test('R-UX-PANES-01, R-WT-01: Changes offers every scope on a repository and last turn on a folder', async () => {
  const { host } = open();
  const repo = value(await host.call('projects.create', { name: 'scratch', kind: 'git' }));
  value(await host.call('terminal.run', { projectId: repo.id, command: 'printf "hello\\n" > hello.txt' }));
  const unc = value(await host.call('changes.get', { projectId: repo.id, scope: 'uncommitted' }));
  assert.deepEqual(unc.files.map((f) => f.path), ['hello.txt']);
  assert.match(unc.files[0].patch, /\+hello/);
  for (const scope of ['unstaged', 'staged', 'committed', 'branch'] as const) {
    assert.equal((await host.call('changes.get', { projectId: repo.id, scope })).ok, true, scope);
  }
  const log = value(await host.call('terminal.run', { projectId: repo.id, command: 'git log --oneline | wc -l' }));
  assert.equal(log.output.trim(), '1', 'nothing is committed without the person');
  const folder = value(await host.call('projects.create', { name: 'f', kind: 'folder' }));
  const r = await host.call('changes.get', { projectId: folder.id, scope: 'uncommitted' });
  assert.equal(!r.ok && r.reason, 'NOT_A_REPOSITORY');
  assert.ok(execFileSync('git', ['--version']).length);
});
