import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore, type WorkspaceResult } from '../src/workspace/store.ts';
import { processIdentity } from '../src/workspace/processes.ts';
const stopReason = "stopped: the workspace's programs used more than 1 GiB of memory";
// This base has no scripts/lib/test-hang.ts. Three minutes is only a hang detector:
// allocation, volume setup and host scheduling are not the budget's response-time property.
const HANG_DETECTOR_MS = 180_000;
// One 200 ms poll allowance + the descendant killer's 5 s deadline + 10 s of margin
// for helper startup, scheduling and forced detachment on a loaded qualification machine.
const STOP_COMPLETION_LIMIT_MS = 200 + 5_000 + 10_000;
function stopLatency(result: WorkspaceResult) {
  const trace = result.memoryStop; assert.ok(trace, 'the supervisor must report the memory-stop stages');
  const { detectedAtMs, stoppedAtMs, detachedAtMs } = trace;
  assert.ok(Number.isFinite(detectedAtMs));
  assert.ok(typeof stoppedAtMs === 'number' && Number.isFinite(stoppedAtMs), 'all sandboxed processes were confirmed stopped');
  assert.ok(typeof detachedAtMs === 'number' && Number.isFinite(detachedAtMs), 'the volume was successfully detached');
  assert.ok(detectedAtMs <= stoppedAtMs && stoppedAtMs <= detachedAtMs, 'monotonic supervisor stage order');
  const stoppedMs = stoppedAtMs - detectedAtMs, detachedMs = detachedAtMs - detectedAtMs;
  assert.ok(detachedMs <= STOP_COMPLETION_LIMIT_MS, `budget detection through confirmed stop/detach: ${detachedMs} ms`);
  return `budget detection -> stopped ${stoppedMs.toFixed(1)} ms; -> detached ${detachedMs.toFixed(1)} ms`;
}
const py = (code: string) => `python3 - <<'PY'\n${code}\nPY`;
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workspace-budget-')));
  const store = new WorkspaceStore('owned-budget-test', { root: join(root, 'storage') });
  return { root, store, async close() { await store.remove('thread'); await rm(root, { recursive: true, force: true }); } };
}
// Each allocation is touched. The finite 1.5 GiB ceiling keeps a red test bounded too.
const allocation = `import os,time,ctypes,struct
proc=ctypes.CDLL('/usr/lib/libproc.dylib')
def footprint():
 b=ctypes.create_string_buffer(96)
 assert proc.proc_pid_rusage(os.getpid(),0,b)==0
 return struct.unpack_from('=Q',b,72)[0]
print('started',time.time(),flush=True)
print('pid',os.getpid(),flush=True)
blocks=[]
for i in range(96):
 b=bytearray(16*1024*1024)
 b[::4096]=b'x'*(len(b)//4096)
 blocks.append(b)
 print('footprint',footprint(),flush=True)
 time.sleep(.005)
time.sleep(2)`;

test('memory: a touched Python allocation loop is stopped by the 1 GiB summed footprint budget', { timeout: HANG_DETECTOR_MS }, async t => {
  if (process.platform !== 'darwin') return;
  const f = await fixture();
  try {
    const result = await f.store.run('thread', { command: py(allocation), inputs: [] });
    const returnedAt = Date.now();
    assert.equal(result.reason, stopReason, JSON.stringify(result));
    const started = Number(/started ([\d.]+)/.exec(result.stdout)?.[1]) * 1000;
    const peak = Math.max(...[...result.stdout.matchAll(/footprint (\d+)/g)].map(match => Number(match[1])));
    assert.ok(peak > 1024 ** 3 && peak < 1.7 * 1024 ** 3, `highest observed physical footprint ${peak}`);
    const latency = stopLatency(result);
    const pid = Number(/pid (\d+)/.exec(result.stdout)?.[1]); assert.ok(pid > 1);
    assert.equal(await processIdentity(pid), null);
    t.diagnostic(`${latency}; allocation start through returned/detached ${Math.round(returnedAt - started)} ms (diagnostic only); highest observed footprint ${peak} bytes (${(peak / 1024 ** 2).toFixed(1)} MiB)`);
    assert.equal((await f.store.run('thread', { command: 'echo reusable', inputs: [] })).stdout.trim(), 'reusable');
  } finally { await f.close(); }
});

test('memory: two setsid children below 1 GiB each exceed the summed budget and are both stopped', { timeout: TEST_HANG_MS * 2 }, async t => {
  if (process.platform !== 'darwin') return;
  const f = await fixture();
  try {
    const result = await f.store.run('thread', { command: py(`import os,time
for n in range(2):
 if os.fork()==0:
  os.setsid()
  print('child',os.getpid(),flush=True)
  blocks=[]
  for i in range(36):
   b=bytearray(16*1024*1024); b[::4096]=b'x'*(len(b)//4096); blocks.append(b); time.sleep(.005)
  print('child allocated',len(blocks)*16,flush=True)
  time.sleep(3); os._exit(0)
time.sleep(4)`), inputs: [] });
    assert.equal(result.reason, stopReason, JSON.stringify(result));
    t.diagnostic(stopLatency(result));
    const pids = [...result.stdout.matchAll(/child (\d+)/g)].map(match => Number(match[1]));
    assert.equal(pids.length, 2, result.stdout);
    for (const pid of pids) assert.equal(await processIdentity(pid), null);
  } finally { await f.close(); }
});

test('sweep: a throwing first folder is reported and later expired workspaces are still retired', { timeout: TEST_HANG_MS * 2 }, async t => {
  if (process.platform !== 'darwin') return;
  const f = await fixture(), badName = '0'.repeat(64); let bad = '';
  try {
    await f.store.run('thread', { command: 'echo expired', inputs: [] });
    const good = (await f.store.inspect('thread'))!;
    good.expiresAt = Date.now() - 1; good.createdAt = good.expiresAt - 1000; await f.store.save(good);
    bad = join(f.store.directory, badName); await symlink(f.root, bad);
    const messages: string[] = [];
    t.mock.method(process.stderr, 'write', (message: string) => { messages.push(String(message)); return true; });
    await f.store.sweep();
    assert.equal(await f.store.inspect('thread'), null);
    assert.equal(existsSync(bad), true, 'replaced folder stays pending rather than following its link');
    assert.match(messages.join(''), /Cleanup remains pending/);
    assert.ok(messages.some(message => message.includes(badName) && message.includes('Replaced workspace')));
  } finally { if (bad) await unlink(bad); await f.close(); }
});

test('sweep: a failed retired-folder cleanup is reported without blocking later workspaces', { timeout: TEST_HANG_MS * 2 }, async t => {
  if (process.platform !== 'darwin') return;
  const f = await fixture();
  try {
    await f.store.run('thread', { command: 'echo expired', inputs: [] });
    const good = (await f.store.inspect('thread'))!;
    good.expiresAt = Date.now() - 1; good.createdAt = good.expiresAt - 1000; await f.store.save(good);
    const badName = '.retired-unreadable'; await writeFile(join(f.store.directory, badName), 'not a directory');
    const messages: string[] = [];
    t.mock.method(process.stderr, 'write', (message: string) => { messages.push(String(message)); return true; });
    await f.store.sweep();
    assert.equal(await f.store.inspect('thread'), null);
    assert.equal(existsSync(join(f.store.directory, badName)), true);
    assert.ok(messages.some(message => message.includes(badName) && message.includes('Cleanup remains pending')));
  } finally { await f.close(); }
});
