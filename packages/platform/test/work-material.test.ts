import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hostClosed } from '../src/composition/host.ts';
import { b64, idle, open, value } from './helpers.ts';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

test('R-FILES-ORIG-01: attach keeps the original bytes untouched and classes them original', async () => {
  const { host } = open();
  const p = value(await host.call('projects.create', { name: 'Q4', kind: 'folder' }));
  const bytes = new Uint8Array([0x50, 0x4b, 3, 4, 0, 255, 10, 13]);
  const e = value(await host.call('material.attach', { projectId: p.id, name: 'data.xlsx', base64: b64(bytes), mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  assert.equal(e.class, 'original');
  assert.equal(e.versions[0].sha256, sha(bytes));
  const back = value(await host.call('material.read', { id: e.id }));
  assert.equal(back.base64, b64(bytes));
  const refused = await host.call('material.save', { id: e.id, text: 'x', baseVersion: 1 });
  assert.equal(refused.ok, false, 'an original is never modified');
});

test('R-BASE-02: Save stores a new version owned by the person; a stale base is refused', async () => {
  const { host } = open();
  const p = value(await host.call('projects.create', { name: 'P', kind: 'folder' }));
  const e = value(await host.call('material.attach', { projectId: p.id, name: 'note.md', base64: b64('# Note\n'), mediaType: 'text/markdown' }));
  // A note the person attaches is an original; the person edits a working copy produced by an agent.
  const t = value(await host.call('turns.send', { projectId: p.id, text: 'Write an editable brief', attachments: [e.id], settings: { permission: 'ask', model: 'stub', effort: 3, runsOn: 'this-computer', mode: 'chat' }, clientKey: 'k1' }));
  // The turn finishes, however busy the machine is, before its brief is looked for.
  await idle(host, t.threadId);
  const brief = (await host.call('material.list', { projectId: p.id })).find((m) => m.name === 'brief.md');
  assert.ok(brief, 'the agent wrote brief.md');
  assert.equal(brief.class, 'working');
  const saved = value(await host.call('material.save', { id: brief.id, text: '# Brief v2\nEdited by me.\n', baseVersion: 1 }));
  assert.equal(saved.current, 2);
  assert.equal(saved.versions[1].by, 'person');
  assert.equal(saved.class, 'accepted');
  const stale = await host.call('material.save', { id: brief.id, text: 'again', baseVersion: 1 });
  assert.equal(stale.ok, false);
  assert.equal(!stale.ok && stale.reason, 'STALE_BASE');
  assert.ok(t.threadId);
});

test('R-FILES-OS-01, R-MEM-TIER-01: files are classed and intermediates are hidden, not deleted', async () => {
  const { host } = open();
  const p = value(await host.call('projects.create', { name: 'P', kind: 'folder' }));
  value(await host.call('material.attach', { projectId: p.id, name: 'note.md', base64: b64('hi'), mediaType: 'text/markdown' }));
  const files = await host.call('files.list', { projectId: p.id });
  assert.deepEqual(files.map((f) => [f.path, f.class]), [['note.md', 'original']]);
  assert.ok(files.every((f) => !f.path.includes('.tmp')));
});

for (const crashAt of ['after-intent', 'after-version', 'after-meta'] as const) {
  test(`J-01 A1: kill during Save (${crashAt}) leaves exactly one of {v1, v2} and states which`, async () => {
    const { home, host } = open();
    const p = value(await host.call('projects.create', { name: 'P', kind: 'folder' }));
    value(await host.call('turns.send', { projectId: p.id, text: 'Draft a brief', attachments: [], settings: { permission: 'ask', model: 'stub', effort: 3, runsOn: 'this-computer', mode: 'chat' }, clientKey: 'k' }));
    await new Promise((r) => setTimeout(r, 50));
    const brief = (await host.call('material.list', { projectId: p.id })).find((m) => m.name === 'brief.md');
    assert.ok(brief);
    host.close();
    await hostClosed(home); // Its owner's hold goes last, and the child must find the home free.
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./crash-save.ts', import.meta.url)), home, brief.id], {
      env: { ...process.env, BACKBONE_STUB_CRASH_AT: crashAt },
      encoding: 'utf8',
    });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const { host: after } = open(home);
    const e = value(await after.call('material.read', { id: brief.id })).entry;
    assert.ok(e.versions.length === 1 || e.versions.length === 2);
    assert.equal(e.current, e.versions.length);
    if (crashAt === 'after-meta') {
      assert.equal(e.current, 2);
    } else {
      assert.equal(e.current, 1);
      assert.deepEqual(e.interruptedSave?.version, 2, 'the UI can state that v2 did not finish');
    }
    const text = value(await after.call('material.read', { id: brief.id })).text;
    assert.equal(text?.startsWith('# Edited'), e.current === 2);
  });
}
