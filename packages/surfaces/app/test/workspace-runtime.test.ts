import { TEST_HANG_MS } from '../../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'vite';
import { workspaceAvailable } from '../../../platform/src/workspace/policy.ts';
// @ts-expect-error build scripts are plain JavaScript
import { stageWorkspaceRuntime } from '../scripts/workspace-runtime.mjs';

test('desktop staging retains the trusted Linux supervisor source closure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linux-workspace-desktop-'));
  try {
    stageWorkspaceRuntime(root);
    for (const file of ['linux.py', 'linux-worker.ts', 'linux-policy.ts', 'processes.ts', 'runtime.ts', 'volume.ts']) {
      assert.equal(await readFile(join(root, file), 'utf8'), await readFile(new URL(`../../../platform/src/workspace/${file}`, import.meta.url), 'utf8'));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('desktop CommonJS bundle runs the staged workspace supervisors with persistent SQLite', { timeout: TEST_HANG_MS * 2 }, async t => {
  if (process.platform !== 'darwin') { t.skip('The macOS bundle supervisor requires Seatbelt and disk images'); return; }
  const root = await mkdtemp(join(tmpdir(), 'workspace-desktop-'));
  try {
    await build({ configFile: false, logLevel: 'silent', build: { ssr: new URL('../../../platform/src/workspace/store.ts', import.meta.url).pathname, outDir: root, emptyOutDir: false, target: 'node22', rollupOptions: { output: { format: 'cjs', entryFileNames: 'store.cjs' } } } });
    stageWorkspaceRuntime(join(root, 'workspace-runtime'));
    const { WorkspaceStore } = createRequire(import.meta.url)(join(root, 'store.cjs'));
    const store = new WorkspaceStore('owned-desktop-home', { root: join(root, 'storage') });
    try {
      const result = await store.run('thread', { command: "sqlite3 data.db 'create table n(v); insert into n values(23); select v from n'", inputs: [] });
      assert.equal(result.code, 0, JSON.stringify(result)); assert.equal(result.stdout.trim(), '23');
      assert.equal((await store.run('thread', { command: "sqlite3 data.db 'select v*2 from n'", inputs: [] })).stdout.trim(), '46');
    } finally { await store.remove('thread'); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Linux CommonJS bundle executes the staged confined supervisor and retains SQLite', { timeout: 90_000 }, async t => {
  if (process.platform !== 'linux') { t.skip('The Linux bundle supervisor needs a Linux kernel'); return; }
  if (process.arch !== 'arm64') { t.skip('The Linux bundle supervisor is qualified only on arm64; ' + process.arch + ' is unqualified'); return; }
  if (!await workspaceAvailable()) { t.skip('Linux workspace needs its binaries, user namespaces and delegated cgroup v2 memory/pids controls'); return; }
  const root = await mkdtemp(join(tmpdir(), 'workspace-linux-bundle-'));
  try {
    await build({ configFile: false, logLevel: 'silent', build: { ssr: new URL('../../../platform/src/workspace/store.ts', import.meta.url).pathname, outDir: root, emptyOutDir: false, target: 'node22', rollupOptions: { output: { format: 'cjs', entryFileNames: 'store.cjs' } } } });
    stageWorkspaceRuntime(join(root, 'workspace-runtime'));
    const { WorkspaceStore } = createRequire(import.meta.url)(join(root, 'store.cjs'));
    const store = new WorkspaceStore('owned-linux-bundle', { root: join(root, 'storage') });
    try {
      const first = await store.run('thread', { command: `python3 -c "import sqlite3; c=sqlite3.connect('data.db'); c.execute('create table n(v)'); c.execute('insert into n values(23)'); c.commit(); print(c.execute('select v from n').fetchone()[0])"`, inputs: [] });
      assert.equal(first.code, 0, JSON.stringify(first)); assert.equal(first.stdout.trim(), '23');
      const next = await store.run('thread', { command: `python3 -c "import sqlite3; print(sqlite3.connect('data.db').execute('select v*2 from n').fetchone()[0])"`, inputs: [] });
      assert.equal(next.code, 0, JSON.stringify(next)); assert.equal(next.stdout.trim(), '46');
    } finally { await store.remove('thread'); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
