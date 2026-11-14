import { directoryIdentity, assertDirectory } from '../src/directories.ts';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, chmod, rm, stat, realpath, open, rmdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { test } from 'node:test';
import { canonicalDeniedPath } from '../src/write-restrictions.ts';
import { privateDirectory, retireDirectory } from '../src/storage.ts';
import { AgentProcess } from '../src/transport.ts';

test('missing denied paths resolve the deepest existing symlinked ancestor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acp-deny-'));
  try {
    const target = join(root, 'target'); await mkdir(target); await symlink(target, join(root, 'alias'));
    const canonical = await realpath(target);
    assert.equal(canonicalDeniedPath(join(root, 'alias', 'later', 'secret')), join(canonical, 'later', 'secret'));
    await symlink(join(root, 'missing'), join(root, 'dangling'));
    assert.equal(canonicalDeniedPath(join(root, 'dangling', 'secret')), join(await realpath(root), 'missing', 'secret'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('storage refuses symlinks, public modes and a different owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acp-private-'));
  try {
    const safe = join(root, 'safe'); await privateDirectory(safe);
    assert.equal((await stat(safe)).mode & 0o777, 0o700);
    await symlink(safe, join(root, 'alias')); await assert.rejects(privateDirectory(join(root, 'alias')));
    await chmod(safe, 0o755); await assert.rejects(privateDirectory(safe), /mode 0700/);
    await chmod(safe, 0o2700); await assert.rejects(privateDirectory(safe), /mode 0700/);
    const getuid = process.getuid!;
    try { process.getuid = () => getuid() + 1; await assert.rejects(privateDirectory(root), /owned by this user/); }
    finally { process.getuid = getuid; }
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('a session tree is renamed outside its granted path before deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acp-retire-')), tree = join(root, 'session'), outside = join(root, 'outside');
  await mkdir(tree); await mkdir(outside); await writeFile(join(outside, 'keep'), 'keep'); await symlink(outside, join(tree, 'link'));
  try {
    await retireDirectory(tree, async (path, options) => {
      assert.equal(existsSync(tree), false); assert.equal(dirname(String(path)), root); assert.match(String(path), /\.retired-/);
      await rm(path, options);
    });
    assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'keep');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('closing an agent after observed exit never signals its old process group', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acp-exit-'));
  const agent = new AgentProcess({ acceptsProcessVisibility: true, command: process.execPath, args: ['-e', 'setTimeout(()=>process.exit(0),20)'], environment: 'person-rights' }, directoryIdentity(root), directoryIdentity(root));
  await new Promise<void>(resolve => agent.process.once('exit', () => resolve()));
  const kill = process.kill, calls: number[] = [];
  try {
    process.kill = ((pid: number) => { calls.push(pid); return true; }) as typeof process.kill;
    await agent.close(); assert.deepEqual(calls, []);
  } finally { process.kill = kill; await rm(root, { recursive: true, force: true }); }
});

test('closing the owned process group reaches an agent grandchild', { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'acp-grandchild-')), pidFile = join(root, 'pid');
  const grandchild = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
  const child = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
  const agent = new AgentProcess({ acceptsProcessVisibility: true, command: process.execPath, args: ['-e', parent], environment: 'person-rights' }, directoryIdentity(root), directoryIdentity(root));
  let pid: number | undefined;
  const live = async (value: number) => {
    try { process.kill(value, 0); } catch { return false; }
    const { spawnSync } = await import('node:child_process');
    return !/Z/.test(spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(value)], { encoding: 'utf8' }).stdout);
  };
  try {
    for (let i = 0; i < 100; i++) { try { const candidate = Number(await readFile(pidFile, 'utf8')); if (Number.isSafeInteger(candidate) && candidate > 0) { pid = candidate; break; } } catch { await new Promise(resolve => setTimeout(resolve, 10)); } }
    assert.ok(pid); assert.equal(await live(pid), true);
    await agent.close();
    for (let i = 0; i < 100 && await live(pid); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(await live(pid), false, 'a positive-PID-only kill would leave the grandchild running');
  } finally { await agent.close(); if (pid && await live(pid)) process.kill(pid, 'SIGKILL'); await rm(root, { recursive: true, force: true }); }
});

test('session allocation retries when another harness removes the empty shared root after validation', async () => {
  const { Session } = await import('../src/session.ts');
  const root = await mkdtemp(join(tmpdir(), 'acp-allocation-race-')), storage = join(root, 'shared');
  await privateDirectory(storage);
  const inode = (await stat(storage)).ino, handle = await open(storage, 'r');
  const prototype = Object.getPrototypeOf(handle), metadata = prototype.stat;
  let removed = false, session: Awaited<ReturnType<typeof Session.create>> | undefined;
  try {
    prototype.stat = async function (...args: unknown[]) {
      const info = await metadata.apply(this, args);
      if (!removed && info.ino === inode) {
        const close = this.close;
        this.close = async () => { await close.call(this); if (!removed) { removed = true; await rmdir(storage); } };
      }
      return info;
    };
    session = await Session.create({ acceptsProcessVisibility: true, command: process.execPath, args: [], storage }, 'allocation-race');
    assert.equal(removed, true); assert.ok((await stat(session.work)).isDirectory()); assert.ok((await stat(session.state)).isDirectory());
  } finally { prototype.stat = metadata; await handle.close(); await session?.close(true); await rm(root, { recursive: true, force: true }); }
});
