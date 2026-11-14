import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runHarnessTurn } from '../src/composition/harness-turn.ts';
import { MaterialStore } from '../src/stub/material.ts';
import { offeredHostTools, type HarnessV1 } from '../src/ports/harness.ts';
import type { Turn } from '../src/api.ts';
import { WorkspaceStore } from '../src/workspace/store.ts';
import { workspaceAvailable } from '../src/workspace/policy.ts';
import { LINUX_PROBE_PARENT, assertLinuxWorkspace } from '../src/workspace/linux-policy.ts';
import { WorkspaceRefusal, workspaceFailure } from '../src/workspace/result.ts';
import { workspaceTools } from '../src/composition/workspace-tools.ts';
// Linux now adopts bubblewrap; the former macOS-only offer contract is replaced openly.
for (const [platform, binary, expected] of [['darwin', true, true], ['darwin', false, false], ['linux', true, true], ['linux', false, false], ['win32', true, false]] as const) test(`M4: Host tool list on ${platform}, sandbox runtime=${binary}: workspace offered=${expected}`, async () => {
  const home = await mkdtemp(join(tmpdir(), 'workspace-offer-'));
  const architecture = Object.getOwnPropertyDescriptor(process, 'arch')!, descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!, exists = fs.existsSync, execFile = childProcess.execFile, getuid = process.getuid;
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: platform }); Object.defineProperty(process, 'arch', { ...architecture, value: 'arm64' });
    fs.existsSync = ((path: fs.PathLike) => ['/usr/bin/sandbox-exec', '/usr/bin/bwrap', '/usr/bin/python3', '/usr/bin/unshare'].includes(String(path)) || String(path).endsWith('/libseccomp.so.2') ? binary : exists(path)) as typeof fs.existsSync; syncBuiltinESMExports();
    process.getuid = () => 30_000 + (platform === 'linux' ? (binary ? 1 : 2) : 3);
    childProcess.execFile = ((file: string, args: string[], options: unknown, callback: (error: null, stdout: string) => void) => {
      if (file === '/usr/bin/python3' && args.includes('preflight')) { setImmediate(() => callback(null, JSON.stringify({ code: 0 }))); return {}; }
      return (execFile as Function)(file, args, options, callback);
    }) as unknown as typeof childProcess.execFile; syncBuiltinESMExports();
    if (platform === 'linux') assert.equal(await workspaceAvailable('linux', false), false, 'an explicit availability refusal always narrows the offer');
    const material = new MaterialStore(home, {}, () => {}); let observed = false;
    const harness: HarnessV1 = { specificationVersion: 'v1', id: 'offer-canary', label: 'offer canary', start(_request, context) {
      observed = true; assert.equal(typeof context.tools.runWorkspace === 'function', expected); assert.equal(offeredHostTools(context.tools).includes('workspace_run'), expected);
      return { events: (async function* () {})(), outcome: Promise.resolve({ status: 'done', answer: 'checked', usage: { input: 0, output: 0 } }), stop() {}, steer() {} };
    } };
    const turn: Turn = { id: 'turn', side: false, status: 'running', user: { text: 'Check tools', attachments: [], at: '' }, work: { startedAt: '', harness: 'canary', steps: [] }, effects: [] };
    await runHarnessTurn({ telemetry: { home, runId: 'run' }, material, projectId: 'p', threadId: 'thread', harness, signal: new AbortController().signal, writeDelayMs: 0, gateway: { read: async () => { throw new Error('No read'); }, write: async () => { throw new Error('No write'); } }, route: { kind: 'endpoint', provider: 'openai-compatible', baseUrl: 'http://localhost', model: 'canary', label: 'canary', credential: null }, credential: async () => { throw new Error('No credential'); }, history: [], resumed: false, progress() {} }, turn, []);
    assert.equal(observed, true); assert.equal(turn.status, 'done');
  } finally { Object.defineProperty(process, 'platform', descriptor); Object.defineProperty(process, 'arch', architecture); fs.existsSync = exists; childProcess.execFile = execFile; process.getuid = getuid; syncBuiltinESMExports(); await rm(home, { recursive: true, force: true }); }
});
test('Linux root is refused before creating workspace state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-root-refusal-'));
  const architecture = Object.getOwnPropertyDescriptor(process, 'arch')!, platform = Object.getOwnPropertyDescriptor(process, 'platform')!, getuid = Object.getOwnPropertyDescriptor(process, 'getuid')!;
  const store = new WorkspaceStore('owned-root-fixture', { root: join(root, 'storage') });
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' }); Object.defineProperty(process, 'arch', { ...architecture, value: 'arm64' });
    Object.defineProperty(process, 'getuid', { ...getuid, value: () => 0 });
    assert.equal(await workspaceAvailable(), false);
    await assert.rejects(store.run('thread', { command: 'echo must-not-run', inputs: [] }), /unprivileged/);
    assert.equal(fs.existsSync(join(root, 'storage')), false);
  } finally {
    Object.defineProperty(process, 'platform', platform); Object.defineProperty(process, 'arch', architecture); Object.defineProperty(process, 'getuid', getuid);
    await rm(root, { recursive: true, force: true });
  }
});

test('Linux discovery shares an asynchronous probe and removes its temporary directory', async () => {
  const architecture = Object.getOwnPropertyDescriptor(process, 'arch')!, platform = Object.getOwnPropertyDescriptor(process, 'platform')!, exists = fs.existsSync, execFile = childProcess.execFile, getuid = process.getuid;
  const home = await mkdtemp(join(tmpdir(), 'discovery-home-')), originalTmp = process.env.TMPDIR;
  let calls = 0, probe = '';
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' }); Object.defineProperty(process, 'arch', { ...architecture, value: 'arm64' }); process.getuid = () => 30_100;
    process.env.TMPDIR = home;
    fs.existsSync = ((path: fs.PathLike) => ['/usr/bin/bwrap', '/usr/bin/python3', '/usr/bin/unshare'].includes(String(path)) || String(path).endsWith('/libseccomp.so.2') || exists(path)) as typeof fs.existsSync;
    childProcess.execFile = ((_file: string, args: string[], _options: unknown, callback: (error: null, stdout: string) => void) => {
      calls++; probe = args.at(-1)!; setTimeout(() => callback(null, JSON.stringify({ code: 0 })), 50); return {};
    }) as unknown as typeof childProcess.execFile; syncBuiltinESMExports();
    const first = workspaceAvailable('linux', undefined, home), second = workspaceAvailable('linux', undefined, home);
    let ticked = false; setImmediate(() => { ticked = true; });
    assert.equal(await first, true); assert.equal(await second, true);
    assert.equal(ticked, true, 'discovery must leave the Host event loop available'); assert.equal(calls, 1);
    assert.equal(exists(probe), false, 'the owned probe directory is removed');
    assert.equal(probe.startsWith(home + '/'), false, 'ambient TMPDIR cannot place a probe in the data home');
    assert.equal(await workspaceAvailable('linux', undefined, fs.realpathSync(LINUX_PROBE_PARENT)), false, 'a home containing the probe parent is refused even after a successful cached probe');
  } finally {
    Object.defineProperty(process, 'platform', platform); Object.defineProperty(process, 'arch', architecture); fs.existsSync = exists; childProcess.execFile = execFile; process.getuid = getuid; syncBuiltinESMExports();
    if (originalTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmp;
    await rm(home, { recursive: true, force: true });
  }
});

test('Linux discovery removes its probe after a subprocess timeout and refuses availability', async () => {
  const architecture = Object.getOwnPropertyDescriptor(process, 'arch')!, platform = Object.getOwnPropertyDescriptor(process, 'platform')!, exists = fs.existsSync, execFile = childProcess.execFile, getuid = process.getuid;
  let probe = '';
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' }); Object.defineProperty(process, 'arch', { ...architecture, value: 'arm64' }); process.getuid = () => 30_101;
    fs.existsSync = ((path: fs.PathLike) => ['/usr/bin/bwrap', '/usr/bin/python3', '/usr/bin/unshare'].includes(String(path)) || String(path).endsWith('/libseccomp.so.2') || exists(path)) as typeof fs.existsSync;
    childProcess.execFile = ((_file: string, args: string[], options: { timeout: number; killSignal: string }, callback: (error: Error) => void) => {
      probe = args.at(-1)!; assert.equal(options.timeout, 5000); assert.equal(options.killSignal, 'SIGKILL');
      setImmediate(() => callback(new Error('owned timeout fixture'))); return {};
    }) as unknown as typeof childProcess.execFile; syncBuiltinESMExports();
    assert.equal(await workspaceAvailable(), false);
    assert.equal(exists(probe), false, 'even a timed-out probe leaves no temporary state');
  } finally { Object.defineProperty(process, 'platform', platform); Object.defineProperty(process, 'arch', architecture); fs.existsSync = exists; childProcess.execFile = execFile; process.getuid = getuid; syncBuiltinESMExports(); }
});


for (const unqualified of ['x64', 'riscv64']) test(`Linux ${unqualified} is refused as unqualified before a probe or allocation`, async () => {
  const architecture = Object.getOwnPropertyDescriptor(process, 'arch')!, exists = fs.existsSync, execFile = childProcess.execFile, getuid = process.getuid;
  let probes = 0;
  try {
    Object.defineProperty(process, 'arch', { ...architecture, value: unqualified }); process.getuid = () => 30_200;
    fs.existsSync = (() => true) as typeof fs.existsSync;
    childProcess.execFile = ((_file: string, _args: string[], _options: unknown, callback: (error: null, stdout: string) => void) => {
      probes++; setImmediate(() => callback(null, JSON.stringify({ code: 0 }))); return {};
    }) as unknown as typeof childProcess.execFile; syncBuiltinESMExports();
    assert.equal(await workspaceAvailable('linux'), false);
    await assert.rejects(assertLinuxWorkspace(), /arm64.*unqualified/i);
    assert.equal(probes, 0, 'unqualified hardware must never reach the launch probe');
  } finally {
    Object.defineProperty(process, 'arch', architecture); fs.existsSync = exists; childProcess.execFile = execFile; process.getuid = getuid; syncBuiltinESMExports();
  }
});

test('Linux refuses a data home overlapping cgroup controls before a probe can write there', async () => {
  const architecture = Object.getOwnPropertyDescriptor(process, 'arch')!, realpath = fs.realpathSync, exists = fs.existsSync, execFile = childProcess.execFile, getuid = process.getuid;
  let probes = 0;
  try {
    Object.defineProperty(process, 'arch', { ...architecture, value: 'arm64' }); process.getuid = () => 30_201;
    fs.realpathSync = ((path: fs.PathLike) => String(path).startsWith('/sys') ? String(path) : realpath(path)) as typeof fs.realpathSync;
    fs.existsSync = (() => true) as typeof fs.existsSync;
    childProcess.execFile = ((_file: string, _args: string[], _options: unknown, callback: (error: null, stdout: string) => void) => {
      probes++; setImmediate(() => callback(null, JSON.stringify({ code: 0 }))); return {};
    }) as unknown as typeof childProcess.execFile; syncBuiltinESMExports();
    for (const home of ['/sys', '/sys/fs/cgroup', '/sys/fs/cgroup/owned-fixture']) {
      assert.equal(await workspaceAvailable('linux', undefined, home), false);
      await assert.rejects(assertLinuxWorkspace(home), /data home.*cgroup/i);
    }
    assert.equal(probes, 0);
  } finally {
    Object.defineProperty(process, 'arch', architecture); fs.realpathSync = realpath; fs.existsSync = exists; childProcess.execFile = execFile; process.getuid = getuid; syncBuiltinESMExports();
  }
});

test('Linux preflight rejection retains the certified w6 refusal before any workspace command starts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workspace-typed-linux-refusal-'));
  const architecture = Object.getOwnPropertyDescriptor(process, 'arch')!, platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const material = new MaterialStore(home, {}, () => {}), store = new WorkspaceStore(home);
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    Object.defineProperty(process, 'arch', { ...architecture, value: 'x64' });
    const tools = workspaceTools({ home, threadId: 'thread', projectId: 'p', material, attachments: [],
      signal: new AbortController().signal, alive: () => true, sources: () => [],
      tools: { stillGranted: () => true, read: async () => { throw new Error('No read may run'); } } });
    await assert.rejects(tools.runWorkspace!({ command: 'echo must-not-run' }), error => {
      assert.ok(error instanceof WorkspaceRefusal);
      assert.equal(workspaceFailure(error).phase, 'refused');
      assert.match(error.message, /qualified only on arm64/);
      return true;
    });
    assert.equal(fs.existsSync(store.directory), false, 'refusal must precede scratch allocation');
  } finally {
    Object.defineProperty(process, 'platform', platform); Object.defineProperty(process, 'arch', architecture);
    await rm(home, { recursive: true, force: true });
  }
});
