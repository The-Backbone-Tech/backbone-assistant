import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertHomeWriteAdmission } from '../src/composition/home-lock.ts';
import { MaterialStore } from '../src/stub/material.ts';
import { createProjectFiles } from '../src/composition/project-files.ts';

test('a later agent revision is working; the person still owns their saved version', async t => {
  const home = mkdtempSync(join(tmpdir(), 'current-author-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const material = new MaterialStore(home, {}, () => {});
  const one = material.create('p', 'summary.md', 'text/markdown', Buffer.from('one'), 'working', 'agent');
  assert.ok((await material.save(one.id, 'person edit', 1)).ok);
  const revision = await material.save(one.id, 'person edit plus revision', 2, 'agent');
  assert.ok(revision.ok);
  assert.equal(revision.value.class, 'working');
  assert.deepEqual(revision.value.versions.map(v => v.by), ['agent', 'person', 'agent']);
  assert.equal(Buffer.from(material.bytes(one.id, 2)).toString(), 'person edit');
});

test('an unregistered folder file is not presented as working material', t => {
  const home = mkdtempSync(join(tmpdir(), 'unattached-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, 'project');
  assertHomeWriteAdmission(home); mkdirSync(root);
  assertHomeWriteAdmission(home); writeFileSync(join(root, 'sales.csv'), 'region,revenue');
  const material = new MaterialStore(home, {}, () => {});
  const { filesOf } = createProjectFiles({ findProject: () => ({ id: 'p', name: 'P', kind: 'folder', createdAt: new Date().toISOString() }), projectDir: () => root, material });
  assert.deepEqual(filesOf('p'), [{ path: 'sales.csv', class: 'unregistered' }]);
});

test('older metadata cannot claim the agent current version was saved by the person', t => {
  const home = mkdtempSync(join(tmpdir(), 'legacy-acceptance-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new MaterialStore(home, {}, () => {});
  // The previous writer retained accepted on subsequent agent writes. Reproduce that stored state.
  const old = store.create('p', 'old.md', 'text/markdown', Buffer.from('agent revision'), 'accepted', 'agent');
  assert.equal(store.load(old.id)?.class, 'working');
});


test('tracked Git files stay visible as unregistered without becoming engine material', t => {
  const home = mkdtempSync(join(tmpdir(), 'unregistered-git-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  assertHomeWriteAdmission(home); writeFileSync(join(home, 'index.ts'), 'export const answer = 42;');
  assertHomeWriteAdmission(home); execFileSync('git', ['init', '-q'], { cwd: home });
  assertHomeWriteAdmission(home); execFileSync('git', ['add', 'index.ts'], { cwd: home });
  const material = new MaterialStore(home, {}, () => {});
  const { filesOf } = createProjectFiles({ findProject: () => ({ id: 'p', name: 'P', kind: 'git', createdAt: '' }), projectDir: () => home, material });
  assert.deepEqual(filesOf('p'), [{ path: 'index.ts', class: 'unregistered' }]); assert.deepEqual(material.available('p'), []);
});
