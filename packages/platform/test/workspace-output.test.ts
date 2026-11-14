import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { hangDetector, TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
import { WorkspaceStore, type WorkspaceResult } from '../src/workspace/store.ts';
import { systemEnvironment } from '../src/workspace/volume.ts';
import { workspaceExecution } from '../src/workspace/result.ts';

test('workspace joins output EOF after command exit and descendant cleanup, before returning its result', { timeout: TEST_HANG_MS }, async () => {
  if (process.platform !== 'darwin') return;
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workspace-output-eof-')));
  const store = new WorkspaceStore('owned-output-eof-test', { root: join(root, 'storage') });
  let worker: ReturnType<typeof spawn> | undefined;
  let closed: Promise<void> | undefined;
  try {
    await store.run('thread', { command: 'echo prepared', inputs: [] });
    const record = (await store.inspect('thread'))!;
    // Simulate delayed pipe delivery in the trusted supervisor, outside the sandbox. Release
    // on its descendant-cleanup event, not after a sleep. No product environment seam is added.
    const preload = join(root, 'hold-output.mjs');
    await writeFile(preload, `import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const spawn = cp.spawn, execFile = cp.execFile;
let release;
cp.spawn = function(command, ...args) {
  const child = spawn.call(this, command, ...args);
  if (command === '/usr/bin/sandbox-exec') {
    const held = child.stdout, resume = held.resume; held.pause();
    // Node itself resumes child stdout on exit. Hold that flush too until the event barrier.
    held.resume = () => held;
    release = () => { held.resume = resume; held.resume(); };
  }
  return child;
};
cp.execFile = function(command, args, ...rest) {
  if (args?.includes('stop')) process.send({ trace: 'cleanup-started' });
  return execFile.call(this, command, args, ...rest);
};
process.on('message', message => { if (message.releaseOutput) release?.(); });
syncBuiltinESMExports();\n`);
    worker = spawn(process.execPath, ['--import', pathToFileURL(preload).href, new URL('../src/workspace/worker.ts', import.meta.url).pathname, record.folder], { detached: true, env: systemEnvironment, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const child = worker;
    let result: WorkspaceResult | undefined, cleanupStarted = false, errors = '';
    child.stderr!.on('data', bytes => { errors += bytes.toString(); });
    closed = new Promise<void>((resolve, reject) => {
      child.on('message', message => {
        if ((message as { trace?: string }).trace === 'cleanup-started') { cleanupStarted = true; child.send({ releaseOutput: true }); }
        else result = message as WorkspaceResult;
      });
      child.once('error', reject);
      child.once('close', resolve);
    });
    child.send({ command: "python3 - <<'PY'\nprint(46)\nPY", inputs: [], expiresAt: record.expiresAt });
    await hangDetector(closed, 'supervisor output EOF and close', { diagnostic: () => JSON.stringify({ cleanupStarted, result, errors }) });
    assert.ok(cleanupStarted, 'output is held until descendant cleanup, independently of elapsed time');
    assert.ok(result, errors); assert.equal(result.code, 0, JSON.stringify(result)); assert.equal(result.reason, undefined, JSON.stringify(result));
    assert.equal(result.stdout, '46\n', JSON.stringify(result)); assert.equal(result.stderr, '');
  } finally {
    if (worker && worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
    await closed?.catch(() => {});
    await store.remove('thread'); await rm(root, { recursive: true, force: true });
  }
});

test('workspace cleanup failure reports its fixed stage without exposing the OS error and retires scratch', { timeout: TEST_HANG_MS }, async () => {
  if (process.platform !== 'darwin') return;
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workspace-cleanup-stage-')));
  const store = new WorkspaceStore('owned-cleanup-stage-test', { root: join(root, 'storage') });
  let worker: ReturnType<typeof spawn> | undefined;
  let closed: Promise<void> | undefined;
  try {
    const prepared = await store.run('thread', { command: 'printf retained > marker', inputs: [] });
    const preparation = JSON.stringify({ code: prepared.code, refused: prepared.refused, cleanupStage: prepared.cleanupStage, reasonPresent: !!prepared.reason });
    assert.equal(prepared.code, 0, preparation);
    assert.equal(prepared.reason, undefined, preparation);
    const record = (await store.inspect('thread'))!;
    const preload = join(root, 'fail-detach.mjs');
    // Fault the first OS call in detach after a real sandboxed command. Unlike the
    // conditional hdiutil detach call, the info query always runs when detach is reached.
    // Do not add a product fault switch.
    await writeFile(preload, `import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const execFile = cp.execFile;
cp.execFile = function(command, args, ...rest) {
  if (command === '/usr/bin/hdiutil' && args?.[0] === 'info' && args?.[1] === '-plist') {
    const callback = rest.at(-1);
    process.send({ trace: 'detach-injected' });
    queueMicrotask(() => callback(new Error('private-secret ${root}/private-file'), '', ''));
    return {};
  }
  return execFile.call(this, command, args, ...rest);
};
syncBuiltinESMExports();\n`);
    worker = spawn(process.execPath, ['--import', pathToFileURL(preload).href, new URL('../src/workspace/worker.ts', import.meta.url).pathname, record.folder], { detached: true, env: systemEnvironment, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const child = worker;
    let result: WorkspaceResult | undefined, injected = false, errors = '';
    child.stderr!.on('data', bytes => { errors += bytes.toString(); });
    closed = new Promise<void>((resolve, reject) => {
      child.on('message', message => {
        if ((message as { trace?: string }).trace === 'detach-injected') injected = true;
        else result = message as WorkspaceResult;
      });
      child.once('error', reject); child.once('close', resolve);
    });
    child.send({ command: 'printf safe', inputs: [], expiresAt: record.expiresAt });
    await hangDetector(closed, 'supervisor cleanup failure and close', { diagnostic: () => JSON.stringify({ injected, code: result?.code, refused: result?.refused, cleanupStage: result?.cleanupStage, reasonPresent: !!result?.reason, stderrPresent: !!errors }) });
    const diagnostic = JSON.stringify({ code: result?.code, refused: result?.refused, cleanupStage: result?.cleanupStage, reasonPresent: !!result?.reason, stderrPresent: !!errors });
    assert.ok(injected, `the real detach operation was intercepted: ${diagnostic}`);
    assert.ok(result, `worker returned no result: ${diagnostic}`);
    assert.equal(result.code, 0, diagnostic);
    assert.equal(result.stdout, 'safe');
    assert.equal(result.cleanupStage, 'detach');
    assert.equal(result.reason, 'workspace cleanup unconfirmed; scratch cannot be reused');
    assert.equal(workspaceExecution(JSON.stringify(result)).phase, 'unknown');
    assert.doesNotMatch(JSON.stringify(result), /private-secret|private-file|workspace-cleanup-stage-/);
    assert.ok(await stat(join(record.folder, '.retiring')), 'unconfirmed cleanup retires scratch');
    const next = await store.run('thread', { command: 'test ! -e marker && printf fresh', inputs: [] });
    assert.equal(next.stdout, 'fresh'); assert.equal(next.reason, undefined);
  } finally {
    if (worker && worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
    await closed?.catch(() => {});
    await store.remove('thread'); await rm(root, { recursive: true, force: true });
  }
});
