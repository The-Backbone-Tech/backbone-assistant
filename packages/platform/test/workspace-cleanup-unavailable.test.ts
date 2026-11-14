import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WorkspaceStore } from '../src/workspace/store.ts';
import { workspaceAvailable } from '../src/workspace/policy.ts';
import { cleanThreadWorkspace, startWorkspaceSweep } from '../src/composition/workspace-lifecycle.ts';

for (const operation of ['delete', 'expire'] as const) test(`Linux ${operation} removes retained material when confinement is unavailable`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-unavailable-cleanup-'));
  const store = new WorkspaceStore('owned-unavailable-cleanup', { root: join(root, 'storage') });
  const folder = join(store.directory, createHash('sha256').update('thread').digest('hex'));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!, exists = fs.existsSync;
  try {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const expiresAt = Date.now() + (operation === 'expire' ? -1 : 60_000);
    await store.save({ folder, createdAt: expiresAt - 86_400_000, expiresAt, sources: [] });
    await writeFile(join(folder, 'retained-private.csv'), 'fake private material');
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    fs.existsSync = (path => String(path) === '/usr/bin/bwrap' ? false : exists(path)) as typeof fs.existsSync;
    syncBuiltinESMExports();
    assert.equal(await workspaceAvailable(), false);
    if (operation === 'delete') await cleanThreadWorkspace('owned-unavailable-cleanup', 'thread', store);
    else await startWorkspaceSweep('owned-unavailable-cleanup', 60_000, store)();
    assert.equal(exists(folder), false, 'retained source and derived bytes must be removed');
    assert.equal(exists(store.directory), false, 'an empty workspace home must be pruned');
  } finally {
    Object.defineProperty(process, 'platform', platform); fs.existsSync = exists; syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

test('deletion remains durably pending while Python cannot confirm a crashed run, then sweep retries it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-python-cleanup-'));
  const store = new WorkspaceStore('owned-python-cleanup', { root: join(root, 'storage') });
  const folder = join(store.directory, createHash('sha256').update('thread').digest('hex'));
  const execFile = childProcess.execFile;
  try {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await store.save({ folder, createdAt: Date.now(), expiresAt: Date.now() + 60_000, sources: [] });
    await writeFile(join(folder, 'retained-private.csv'), 'fake private material');
    // No permits exist, so this impossible stale PID can never authorize a signal.
    await writeFile(join(folder, '.running'), JSON.stringify({ pid: 2_147_483_647, uid: process.getuid?.() ?? 0, start: '1:1', token: randomUUID(), deadline: Date.now() - 1 }));
    childProcess.execFile = ((...args: Parameters<typeof execFile>) => Reflect.apply(execFile, childProcess, [join(root, 'missing-python'), ...args.slice(1)])) as typeof execFile;
    syncBuiltinESMExports();
    await assert.rejects(store.remove('thread'), /process identity could not be confirmed/i);
    assert.equal(fs.existsSync(join(folder, '.retiring')), true, 'deletion intent survives the failed helper');
    await store.sweep();
    assert.equal(fs.existsSync(join(folder, 'retained-private.csv')), true, 'uncertain process ownership must retain scratch');
    assert.equal(fs.existsSync(join(folder, '.retiring')), true);
    childProcess.execFile = execFile; syncBuiltinESMExports();
    await store.sweep();
    assert.equal(fs.existsSync(folder), false, 'the real helper confirms the stale PID and retries pending deletion');
    assert.equal(fs.existsSync(store.directory), false);
  } finally {
    childProcess.execFile = execFile; syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});
