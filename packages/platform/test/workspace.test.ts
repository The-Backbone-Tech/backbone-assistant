import { pollUntil } from './helpers.ts';
import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { startWorkspaceSweep } from '../src/composition/workspace-lifecycle.ts';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WorkspaceStore, workspaceCommand } from '../src/workspace/store.ts';

const run = (command: string, input?: { name: string; bytes: Buffer }) => ({ command, inputs: input ? [input] : [] });
const python = (code: string) => `python3 - <<'PY'\n${code}\nPY`;

test('workspace refuses unsupported systems before creating any state', async () => {
  assert.throws(() => workspaceCommand('/tmp/unused', 'linux'), /macOS.*unavailable/i);
  assert.throws(() => workspaceCommand('/tmp/unused', 'win32'), /macOS.*unavailable/i);
  assert.throws(() => workspaceCommand('/tmp/unused', 'darwin', false), /sandbox-exec.*missing/);
});

test('a data home inside runtime reads is refused before command execution', async () => {
  if (process.platform !== 'darwin') return;
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workspace-overlap-')));
  try {
    await assert.rejects(new WorkspaceStore('/usr/lib', { root: join(root, 'storage') }).run('thread', run('echo should-not-run')), /overlaps/);
    assert.equal(existsSync(join(root, 'storage')), false, 'refuse before creating any storage');
    await assert.rejects(new WorkspaceStore(root, { root: join(root, 'scratch') }).run('thread', run('echo should-not-run')), /overlaps/);
    assert.equal(existsSync(join(root, 'scratch')), false, 'never initialize a workspace inside a data home');
  }
  finally { await rm(root, { recursive: true, force: true }); }
});

test('real macOS workspace: persistent SQLite, readonly inputs, filesystem, sockets, symlinks, peer environment and capacity', { timeout: 180_000 }, async () => {
  if (process.platform !== 'darwin') return;
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workspace-boundaries-')));
  const store = new WorkspaceStore('owned-fake-home', { root: join(root, 'storage') });
  const outside = join(root, 'data-home'); await mkdir(outside); await writeFile(join(outside, 'secret'), 'fake-private'); await mkdir(join(outside, 'keys')); await writeFile(join(outside, 'keys', 'canary'), 'fake-key');
  const target = spawn('/bin/sleep', ['100'], { env: { WORKSPACE_PRIVATE_CANARY: 'fake-peer-secret' }, stdio: 'ignore' });
  const tcp = createServer(); await new Promise<void>(resolve => tcp.listen(0, '127.0.0.1', resolve));
  const unix = createServer(), socket = join(root, 'product.sock'); await new Promise<void>(resolve => unix.listen(socket, resolve));
  try {
    const loaded = await store.run('one', run(python("import csv,sqlite3\nc=sqlite3.connect('data.db')\nc.execute('create table sales(n integer)')\nc.executemany('insert into sales values (?)', [(int(r['n']),) for r in csv.DictReader(open('../inputs/source.csv'))])\nc.commit()\nprint(c.execute('select sum(n) from sales').fetchone()[0])"), { name: 'source.csv', bytes: Buffer.from('n\n2\n3\n') }));
    assert.equal(loaded.code, 0, loaded.stderr); assert.match(loaded.stdout, /5/);
    const second = await store.run('one', run("sqlite3 data.db 'select sum(n)*2 from sales'"));
    assert.equal(second.stdout.trim(), '10');
    assert.equal((await readdir((await store.inspect('one'))!.folder)).some(name => name.startsWith('mount-')), false, 'empty mount paths do not accumulate outside the quota');
    const record = await store.inspect('one'); assert.ok(record); assert.equal(record.expiresAt - record.createdAt, 86_400_000);
    await assert.rejects(store.save({ ...record, sources: [{ name: 'x'.repeat(300000), materialId: 'm', version: 1, withdrawals: 0, input: 'x.csv' }] }), /metadata limit/);
    assert.equal((await store.run('one', run('echo changed > ../inputs/source.csv'))).code === 0, false);
    const other = await store.run('two', run('echo other-private > private')); assert.equal(other.code, 0, other.stderr);
    const sibling = await store.inspect('two'); assert.ok(sibling);
    const port = (tcp.address() as { port: number }).port;
    const check = await store.run('one', run(python(`import os,socket,ctypes\npaths=${JSON.stringify([join(outside, 'secret'), join(sibling.folder, 'volume.dmg'), join(outside, 'keys', 'canary'), '../inputs/source.csv'])}\nfor p in paths[:3]:\n try: open(p).read(); print('LEAK')\n except PermissionError: print('read denied')\nos.symlink(paths[0], 'escape')\ntry: open('escape','w').write('clobber'); print('ESCAPE')\nexcept PermissionError: print('symlink denied')\nfor family,address in [(socket.AF_INET,('127.0.0.1',${port})),(socket.AF_UNIX,${JSON.stringify(socket)})]:\n try: socket.socket(family).connect(address); print('NETWORK')\n except (PermissionError,OSError): print('network denied')\nlibc=ctypes.CDLL(None,use_errno=True)\nmib=(ctypes.c_int*3)(1,49,${target.pid}); buf=ctypes.create_string_buffer(1048576); size=ctypes.c_size_t(len(buf))\nprint('peer denied' if libc.sysctl(mib,3,buf,ctypes.byref(size),None,0)==-1 else 'PEER LEAK')\nprint('environment clean' if 'WORKSPACE_PRIVATE_CANARY' not in os.environ else 'ENV LEAK')`)));
    assert.equal(check.code, 0, check.stderr);
    assert.match(check.stdout, /read denied\nread denied\nread denied/); assert.match(check.stdout, /symlink denied/);
    assert.equal((check.stdout.match(/network denied/g) ?? []).length, 2); assert.match(check.stdout, /peer denied/); assert.match(check.stdout, /environment clean/);
    assert.doesNotMatch(check.stdout, /LEAK|ESCAPE|NETWORK/); assert.equal(await readFile(join(outside, 'secret'), 'utf8'), 'fake-private');
    const full = await store.run('two', run('dd if=/dev/zero of=large bs=1048576 count=64')); assert.notEqual(full.code, 0); assert.match(full.stderr, /No space left/);
    const image = await readFile(join(sibling.folder, 'volume.dmg')); assert.ok(image.length <= 34 * 1024 * 1024);
    const deadline = await store.use('two', record => store.execute({ ...record, expiresAt: Date.now() + 800 }, run('sleep 100'))); assert.equal(deadline.reason, 'time limit');
    const output = await store.run('one', run("yes output")); assert.equal(output.reason, 'output limit'); assert.ok(Buffer.byteLength(output.stdout) <= 65_536);
    const binary = await store.run('one', run(python("import os; os.write(1,bytes([255])*60000)"))); assert.equal(binary.reason, 'non-UTF8 output'); assert.ok(Buffer.byteLength(binary.stdout + binary.stderr) <= 65_536);
    const cancelled = new AbortController(); setTimeout(() => cancelled.abort(), 200);
    const stopped = await store.run('one', { ...run('sleep 100'), signal: cancelled.signal }); assert.equal(stopped.reason, 'stopped');
  } finally {
    target.kill('SIGKILL'); await new Promise<void>(resolve => target.once('close', resolve));
    await new Promise<void>(resolve => tcp.close(() => resolve())); await new Promise<void>(resolve => unix.close(() => resolve()));
    await store.remove('one'); await store.remove('two'); await rm(root, { recursive: true, force: true });
  }
});

test('expiry, incomplete creation and retired cleanup recover without following links', { timeout: TEST_HANG_MS * 2 }, async () => {
  if (process.platform !== 'darwin') return;
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workspace-cleanup-')));
  const store = new WorkspaceStore('owned-home', { root: join(root, 'storage') });
  try {
    await store.run('thread', run('echo keep > result'));
    const record = (await store.inspect('thread'))!;
    assert.ok(record.expiresAt > Date.now());
    // Simulate a durable expiry and a crash after retirement, before removal.
    await store.sweep(record.expiresAt + 1); assert.equal(await store.inspect('thread'), null);
    const partial = join(store.directory, '.creating-owned'); await mkdir(partial, { recursive: true, mode: 0o700 }); await writeFile(join(partial, 'partial'), 'interrupted allocation');
    const retired = join(store.directory, '.retired-owned'); await mkdir(retired);
    const outside = join(root, 'keep'); await writeFile(outside, 'keep'); await symlink(outside, join(retired, 'link'));
    const reopened = new WorkspaceStore('owned-home', { root: join(root, 'storage') }); await reopened.sweep();
    assert.equal(await readFile(outside, 'utf8'), 'keep');
    assert.equal(existsSync(store.directory), false, 'empty home namespace is removed');
    await store.run('idle-expiry', run('echo scratch'));
    const expiring = (await store.inspect('idle-expiry'))!;
    expiring.expiresAt = Date.now() + 1000; await store.save(expiring);
    const stopSweep = startWorkspaceSweep('owned-home', 50, store);
    try {
      await pollUntil(async active => { while (active() && (await store.inspect('idle-expiry'))) await new Promise(resolve => setTimeout(resolve, 25)); }, "packages/platform/test/workspace.test.ts:95 polling state");
      assert.equal(await store.inspect('idle-expiry'), null, 'one Host sweep timer removes an idle workspace without another use');
    } finally { await stopSweep(); }
    await store.run('deleted', run('echo scratch')); await store.remove('deleted'); assert.equal(await store.inspect('deleted'), null);
  } finally { await store.remove('thread'); await store.remove('deleted'); await store.remove('idle-expiry'); await rm(root, { recursive: true, force: true }); }
});

test('a killed Host supervisor detaches; a reopened store recovers files and retirement markers', { timeout: TEST_HANG_MS * 2 }, async () => {
  if (process.platform !== 'darwin') return;
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workspace-crash-')));
  const storage = join(root, 'storage'), store = new WorkspaceStore('crash-owner', { root: storage });
  const child = spawn(process.execPath, [new URL('./workspace-crash.ts', import.meta.url).pathname, storage], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  try {
    await new Promise<void>((resolve, reject) => { child.once('message', () => resolve()); child.once('error', reject); child.once('exit', () => reject(new Error('Owned host exited before ready.'))); });
    await new Promise(resolve => setTimeout(resolve, 300)); child.kill('SIGKILL');
    await new Promise<void>(resolve => child.once('close', resolve));
    // The disconnected worker joins its command and unmounts before a later Host uses the image.
    await new Promise(resolve => setTimeout(resolve, 1500));
    const result = await store.run('thread', run('cat result')); assert.equal(result.stdout.trim(), 'durable', JSON.stringify(result));
    const record = (await store.inspect('thread'))!;
    await writeFile(join(record.folder, '.retiring'), '');
    await store.sweep(); assert.equal(await store.inspect('thread'), null);
  } finally { child.kill('SIGKILL'); await store.remove('thread'); await rm(root, { recursive: true, force: true }); }
});
