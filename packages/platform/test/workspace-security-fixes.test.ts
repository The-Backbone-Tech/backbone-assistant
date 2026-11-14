import { TEST_HANG_MS, waitFor } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, readFile, writeFile, rm, readdir, symlink, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshHome } from './helpers.ts';
import { test } from 'node:test';
import { WorkspaceStore } from '../src/workspace/store.ts';
import { processIdentity, processOperation } from '../src/workspace/processes.ts';
import { system } from '../src/workspace/volume.ts';
import { startWorkspaceSweep } from '../src/composition/workspace-lifecycle.ts';
const py = (code: string) => `python3 - <<'PY'\n${code}\nPY`;
const command = (text: string) => ({ command: text, inputs: [] });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workspace-review-fixes-')));
  const store = new WorkspaceStore('owned-security-test', { root: join(root, 'storage') });
  return { root, store, async close() { for (const id of ['thread', 'other']) await store.remove(id); await rm(root, { recursive: true, force: true }); } };
}
async function until(check: () => Promise<boolean>, ms = TEST_HANG_MS) {
  // The explicit post-kill 30 s native criterion stays below; other waits only detect hangs.
  await waitFor(check, 'workspace process and mount lifecycle condition', { hangMs: ms, intervalMs: 50 });
}

test('M2: setsid double-fork with cleared environment is killed before return; nested sandbox cannot erase its policy label', { timeout: TEST_HANG_MS * 2 }, async () => {
  if (process.platform !== 'darwin') return;
  const f = await fixture();
  try {
    const result = await f.store.run('thread', command(py(`import os,time,ctypes\nif os.fork()==0:\n os.setsid()\n if os.fork(): os._exit(0)\n os.environ.clear()\n print('survivor',os.getpid(),flush=True)\n libc=ctypes.CDLL('/usr/lib/libsandbox.dylib')\n print('nested',libc.sandbox_init(b'(version 1)(allow default)',0,None),flush=True)\n time.sleep(100)\nelse:\n time.sleep(.3)`)));
    assert.equal(result.code, 0, JSON.stringify(result)); assert.equal(result.reason, undefined);
    const pid = Number(/survivor (\d+)/.exec(result.stdout)?.[1]); assert.ok(pid > 1, result.stdout);
    assert.match(result.stdout, /nested -1/); assert.equal(await processIdentity(pid), null, 'the reparented process cannot execute after return');
  } finally { await f.close(); }
});

test('M2: modest fork loop hits the inherited hard process ceiling and every child is stopped', { timeout: TEST_HANG_MS * 2 }, async () => {
  if (process.platform !== 'darwin') return;
  const f = await fixture();
  try {
    const result = await f.store.run('thread', command(py(`import os,time,resource\npids=[]\nfor i in range(80):\n try: pid=os.fork()\n except OSError as e:\n  print('fork refused',e.errno,flush=True); break\n if pid==0:\n  os.setsid(); time.sleep(100); os._exit(0)\n pids.append(pid)\nprint('children',','.join(map(str,pids)),flush=True)\nprint('cpu',resource.getrlimit(resource.RLIMIT_CPU),flush=True)`)));
    assert.equal(result.code, 0, JSON.stringify(result)); assert.match(result.stdout, /fork refused/); assert.match(result.stdout, /cpu \(10, 10\)/);
    const pids = /children ([\d,]+)/.exec(result.stdout)?.[1].split(',').map(Number) ?? [];
    assert.ok(pids.length > 0 && pids.length < 80, result.stdout);
    for (const pid of pids) assert.equal(await processIdentity(pid), null, `fork child ${pid} still lives`);
  } finally { await f.close(); }
});

test('M2: supervisor CPU check stops ignored SIGXCPU; macOS reports its AS/RSS limit rejection with a modest allocation', { timeout: TEST_HANG_MS * 2 }, async () => {
  if (process.platform !== 'darwin') return;
  const f = await fixture();
  try {
    const memory = await f.store.run('thread', command(py(`import resource,errno\nprint('memory unlimited',resource.getrlimit(resource.RLIMIT_AS)==(resource.RLIM_INFINITY,)*2,resource.getrlimit(resource.RLIMIT_RSS)==(resource.RLIM_INFINITY,)*2,flush=True)\ntry:\n resource.setrlimit(resource.RLIMIT_AS,(8*1024*1024,8*1024*1024))\nexcept (ValueError,OSError) as e:\n print('memory limit rejected',str(e),flush=True)\nx=bytearray(64*1024*1024)\nprint('allocated',len(x),flush=True)\ntry:\n resource.setrlimit(resource.RLIMIT_CPU,(11,11))\nexcept (ValueError,OSError): print('cpu hard ceiling',flush=True)`)));
    assert.equal(memory.code, 0, JSON.stringify(memory)); assert.match(memory.stdout, /memory unlimited True True/); assert.match(memory.stdout, /memory limit rejected/); assert.match(memory.stdout, /allocated 67108864/); assert.match(memory.stdout, /cpu hard ceiling/);
    const signaled = await f.store.run('thread', command(py('import resource\nresource.setrlimit(resource.RLIMIT_CPU,(1,1))\nwhile True: pass')));
    assert.ok(signaled.code === 152 || signaled.code === 137 || /SIGXCPU|SIGKILL/.test(signaled.reason ?? ''), JSON.stringify(signaled));
    const busy = await f.store.run('thread', command(py('import signal\nsignal.signal(signal.SIGXCPU, signal.SIG_IGN)\nwhile True: pass')));
    assert.equal(busy.reason, 'CPU time limit', JSON.stringify(busy));
  } finally { await f.close(); }
});

test('M3: killing the Host process group leaves its detached supervisor to stop descendants and detach within 30 seconds', { timeout: TEST_HANG_MS * 2 }, async () => {
  if (process.platform !== 'darwin') return;
  const home = freshHome(), store = new WorkspaceStore(home); let threadId = '';
  const host = spawn(process.execPath, [new URL('./workspace-group-host.ts', import.meta.url).pathname, home], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    await new Promise<void>((resolve, reject) => { host.once('message', message => { threadId = (message as { threadId: string }).threadId; resolve(); }); host.once('error', reject); host.once('exit', () => reject(new Error('Host exited before reserving the workspace turn.'))); });
    let folder = '', token = '', pids: { pid: number }[] = [];
    await until(async () => {
      const record = await store.inspect(threadId); if (!record) return false; folder = await realpath(record.folder);
      try {
        const current = JSON.parse(await readFile(join(folder, '.running'), 'utf8')); token = current.token;
        pids = JSON.parse(await processOperation('list', join(folder, `.permit-${token}`), join(folder, `.refuse-${token}`)));
        if (!pids.length) return false;
        const names = await system('/bin/ps', ['-p', pids.map(p => p.pid).join(','), '-o', 'comm=']);
        return /(?:^|[\/\s])sleep$/m.test(names); // Actual engine code has reached its long-running command.
      } catch { return false; }
    });
    const killedAt = Date.now(); process.kill(-host.pid!, 'SIGKILL');
    await new Promise<void>(resolve => host.once('close', resolve));
    await until(async () => {
      const alive = await Promise.all(pids.map(p => processIdentity(p.pid)));
      const mounts = await system('/usr/bin/hdiutil', ['info', '-plist']);
      return alive.every(p => p === null) && !mounts.includes(folder + '/mount-') && !existsSync(join(folder, '.running'));
    }, 30_000);
    assert.ok(Date.now() - killedAt < 30_000);
    assert.equal((await store.run(threadId, command('cat result'))).stdout.trim(), 'durable');
  } finally { if (host.exitCode === null && host.signalCode === null) { try { process.kill(-host.pid!, 'SIGKILL'); } catch { /* gone */ } } if (threadId) await store.remove(threadId); }
});

test('L2/L3/L4: corrupt records retire independently, empty homes disappear, reused pids do not block or get killed', { timeout: TEST_HANG_MS * 2 }, async () => {
  if (process.platform !== 'darwin') return;
  const f = await fixture();
  try {
    await f.store.run('thread', command('echo kept > result')); await f.store.run('other', command('echo other'));
    const bad = (await f.store.inspect('other'))!; await writeFile(join(bad.folder, 'record.json'), '{broken');
    await f.store.sweep(); assert.equal(await f.store.inspect('other'), null);
    const good = (await f.store.inspect('thread'))!;
    await writeFile(join(good.folder, '.running'), JSON.stringify({ pid: process.pid, uid: process.getuid!(), start: '1:1', token: '00000000-0000-4000-8000-000000000000', deadline: Date.now() + 30000 }));
    await f.store.sweep(); assert.equal(existsSync(join(good.folder, '.running')), false, 'open-time sweep recovers a stale reused pid');
    assert.equal((await f.store.run('thread', command('cat result'))).stdout.trim(), 'kept');
    assert.ok(await processIdentity(process.pid), 'pid reuse never kills the unrelated replacement');
    await f.store.remove('thread'); assert.equal(existsSync(f.store.directory), false);
  } finally { await f.close(); }
});

test('L4: a competing worker that loses .running admission never detaches the winner', { timeout: TEST_HANG_MS * 2 }, async () => {
  if (process.platform !== 'darwin') return;
  const f = await fixture();
  try {
    await f.store.run('thread', command('echo ready'));
    const record = (await f.store.inspect('thread'))!;
    const results = await Promise.all([f.store.execute(record, command('sleep .5; echo winner')), f.store.execute(record, command('sleep .5; echo winner'))]);
    assert.equal(results.filter(result => result.code === 0 && result.stdout.trim() === 'winner').length, 1, JSON.stringify(results));
    assert.equal(results.filter(result => result.code === null).length, 1);
    assert.equal((await f.store.run('thread', command('echo still-usable'))).stdout.trim(), 'still-usable');
  } finally { await f.close(); }
});

test('L1/L4: the live home owner starts the sweep; a competing Host owner is refused without touching its workspace', { timeout: TEST_HANG_MS * 2 }, async () => {
  if (process.platform !== 'darwin') return;
  const { ownHome } = await import('../src/composition/home-owner.ts');
  const home = await realpath(await mkdtemp(join(tmpdir(), 'workspace-live-owner-')));
  const alias = home + '-alias'; await symlink(home, alias);
  const store = new WorkspaceStore(alias);
  await store.run('thread', command('echo expired'));
  const expired = (await store.inspect('thread'))!; expired.expiresAt = Date.now() - 1; expired.createdAt = expired.expiresAt - 86400000; await store.save(expired);
  const release = await ownHome(alias);
  try {
    await until(async () => !existsSync(store.directory)); // Open-time sweep must use this Host's ToolHost namespace.
    await store.run('thread', command('echo owned > result'));
    await assert.rejects(ownHome(home), /another host|in use/i);
    await assert.rejects(ownHome(alias), /another host|in use/i);
    assert.equal((await store.run('thread', command('cat result'))).stdout.trim(), 'owned');
  } finally { await store.remove('thread'); await release(); await unlink(alias); await rm(home, { recursive: true, force: true }); }
});
