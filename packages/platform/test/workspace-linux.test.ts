import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createServer } from 'node:net';
import { workspaceAvailable } from '../src/workspace/policy.ts';
import { LINUX_PROBE_PARENT, assertLinuxWorkspace } from '../src/workspace/linux-policy.ts';
import { WorkspaceStore } from '../src/workspace/store.ts';
import { workspaceProcess } from '../src/workspace/runtime.ts';
import { processIdentity, processOperation } from '../src/workspace/processes.ts';
import { workspaceExecution } from '../src/workspace/result.ts';

async function linuxReady(t: TestContext) {
  if (process.platform !== 'linux') { t.skip('Linux namespaces require a Linux kernel; this host runs ' + process.platform); return false; }
  if (process.arch !== 'arm64') { t.skip('Linux workspace is qualified only on arm64; ' + process.arch + ' is unqualified'); return false; }
  if (process.getuid?.() === 0) { t.skip('Linux workspace requires an unprivileged user'); return false; }
  if (!existsSync('/usr/bin/bwrap') || !existsSync('/usr/bin/python3') || !existsSync('/usr/bin/unshare')) { t.skip('Linux workspace requires bubblewrap, Python 3 and util-linux unshare'); return false; }
  const library = spawnSync('/usr/bin/python3', ['-I', '-S', '-c', "import ctypes; ctypes.CDLL('libseccomp.so.2')"], { encoding: 'utf8' });
  if (library.status !== 0) { t.skip('Linux workspace requires the installed libseccomp.so.2 runtime'); return false; }
  const preflight = spawnSync('/usr/bin/unshare', ['--user', '--map-root-user', '--mount', '--propagation', 'private', '/usr/bin/bwrap', '--unshare-all', '--ro-bind', '/', '/', '--', '/bin/true'], { encoding: 'utf8' });
  if (preflight.status !== 0 && /(?:No permissions to create|Operation not permitted|unprivileged user namespaces|Creating new namespace failed)/i.test(preflight.stderr)) { t.skip('Linux kernel or container refuses user namespaces: ' + preflight.stderr.trim()); return false; }
  assert.equal(preflight.status, 0, preflight.stderr);
  if (!await workspaceAvailable()) {
    try { await assertLinuxWorkspace(); }
    catch (error) {
      if (error instanceof Error && /delegated cgroup/i.test(error.message)) { t.skip(error.message); return false; }
      throw error;
    }
    assert.fail('The Host did not offer a qualified workspace');
  }
  return true;
}

test('Linux workspace confinement runs useful Python and preserves SQLite without exposing the host', { timeout: 120_000 }, async t => {
  if (!await linuxReady(t)) return;
  const root = await mkdtemp(join(tmpdir(), 'linux-workspace-'));
  const store = new WorkspaceStore('owned-linux-home', { root: join(root, 'storage') });
  const outside = join(root, 'private'); await mkdir(outside); await writeFile(join(outside, 'canary'), 'fake-private');
  const tcp = createServer(); await new Promise<void>(resolve => tcp.listen(0, '127.0.0.1', resolve));
  const unix = createServer(), socket = join(root, 'host.sock'); await new Promise<void>(resolve => unix.listen(socket, resolve));
  const run = (command: string) => store.run('thread', { command, inputs: [] });
  try {
    for (const home of ['/usr/lib', '/etc/alternatives']) {
      await assert.rejects(new WorkspaceStore(home, { root: join(root, 'overlap') }).run('thread', { command: 'echo must-not-run', inputs: [] }), /overlaps/);
      assert.equal(existsSync(join(root, 'overlap')), false);
    }
    const first = await store.run('thread', { command: `python3 -c "import csv,sqlite3; c=sqlite3.connect('data.db'); c.execute('create table n(v)'); c.executemany('insert into n values (?)', [(int(r['n']),) for r in csv.DictReader(open('../inputs/source.csv'))]); c.commit(); print(c.execute('select sum(v) from n').fetchone()[0])"`, inputs: [{ name: 'source.csv', bytes: Buffer.from('n\n2\n3\n') }] });
    assert.equal(first.code, 0, JSON.stringify(first)); assert.equal(first.stdout.trim(), '5');
    assert.equal((await run(`python3 -c "import sqlite3; print(sqlite3.connect('data.db').execute('select sum(v)*2 from n').fetchone()[0])"`)).stdout.trim(), '10');
    const port = (tcp.address() as { port: number }).port;
    const check = await run(`python3 - <<'PY'\nimport os,socket,errno\nfor path in [${JSON.stringify(join(outside, 'canary'))}, '/proc/1/root' + ${JSON.stringify(join(outside, 'canary'))}]:\n try: open(path).read(); print('LEAK')\n except OSError: print('private denied')\ntry: os.chmod('..',0o700); open('../outside-work','w').write('bad'); print('PARENT WRITE')\nexcept OSError: print('parent denied')\ntry: open('../inputs/source.csv','w').write('bad'); print('WRITE')\nexcept OSError: print('input denied')\nos.symlink(${JSON.stringify(join(outside, 'canary'))}, 'escape')\ntry: open('escape','w').write('bad'); print('ESCAPE')\nexcept OSError: print('link denied')\nfor family,address in [(socket.AF_INET,('127.0.0.1',${port})),(socket.AF_UNIX,${JSON.stringify(socket)})]:\n try: s=socket.socket(family); s.settimeout(.2); s.connect(address); print('NETWORK')\n except OSError: print('network denied')\nfor family in [socket.AF_UNIX,socket.AF_INET,socket.AF_INET6,getattr(socket,'AF_VSOCK',socket.AF_UNIX)]:\n try: socket.socket(family); print('SOCKET')\n except OSError as e: assert e.errno==errno.EPERM; print('socket denied')\nimport ctypes\nlib=ctypes.CDLL('libseccomp.so.2')\nlibc=ctypes.CDLL(None,use_errno=True)\nfor name,args in [('keyctl',(0,-3,0)),('add_key',(0,0,0,0,0)),('request_key',(0,0,0,0)),('io_uring_setup',(1,0)),('perf_event_open',(0,0,0,0,0)),('ptrace',(0,0,0,0)),('process_vm_readv',(os.getpid(),0,0,0,0,0)),('process_vm_writev',(os.getpid(),0,0,0,0,0)),('pidfd_getfd',(-1,-1,0)),('process_madvise',(-1,0,0,0,0))]:\n nr=lib.seccomp_syscall_resolve_name(name.encode())\n assert nr>=0\n assert libc.syscall(nr,*args)==-1 and ctypes.get_errno()==errno.EPERM, name\nnumber=lib.seccomp_syscall_resolve_name(b'unshare')\nassert libc.syscall(number,ctypes.c_ulong(0x10000000))==-1 and ctypes.get_errno() in (errno.EPERM,errno.ENOSPC), 'nested user namespace was allowed'\nprint('keyring and bypass syscalls denied')\nPY`);
    assert.equal(check.code, 0, JSON.stringify(check)); assert.doesNotMatch(check.stdout, /LEAK|WRITE|ESCAPE|NETWORK|SOCKET/);
    assert.match(check.stdout, /keyring and bypass syscalls denied/); assert.match(check.stdout, /parent denied/); assert.match(check.stdout, /input denied/); assert.match(check.stdout, /link denied/); assert.equal((check.stdout.match(/network denied/g) ?? []).length, 2); assert.equal((check.stdout.match(/socket denied/g) ?? []).length, 4);
    assert.equal(await readFile(join(outside, 'canary'), 'utf8'), 'fake-private');
    const inodes = await store.run('inodes', { command: `python3 - <<'PY'\nimport errno,os\nstatus=open('/proc/self/status').read()\nfor line in status.splitlines():\n if line.startswith(('CapEff:','CapPrm:','CapBnd:','CapAmb:')): assert int(line.split()[1],16)==0, line\nassert 'Seccomp:\t2' in status and 'NoNewPrivs:\t1' in status\ncount=0\ntry:\n for n in range(10000):\n  open(str(n),'w').close(); count+=1\nexcept OSError as e:\n assert e.errno==errno.ENOSPC, e\n print('inode bound',count)\nelse: raise RuntimeError('inode capacity was not enforced')\nPY`, inputs: [] });
    assert.equal(inodes.code, 0, JSON.stringify(inodes)); assert.match(inodes.stdout, /inode bound/);
    await store.remove('inodes');
    const full = await run('dd if=/dev/zero of=large bs=1048576 count=64'); assert.notEqual(full.code, 0); assert.match(full.stderr, /No space left/);
    const stopped = new AbortController(); setTimeout(() => stopped.abort(), 1000);
    const result = await store.run('thread', { command: 'sleep 100', inputs: [], signal: stopped.signal }); assert.equal(result.reason, 'stopped');
    assert.equal((await run('echo reusable')).stdout.trim(), 'reusable');
  } finally { await store.remove('thread'); await store.remove('inodes'); await new Promise<void>(resolve => tcp.close(() => resolve())); await new Promise<void>(resolve => unix.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test('Linux refuses an unavailable namespace before allocation and never runs the command on the host', { timeout: 30_000 }, async t => {
  if (!await linuxReady(t)) return;
  const root = await mkdtemp(join(tmpdir(), 'linux-refusal-'));
  try {
    const probeTmp = join(root, 'probe-tmp'); await mkdir(probeTmp);
    const sourceRoot = new URL('../../../', import.meta.url).pathname;
    const result = spawnSync('/usr/bin/bwrap', ['--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts', '--disable-userns', '--assert-userns-disabled', '--cap-drop', 'ALL', '--ro-bind', '/', '/', '--proc', '/proc', '--bind', probeTmp, LINUX_PROBE_PARENT, '--bind', root, root, '--bind', '/sys/fs/cgroup', '/sys/fs/cgroup',
      '--ro-bind', process.execPath, process.execPath, '--ro-bind', sourceRoot, sourceRoot,
      '--setenv', 'TMPDIR', root, '--', process.execPath, new URL('./workspace-linux-refusal.ts', import.meta.url).pathname, root], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /refused before allocation/);
    assert.equal(existsSync(join(root, 'canary')), false, 'the command never fell back onto the host');
    assert.equal(existsSync(join(root, 'storage')), false, 'refusal precedes workspace state');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Linux refuses missing cgroup delegation before workspace allocation', { timeout: 30_000 }, async t => {
  if (!await linuxReady(t)) return;
  const root = await mkdtemp(join(tmpdir(), 'linux-cgroup-refusal-'));
  try {
    const probeTmp = join(root, 'probe-tmp'); await mkdir(probeTmp);
    const sourceRoot = new URL('../../../', import.meta.url).pathname;
    // Keep user namespaces available, but make the existing cgroup hierarchy read-only.
    const result = spawnSync('/usr/bin/bwrap', ['--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts', '--ro-bind', '/', '/', '--proc', '/proc', '--bind', probeTmp, LINUX_PROBE_PARENT, '--bind', root, root,
      '--ro-bind', process.execPath, process.execPath, '--ro-bind', sourceRoot, sourceRoot,
      '--setenv', 'TMPDIR', root, '--', process.execPath, new URL('./workspace-linux-refusal.ts', import.meta.url).pathname, root, 'cgroup'], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /cgroup refused before allocation/);
    assert.equal(existsSync(join(root, 'storage')), false);
    assert.equal(existsSync(join(root, 'canary')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Linux refuses zero-page and shrinking input capacity without losing the retained workspace', { timeout: 120_000 }, async t => {
  if (!await linuxReady(t)) return;
  const root = await mkdtemp(join(tmpdir(), 'linux-input-capacity-'));
  const store = new WorkspaceStore('owned-capacity', { root });
  try {
    assert.equal((await store.run('thread', { command: 'echo retained > result', inputs: [] })).code, 0);
    const inputs = [10_000_000, 10_000_000, 10_000_000, 3_290_000].map((size, i) => ({ name: `part${i}.bin`, bytes: Buffer.alloc(size) }));
    const refused = await store.run('thread', { command: 'echo overwritten > result', inputs });
    assert.equal(refused.code, null); assert.match(refused.reason ?? '', /capacity.*retained/i);
    assert.equal((await store.run('thread', { command: 'cat result', inputs: [] })).stdout.trim(), 'retained');
    const filled = await store.run('thread', { command: `python3 -c "open('table.bin','wb').write(bytes(4*1024*1024))"`, inputs: [] });
    assert.equal(filled.code, 0, JSON.stringify(filled));
    const shrinking = await store.run('thread', { command: 'rm result table.bin', inputs: inputs.slice(0, 3) });
    assert.equal(shrinking.code, null); assert.match(shrinking.reason ?? '', /capacity.*retained/i);
    const after = await store.run('thread', { command: `cat result; python3 -c "import os; print(os.stat('table.bin').st_size)"`, inputs: [] });
    assert.equal(after.stdout.trim(), 'retained\n4194304'); assert.equal(after.code, 0);
    const links = await store.run('symlink', { command: `python3 -c "import os; open('data','wb').write(bytes(8192)); os.symlink('x'*128,'link')"`, inputs: [] });
    assert.equal(links.code, 0, JSON.stringify(links));
    const narrow = await store.run('symlink', { command: 'rm data link', inputs: [...inputs.slice(0, 3), { name: 'last.bin', bytes: Buffer.alloc(3_284_096) }] });
    assert.match(narrow.reason ?? '', /capacity.*retained/i);
    const linksAfter = await store.run('symlink', { command: `python3 -c "import os; print(os.stat('data').st_size,len(os.readlink('link')))"`, inputs: [] });
    assert.equal(linksAfter.code, 0, JSON.stringify(linksAfter)); assert.equal(linksAfter.stdout.trim(), '8192 128');
  } finally { await store.remove('thread'); await store.remove('symlink'); await rm(root, { recursive: true, force: true }); }
});

test('Linux refuses a real launch after earlier qualification without host execution or checkpoint loss', { timeout: 30_000 }, async t => {
  if (!await linuxReady(t)) return;
  const root = await mkdtemp(join(tmpdir(), 'linux-runtime-refusal-'));
  const store = new WorkspaceStore('owned-refusal', { root: join(root, 'storage') });
  try {
    assert.equal((await store.run('thread', { command: 'echo retained > result', inputs: [] })).code, 0);
    const probeTmp = join(root, 'probe-tmp'); await mkdir(probeTmp);
    const sourceRoot = new URL('../../../', import.meta.url).pathname;
    const result = spawnSync('/usr/bin/bwrap', ['--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts', '--disable-userns', '--assert-userns-disabled', '--cap-drop', 'ALL', '--ro-bind', '/', '/', '--proc', '/proc', '--bind', probeTmp, LINUX_PROBE_PARENT, '--bind', root, root, '--bind', '/sys/fs/cgroup', '/sys/fs/cgroup',
      '--ro-bind', process.execPath, process.execPath, '--ro-bind', sourceRoot, sourceRoot,
      '--setenv', 'TMPDIR', root, '--', process.execPath, new URL('./workspace-linux-refusal.ts', import.meta.url).pathname, root, 'runtime'], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /runtime admission refused; checkpoint retained/);
    assert.equal(existsSync(join(root, 'canary')), false);
    assert.equal((await store.run('thread', { command: 'cat result', inputs: [] })).stdout.trim(), 'retained');
  } finally { await store.remove('thread'); await rm(root, { recursive: true, force: true }); }
});


test('Linux retires changed retained input bytes before derived work can be reused', { timeout: 30_000 }, async t => {
  if (!await linuxReady(t)) return;
  const root = await mkdtemp(join(tmpdir(), 'linux-input-identity-'));
  const store = new WorkspaceStore('owned-input-identity', { root });
  try {
    assert.equal((await store.run('thread', { command: 'echo old-derived > result', inputs: [{ name: 'source.csv', bytes: Buffer.from('old') }] })).code, 0);
    const changed = await store.run('thread', { command: 'echo must-not-run', inputs: [{ name: 'source.csv', bytes: Buffer.from('changed') }] });
    assert.equal(changed.code, null); assert.match(changed.reason ?? '', /retired/);
    const folder = (await store.inspect('thread'))!.folder;
    assert.equal(existsSync(join(folder, '.retiring')), true);
    const after = await store.run('thread', { command: 'test ! -e result && echo fresh', inputs: [] });
    assert.equal(after.code, 0); assert.equal(after.stdout.trim(), 'fresh');
  } finally { await store.remove('thread'); await rm(root, { recursive: true, force: true }); }
});

async function interruption(t: TestContext, target: 'host' | 'bridge') {
  if (!await linuxReady(t)) return;
  const root = await mkdtemp(join(tmpdir(), 'linux-host-death-'));
  const store = new WorkspaceStore('crash-owner', { root });
  const host = spawn(process.execPath, [new URL('./workspace-linux-host.ts', import.meta.url).pathname, root], { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let diagnostics = '';
  host.stderr!.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-2000); });
  let premature: unknown;
  host.on('message', message => { if (message && typeof message === 'object' && 'finished' in message && target === 'host') premature = message; });
  const until = async (check: () => Promise<boolean>) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) { assert.equal(premature, undefined, JSON.stringify(premature)); if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    assert.fail('Linux descendant cleanup did not finish within 15 seconds');
  };
  try {
    await new Promise<void>((resolve, reject) => { host.once('message', () => resolve()); host.once('error', reject); host.once('exit', () => reject(new Error('Owned Linux host exited before ready: ' + diagnostics))); });
    let folder = '', namespacePid = 0, grandchildPid = 0, bridgePid = 0;
    await until(async () => {
      const record = await store.inspect('thread'); if (!record) return false; folder = record.folder;
      try {
        const running = JSON.parse(await readFile(join(folder, '.running'), 'utf8')); bridgePid = running.pid;
        namespacePid = JSON.parse(await readFile(join(folder, `.namespace-${running.token}`), 'utf8')).pid;
        const child = Number(await readFile(`/proc/${namespacePid}/root/workspace/work/ready`, 'utf8'));
        const members = JSON.parse(await processOperation('list', join(folder, `.permit-${running.token}`), join(folder, `.refuse-${running.token}`))) as { pid: number; namespacePid: number }[];
        grandchildPid = members.find(p => p.namespacePid === child)?.pid ?? 0;
        return grandchildPid > 0;
      } catch { return false; }
    });
    if (target === 'bridge') process.kill(bridgePid, 'SIGKILL'); else process.kill(-host.pid!, 'SIGKILL');
    if (target === 'host') await new Promise<void>(resolve => host.once('close', resolve));
    await until(async () => (await processIdentity(namespacePid)) === null && (await processIdentity(grandchildPid)) === null && (target === 'bridge' || !existsSync(join(folder, '.running'))));
    if (target === 'bridge') assert.equal(existsSync(join(folder, '.running')), true, 'recovery must reclaim the dead bridge record');
    const result = await store.run('thread', { command: 'cat result', inputs: [] });
    assert.equal(result.code, 0, JSON.stringify(result)); assert.equal(result.stdout.trim(), 'durable');
    const output = await store.run('thread', { command: 'yes bounded', inputs: [] });
    assert.equal(output.reason, 'output limit'); assert.ok(Buffer.byteLength(output.stdout + output.stderr) <= 65_536);
  } finally {
    if (host.exitCode === null && host.signalCode === null) { try { process.kill(-host.pid!, 'SIGKILL'); } catch { /* gone */ } }
    await store.remove('thread'); await rm(root, { recursive: true, force: true });
  }
}

test('Linux kills detached nondumpable descendants after Host death and recovers the retained workspace', { timeout: 60_000 }, t => interruption(t, 'host'));
test('Linux kills the namespace after bridge death and safely reclaims its running record', { timeout: 60_000 }, t => interruption(t, 'bridge'));

test('Linux enforces inherited hard CPU limits and the workspace wall deadline', { timeout: 60_000 }, async t => {
  if (!await linuxReady(t)) return;
  const root = await mkdtemp(join(tmpdir(), 'linux-limits-'));
  const store = new WorkspaceStore('owned-limits', { root });
  try {
    const cpu = await store.run('cpu', { command: `python3 - <<'PY'\nimport resource\nassert resource.getrlimit(resource.RLIMIT_CPU)==(10,10)\nassert resource.getrlimit(resource.RLIMIT_AS)==(536870912,536870912)\ntry: resource.setrlimit(resource.RLIMIT_CPU,(11,11)); raise RuntimeError('CPU ceiling could be raised')\nexcept (ValueError,OSError): pass\nprint('hard limits retained',flush=True)\nresource.setrlimit(resource.RLIMIT_CPU,(1,1))\nwhile True: pass\nPY`, inputs: [] });
    assert.notEqual(cpu.code, 0); assert.notEqual(cpu.reason, 'time limit'); assert.match(cpu.stdout, /hard limits retained/);
    const wall = await store.use('wall', record => store.execute({ ...record, expiresAt: Date.now() + 1500 }, { command: 'echo admitted; sleep 100', inputs: [] }));
    assert.match(wall.stdout, /admitted/); assert.equal(wall.reason, 'time limit');
  } finally { await store.remove('cpu'); await store.remove('wall'); await rm(root, { recursive: true, force: true }); }
});

// The Linux contract now uses kernel cgroup caps instead of an RSS polling promise.
async function commandCgroup(folder: () => string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (folder()) {
      const { readdir } = await import('node:fs/promises');
      const name = (await readdir(folder())).find(name => name.startsWith('.namespace-'));
      if (name) {
        const record = JSON.parse(await readFile(join(folder(), name), 'utf8')) as { cgroup: string };
        assert.equal(typeof record.cgroup, 'string', 'admission must record the kernel resource group');
        return record.cgroup;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('The command did not publish its resource admission');
}

async function assertCgroupCaps(group: string) {
  for (const [name, value] of [['memory.max', '1073741824'], ['memory.swap.max', '0'], ['memory.oom.group', '1'], ['pids.max', '32']]) {
    assert.equal((await readFile(join(group, name), 'utf8')).trim(), value, name);
  }
}

test('Linux kernel cgroup caps bound all tasks independently of other same-UID processes', { timeout: 60_000 }, async t => {
  if (!await linuxReady(t)) return;
  const root = await mkdtemp(join(tmpdir(), 'linux-pids-cap-'));
  const store = new WorkspaceStore('owned-pids-cap', { root });
  const abort = new AbortController(); let folder = '';
  const running = store.use('thread', record => {
    folder = record.folder;
    return store.execute(record, { signal: abort.signal, inputs: [], command: `python3 - <<'PY'\nimport os,time,errno\nfor n in range(80):\n try: pid=os.fork()\n except OSError as e:\n  assert e.errno==errno.EAGAIN\n  break\n if pid==0: time.sleep(100); os._exit(0)\nelse: raise RuntimeError('task cap was not enforced')\ntime.sleep(100)\nPY` });
  });
  void running.catch(() => {});
  try {
    const group = await commandCgroup(() => folder); await assertCgroupCaps(group);
    const deadline = Date.now() + 10_000;
    while (!/^max [1-9]\d*$/m.test(await readFile(join(group, 'pids.events'), 'utf8'))) {
      assert.ok(Date.now() < deadline, 'the cgroup task controller must reject the fork');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const pids = (await readFile(join(group, 'cgroup.procs'), 'utf8')).trim().split(/\s+/).map(Number);
    assert.ok(pids.length > 1 && pids.length <= 32);
    abort.abort(); assert.equal((await running).reason, 'stopped');
    assert.equal(existsSync(group), false, 'the empty resource group is reclaimed');
    for (const pid of pids) assert.equal(await processIdentity(pid), null);
  } finally { abort.abort(); await running.catch(() => {}); await store.remove('thread'); await rm(root, { recursive: true, force: true }); }
});

test('Linux hard cgroup memory limit kills a nondumpable burst while the Host controller survives', { timeout: 90_000 }, async t => {
  if (!await linuxReady(t)) return;
  const root = await mkdtemp(join(tmpdir(), 'linux-memory-'));
  const store = new WorkspaceStore('owned-memory', { root }); let folder = '';
  const abort = new AbortController();
  const running = store.use('thread', record => {
    folder = record.folder;
    return store.execute(record, { signal: abort.signal, command: `python3 - <<'PY'\nimport os,time,ctypes\ntime.sleep(.5)\nfor n in range(3):\n if os.fork()==0:\n  ctypes.CDLL(None).prctl(4,0,0,0,0)\n  block=bytearray(360*1024*1024)\n  for i in range(0,len(block),4096): block[i]=1\n  time.sleep(100)\n  os._exit(0)\ntime.sleep(100)\nPY`, inputs: [] });
  });
  void running.catch(() => {});
  try {
    const group = await commandCgroup(() => folder); await assertCgroupCaps(group);
    const result = await running;
    assert.match(result.reason ?? '', /hard 1 GiB cgroup memory limit/);
    assert.equal(existsSync(group), false);
    const alive = await store.run('thread', { command: 'echo controller-alive', inputs: [] });
    assert.equal(alive.code, 0, JSON.stringify(alive)); assert.match(alive.stdout, /controller-alive/);
  } finally { abort.abort(); await running.catch(() => {}); await store.remove('thread'); await rm(root, { recursive: true, force: true }); }
});

test('Linux drops a planted fake key before sandbox entry and exposes only sandbox processes', { timeout: 30_000 }, async t => {
  if (!await linuxReady(t)) return;
  const root = await mkdtemp(join(tmpdir(), 'linux-environment-'));
  const { randomUUID } = await import('node:crypto');
  const canary = 'fake-only-' + randomUUID();
  try {
    const source = "import os; assert os.environ.get('SANDBOX_FAKE_API_KEY')\n" + await readFile(workspaceProcess('linux'), 'utf8');
    const hostComm = (await readFile('/proc/self/comm', 'utf8')).trim();
    const result = await new Promise<{ code: number; stdout: string; reason?: string }>((resolve, reject) => {
      const child = spawn('/usr/bin/python3', ['-I', '-S', '-c', source, 'run', root, randomUUID(), String(process.pid)], { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', SANDBOX_FAKE_API_KEY: canary }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject); child.once('close', code => {
        if (code !== 0) reject(new Error('Owned supervisor failed: ' + stderr));
        else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } }
      });
      child.stdin.write(JSON.stringify({ command: `python3 - <<'PY'\nimport os\nassert 'SANDBOX_FAKE_API_KEY' not in os.environ\npids=[p for p in os.listdir('/proc') if p.isdigit()]\nassert len(pids)<=4, pids\nhost='/proc/${process.pid}/comm'\nassert not os.path.exists(host) or open(host).read().strip()!=${JSON.stringify(hostComm)}\nprint('fake key absent; host process absent')\nPY`, inputs: [], expiresAt: Date.now() + 25_000 }) + '\n');
      // Keep the controller pipe open until the supervisor finishes.
      child.stdin.on('error', () => {});
    });
    assert.equal(result.code, 0, JSON.stringify(result)); assert.match(result.stdout, /fake key absent; host process absent/);
    assert.equal(result.stdout.includes(canary), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Linux publishes results and scratch checkpoints when empty cgroup removal is deferred', { timeout: 60_000 }, async t => {
  if (!await linuxReady(t)) return;
  const root = await mkdtemp(join(tmpdir(), 'linux-cgroup-cleanup-'));
  try {
    const deferred: string[] = [];
    const source = await readFile(workspaceProcess('linux'), 'utf8');
    // Change only the trusted test supervisor's cleanup method; admission and kernel caps stay real.
    const definitions = source.slice(0, source.lastIndexOf('\nmode = sys.argv[1]'));
    for (const error of ['OSError(errno.EBUSY, "injected busy cgroup")', 'RuntimeError("injected changed owner")']) {
      const token = randomUUID();
      const injected = `${definitions}\ndef deferred_close(self):\n print('injected cleanup refusal', file=sys.stderr)\n raise ${error}\nCommandCgroup.close = deferred_close\nprint(json.dumps(run(sys.argv[2], sys.argv[3], int(sys.argv[4]))))\n`;
      const result = await new Promise<{ code: number; stdout: string; reason?: string }>((resolve, reject) => {
        const child = spawn('/usr/bin/python3', ['-I', '-S', '-c', injected, 'run', root, token, String(process.pid)], { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('error', reject); child.once('close', code => {
          try {
            assert.match(stderr, /injected cleanup refusal/, 'the failure must actually be injected');
            assert.equal(code, 0, stderr); resolve(JSON.parse(stdout));
          } catch (error) { reject(error); }
        });
        child.stdin.on('error', () => {});
        child.stdin.write(JSON.stringify({ command: 'echo checkpoint-survived > saved.txt; cat saved.txt', inputs: [], expiresAt: Date.now() + 25_000 }) + '\n');
      });
      assert.equal(result.code, 0, JSON.stringify(result)); assert.match(result.stdout, /checkpoint-survived/);
      assert.equal(result.reason, undefined);
      const namespace = JSON.parse(await readFile(join(root, '.namespace-' + token), 'utf8'));
      deferred.push(namespace.cgroup);
      assert.equal(existsSync(namespace.cgroup), true, 'failed cleanup leaves an empty group for recovery');
      const checkpoint = JSON.parse(await readFile(join(root, 'checkpoint.json'), 'utf8'));
      assert.equal(await readFile(join(root, checkpoint.generation, 'work', 'saved.txt'), 'utf8'), 'checkpoint-survived\n');
    }
    // A fresh supervisor reclaims the dead supervisors' empty groups and reads their saved work.
    const resumed = new WorkspaceStore('owned-cgroup-cleanup');
    const result = await resumed.execute({ folder: root, createdAt: Date.now(), expiresAt: Date.now() + 30_000, sources: [] }, { command: 'cat saved.txt', inputs: [] });
    assert.equal(result.code, 0, JSON.stringify(result)); assert.equal(result.stdout.trim(), 'checkpoint-survived');
    for (const group of deferred) assert.equal(existsSync(group), false, 'recovery reclaims the verified dead supervisors’ empty groups');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Linux command results preserve w6 done, failed and unknown classification with retained scratch', { timeout: 60_000 }, async t => {
  if (!await linuxReady(t)) return;
  const root = await mkdtemp(join(tmpdir(), 'linux-workspace-outcomes-'));
  const store = new WorkspaceStore('owned-linux-outcomes', { root });
  try {
    const done = await store.run('thread', { command: 'printf completed', inputs: [] });
    assert.equal(workspaceExecution(JSON.stringify(done)).phase, 'done');
    const failed = await store.run('thread', { command: 'echo retained > phase.txt; exit 125', inputs: [] });
    assert.equal(failed.code, 125);
    assert.equal(workspaceExecution(JSON.stringify(failed)).phase, 'failed');
    const retained = await store.run('thread', { command: 'cat phase.txt', inputs: [] });
    assert.equal(retained.stdout.trim(), 'retained', 'a completed failing command may still change scratch');
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 1500);
    try {
      const stopped = await store.run('thread', { command: 'sleep 100', inputs: [], signal: abort.signal });
      assert.equal(workspaceExecution(JSON.stringify(stopped)).phase, 'unknown', 'stopping does not certify that no command ran');
    } finally { clearTimeout(timer); abort.abort(); }
  } finally { await store.remove('thread'); await rm(root, { recursive: true, force: true }); }
});

test('Linux namespace cleanup confirms a leader that exits during inspection without accepting an unconfirmed live process', { timeout: 30_000 }, async t => {
  if (!await linuxReady(t)) return;
  const source = await readFile(workspaceProcess('linux'), 'utf8');
  const definitions = source.slice(0, source.lastIndexOf('\nmode = sys.argv[1]'));
  const script = `${definitions}
real_namespace, real_kill = namespace, os.kill
for race in ('namespace-exit', 'signal-exit', 'unconfirmed-live'):
 child = subprocess.Popen(['/bin/sleep', '100'])
 record = dict(pid=child.pid, identity=identity(child.pid), namespace='owned-fixture-namespace')
 def raced_namespace(pid, kind='pid'):
  if pid != child.pid:
   return real_namespace(pid, kind)
  if race == 'namespace-exit':
   real_kill(child.pid, signal.SIGKILL)
   child.wait(timeout=5)
   raise FileNotFoundError(errno.ENOENT, 'owned namespace leader exited')
  if race == 'unconfirmed-live':
   raise FileNotFoundError(errno.ENOENT, 'owned inspection unavailable')
  return record['namespace']
 def raced_kill(pid, sig):
  assert pid == child.pid
  real_kill(pid, sig)
  child.wait(timeout=5)
  raise ProcessLookupError(errno.ESRCH, 'owned namespace leader exited')
 namespace, os.kill = raced_namespace, raced_kill
 try:
  if race == 'unconfirmed-live':
   try: stop(record)
   except RuntimeError: pass
   else: raise AssertionError('A live leader was incorrectly confirmed stopped')
   assert child.poll() is None
  else:
   stop(record)
   assert identity(child.pid) is None
 finally:
  namespace, os.kill = real_namespace, real_kill
  if child.poll() is None: child.kill()
  child.wait(timeout=5)
print('owned exit races confirmed; live uncertainty retained')
`;
  const result = spawnSync('/usr/bin/python3', ['-I', '-S', '-c', script], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /owned exit races confirmed; live uncertainty retained/);
});
