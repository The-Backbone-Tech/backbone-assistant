import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { workspaceTools } from '../src/composition/workspace-tools.ts';
import { WorkspaceStore, type WorkspaceRecord } from '../src/workspace/store.ts';
import { workspaceFailure } from '../src/workspace/result.ts';

test('a Host policy refusal rejects before dispatch and supplies fixed refusal evidence without starting a command', async t => {
  const home = await mkdtemp(join(tmpdir(), 'workspace-host-refusal-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let calls = 0;
  t.mock.method(WorkspaceStore.prototype, 'execute', async () => { calls++; throw new Error('Must not execute'); });
  const tools = workspaceTools({ home, threadId: 'owned-thread', projectId: 'owned-project', attachments: [],
    material: {} as Parameters<typeof workspaceTools>[0]['material'], signal: new AbortController().signal,
    alive: () => true, sources: () => [], tools: { read: async () => null, stillGranted: () => 'private refusal details' } });
  await assert.rejects(tools.runWorkspace!({ command: 'must not run' }), error => {
    assert.ok(error instanceof Error && error.message, 'the caller retains the original diagnostic');
    const result = workspaceFailure(error);
    assert.equal(result.phase, 'refused');
    assert.doesNotMatch(result.detail, /private refusal details/);
    return true;
  });
  assert.equal(calls, 0);
});

test('source invalidation after command dispatch remains unknown rather than a pre-execution refusal', async t => {
  const home = await mkdtemp(join(tmpdir(), 'workspace-host-after-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let ran = false;
  t.mock.method(WorkspaceStore.prototype, 'use', async <T>(_thread: string, action: (record: WorkspaceRecord) => Promise<T>) => action({ sources: [], folder: home, createdAt: Date.now(), expiresAt: Date.now() + 60_000 }));
  t.mock.method(WorkspaceStore.prototype, 'save', async () => {});
  t.mock.method(WorkspaceStore.prototype, 'remove', async () => {});
  t.mock.method(WorkspaceStore.prototype, 'execute', async () => { ran = true; return { code: 0, stdout: '', stderr: '' }; });
  const tools = workspaceTools({ home, threadId: 'owned-thread', projectId: 'owned-project', attachments: [],
    material: {} as Parameters<typeof workspaceTools>[0]['material'], signal: new AbortController().signal,
    alive: () => true, sources: () => [], tools: { read: async () => null, stillGranted: () => ran ? 'withdrawn after execution' : true } });
  await assert.rejects(tools.runWorkspace!({ command: 'owned command' }), error => {
    assert.equal(workspaceFailure(error).phase, 'unknown');
    return true;
  });
  assert.equal(ran, true);
});
