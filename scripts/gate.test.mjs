import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverPackages, parseCounts, suites } from './gate.mjs';
import { TEST_HANG_MS, hangDetector, waitFor } from './lib/test-hang.ts';
import { observeChild } from './lib/test-child.ts';

const gate = fileURLToPath(new URL('./gate.mjs', import.meta.url));
async function fixture(t, code = "console.log('# pass 2\\n# fail 0')", extraSuites = [], controlledClock = false) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gate-test-'));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'initial']);
  const runner = path.join(os.tmpdir(), `gate-runner-${path.basename(dir)}.mjs`);
  const lock = path.join(os.tmpdir(), `gate-lock-${path.basename(dir)}`);
  const out = path.join(os.tmpdir(), `gate-out-${path.basename(dir)}`);
  if (typeof code === 'function') code = code(out);
  // The real gate keeps its real timers. This fixture advances only the gate process's
  // product clock, after its independently scheduled children have installed their handlers.
  const clock = controlledClock ? `import {mock} from 'node:test';const signals=[];const kill=process.kill;mock.method(process,'kill',function(pid,signal){if(signal==='SIGTERM'||signal==='SIGKILL')signals.push(signal);return kill.call(this,pid,signal);});mock.timers.enable({apis:['Date','setTimeout']});process.on('message',ms=>{mock.timers.tick(ms);process.send({ticked:ms,signals});});` : '';
  await writeFile(runner, `import { main } from ${JSON.stringify(gate)};${clock} main(process.argv.slice(2), [{name:'fake',command:process.execPath,args:['-e',${JSON.stringify(code)}]}, ...${JSON.stringify(extraSuites)}]).then(c=>process.exitCode=c).catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>{${controlledClock ? 'mock.timers.reset();' : ''}if(process.connected)process.disconnect();});`);
  const stops = [];
  t.after(async () => {
    // Join our processes before removing their evidence, including on an assertion failure.
    for (const stop of stops) await stop();
    await Promise.all([rm(dir, { recursive: true, force: true }), rm(runner, { force: true }), rm(lock, { recursive: true, force: true }), rm(`${lock}.control`, { force: true }), rm(out, { recursive: true, force: true })]);
  });
  function run(args = []) {
    const child = spawn(process.execPath, [runner, '--out', out, ...args], { cwd: dir, env: { ...process.env, BACKBONE_HEAVY_LOCK: lock }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const observed = observeChild(child, 'isolated gate');
    let output = ''; child.stdout.on('data', x => { output += x; }); child.stderr.on('data', x => { output += x; });
    const closed = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal, output })));
    const tick = ms => hangDetector(new Promise((resolve, reject) => {
      const detach = () => { child.off('message', advanced); child.off('close', failed); };
      const failed = () => { detach(); reject(observed.diagnostic('exited before clock acknowledgement')); };
      const advanced = message => { detach(); assert.equal(message.ticked, ms); resolve(message.signals); };
      child.once('message', advanced);
      child.once('close', failed);
      child.send(ms, error => { if (error) { detach(); reject(error); } });
    }), 'isolated gate product clock advance', { diagnostic: () => observed.diagnostic('pending clock acknowledgement').message });
    stops.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        if (controlledClock) { await tick(600).catch(() => {}); await tick(5000).catch(() => {}); }
      }
      await hangDetector(closed, 'isolated gate teardown', { diagnostic: () => observed.diagnostic('pending teardown').message });
    });
    const done = hangDetector(closed, 'isolated gate completion', { diagnostic: () => observed.diagnostic('pending suite').message });
    done.catch(() => {}); // Preserve the rejection for the assertion without an orphan rejection during teardown.
    return { child, tick, done };
  }
  return { dir, lock, out, run };
}
async function exists(p) { try { await readFile(p); return true; } catch { return false; } }
test('evidence is readable while a suite is running, then records its completion', async t => {
  const f = await fixture(t, out => `console.log('live stdout');console.error('live stderr');const timer=setInterval(()=>{if(require('fs').existsSync(${JSON.stringify(path.join(out, 'release'))})){clearInterval(timer);console.log('# pass 2\\n# fail 0');}},25);`);
  const run = f.run();
  try {
    await waitFor(async () => (await exists(path.join(f.out, 'fake.log'))) && (await readFile(path.join(f.out, 'fake.log'), 'utf8')).includes('live stderr'), 'running suite emits both streams');
    const started = JSON.parse(await readFile(path.join(f.out, 'gate.json')));
    assert.equal(started.end, null); assert.equal(started.suites[0].status, 'running');
    assert.ok(started.suites[0].start); assert.equal(started.suites[0].end, null);
    assert.match(await readFile(path.join(f.out, 'gate-summary.txt'), 'utf8'), /fake:.*running/);
  } finally { await writeFile(path.join(f.out, 'release'), 'observations complete'); }
  assert.equal((await run.done).code, 0);
  const ended = JSON.parse(await readFile(path.join(f.out, 'gate.json')));
  assert.equal(ended.suites[0].status, 'completed'); assert.ok(ended.suites[0].end);
  assert.equal(ended.suites[0].passed, 2);
});

test('suite timeout records failure, kills a stubborn descendant and continues', { timeout: TEST_HANG_MS * 2 }, async t => {
  const code = `const {spawn}=require('node:child_process'); spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log('descendant ready');setInterval(()=>{},1000)"],{stdio:'inherit'}); console.log('waiting'); setInterval(()=>{},1000)`;
  const f = await fixture(t, code, [{ name: 'next', command: process.execPath, args: ['-e', "console.log('# pass 1\\n# fail 0')"] }], true);
  const run = f.run(['--suite-timeout', '0.01']);
  await waitFor(async () => await exists(path.join(f.out, 'fake.log')) && (await readFile(path.join(f.out, 'fake.log'), 'utf8')).includes('descendant ready'), 'stubborn descendant installs SIGTERM handler');
  assert.deepEqual(await run.tick(599), [], 'no termination before the product deadline');
  assert.equal(JSON.parse(await readFile(path.join(f.out, 'gate.json'))).suites[0].status, 'running');
  assert.deepEqual(await run.tick(1), ['SIGTERM']);
  await waitFor(async () => (await readFile(path.join(f.out, 'fake.log'), 'utf8')).includes('timed out'), 'gate records product deadline');
  assert.deepEqual(await run.tick(4999), ['SIGTERM'], 'no forced kill before the escalation deadline');
  assert.equal(run.child.exitCode, null, 'the stubborn descendant still holds its pipe before escalation');
  assert.deepEqual(await run.tick(1), ['SIGTERM', 'SIGKILL']);
  assert.equal((await run.done).code, 1);
  const record = JSON.parse(await readFile(path.join(f.out, 'gate.json')));
  assert.equal(record.overall, 'failed'); assert.equal(record.suites[0].timedOut, true);
  assert.equal(record.suites[0].status, 'timed out');
  assert.match(await readFile(path.join(f.out, 'fake.log'), 'utf8'), /timed out/);
  assert.match(await readFile(path.join(f.out, 'gate-summary.txt'), 'utf8'), /timed out/);
  assert.equal(record.suites[1].exitCode, 0);
  assert.equal(await exists(path.join(f.lock, 'owner')), false);
});

test('suite timeout rejects invalid limits', async t => {
  const f = await fixture(t);
  for (const value of ['0', '-1', 'NaN']) {
    const result = await f.run(['--suite-timeout', value]).done;
    assert.equal(result.code, 1); assert.match(result.output, /positive number/);
  }
});

test('timeout cannot pass even when a child exits successfully on termination', async t => {
  const f = await fixture(t, "process.on('SIGTERM',()=>{console.log('# pass 2\\n# fail 0');process.exit(0)});console.log('termination handler ready');setInterval(()=>{},1000)", [], true);
  const run = f.run(['--suite-timeout', '0.01']);
  await waitFor(async () => await exists(path.join(f.out, 'fake.log')) && (await readFile(path.join(f.out, 'fake.log'), 'utf8')).includes('termination handler ready'), 'successful termination handler readiness');
  assert.deepEqual(await run.tick(599), [], 'no termination before the product deadline');
  assert.equal(run.child.exitCode, null);
  assert.deepEqual(await run.tick(1), ['SIGTERM']);
  assert.equal((await run.done).code, 1);
  const record = JSON.parse(await readFile(path.join(f.out, 'gate.json')));
  assert.equal(record.suites[0].exitCode, 0);
  assert.equal(record.suites[0].timedOut, true);
  assert.equal(record.overall, 'failed');
});

test('only the existing unimplemented oracle families retain their expected exception', async t => {
  const oracle = "console.log('lifecycle: not implemented\\nscenes: not implemented\\noracle (successor): 271 passed, 0 failed, 2 not implemented');process.exitCode=1";
  const f = await fixture(t, undefined, [{ name: 'oracle', command: process.execPath, args: ['-e', oracle] }]);
  assert.equal((await f.run(['--only', 'oracle']).done).code, 0);
  const record = JSON.parse(await readFile(path.join(f.out, 'gate.json')));
  assert.equal(record.suites[0].exitCode, 1); assert.equal(record.suites[0].expectedOracle, true);
  assert.equal(record.overall, 'passed');
});

test('discovery includes every workspace package with a test script', async () => {
  const root = path.resolve(path.dirname(gate), '..');
  const yaml = await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
  const patterns = [...yaml.matchAll(/^\s+- ["']([^"']+)["']\s*$/gm)].map(match => match[1]);
  const manifests = [path.join(root, 'package.json')];
  for (const pattern of patterns) {
    let dirs = [root];
    for (const part of pattern.split('/')) {
      const next = [];
      for (const dir of dirs) {
        if (part === '*') {
          for (const entry of await readdir(dir, { withFileTypes: true })) if (entry.isDirectory() && entry.name !== 'node_modules') next.push(path.join(dir, entry.name));
        } else next.push(path.join(dir, part));
      }
      dirs = next;
    }
    for (const dir of dirs) {
      try { await readFile(path.join(dir, 'package.json')); manifests.push(path.join(dir, 'package.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  const packages = await Promise.all(manifests.map(async file => JSON.parse(await readFile(file, 'utf8'))));
  const expected = packages.filter(pkg => Object.hasOwn(pkg.scripts ?? {}, 'test')).map(pkg => pkg.name).sort();
  assert.deepEqual(discoverPackages(root).suites.map(suite => suite.args[1]).sort(), expected);
});

test('discovery reports untested packages and honors explicit exclusions', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gate-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
  for (const [name, scripts] of [['a', { test: 'node test' }], ['b', {}], ['c', { test: 'node test' }]]) {
    const dir = path.join(root, 'packages', name); await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: `@example/${name}`, scripts }));
  }
  assert.deepEqual(discoverPackages(root, new Set(['@example/c'])), {
    suites: [{ name: 'a', command: 'pnpm', args: ['--filter', '@example/a', 'test'] }],
    noTest: ['@example/b'], excluded: ['@example/c'],
  });
});

test('parses TAP, Playwright and oracle summaries without inventing ambiguous totals', () => {
  assert.deepEqual(parseCounts('# pass 4\n# fail 1\n'), { passed: 4, failed: 1 });
  assert.deepEqual(parseCounts('  1 failed\n  222 passed (5.5m)\n'), { passed: 222, failed: 1 });
  assert.deepEqual(parseCounts('oracle (successor): 271 passed, 0 failed, 2 not implemented'), { passed: 271, failed: 0, unimplemented: 2 });
  assert.deepEqual(parseCounts('# pass 4\n# fail 0\n# pass 5\n# fail 0\n'), { passed: 'unknown', failed: 'unknown' });
});

test('held lock fails immediately and wait acquires a released lock', async t => {
  const f = await fixture(t, undefined, [], true); await mkdir(f.lock);
  const first = await f.run().done; assert.equal(first.code, 1); assert.match(first.output, /lock is held/);
  const waiting = f.run(['--wait', '0.05']);
  await waitFor(() => exists(`${f.lock}.next`), 'blocked gate publishes its admission marker');
  await rm(f.lock, { recursive: true });
  assert.deepEqual(await waiting.tick(100), []); // Product admission poll, after the owner releases.
  assert.equal((await waiting.done).code, 0);
  assert.equal(await exists(path.join(f.lock, 'owner')), false);
});

test('failure propagates and releases lock', async t => {
  const f = await fixture(t, "console.log('# pass 0\\n# fail 1'); process.exitCode=1");
  assert.equal((await f.run().done).code, 1);
  assert.equal(await exists(path.join(f.lock, 'owner')), false);
  const record = JSON.parse(await readFile(path.join(f.out, 'gate.json')));
  assert.equal(record.suites[0].exitCode, 1); assert.equal(record.overall, 'failed');
});

test('signal stops child and releases lock', async t => {
  const f = await fixture(t, 'setInterval(() => {}, 1000)');
  const run = f.run();
  await waitFor(() => exists(path.join(f.lock, 'owner')), 'isolated gate acquires its own lock');
  assert.equal(await exists(path.join(f.lock, 'owner')), true);
  // Wait for suite startup, rather than assuming the machine reaches it within 150 ms.
  await waitFor(() => exists(path.join(f.out, 'fake.log')), 'isolated gate starts its suite before interruption');
  run.child.kill('SIGTERM');
  assert.equal((await run.done).code, 143);
  const record = JSON.parse(await readFile(path.join(f.out, 'gate.json')));
  assert.equal(record.interrupted, 'SIGTERM'); assert.equal(record.overall, 'failed');
  assert.ok(record.suites[0].end);
  assert.equal(await exists(path.join(f.lock, 'owner')), false);
});

test('dirty tree is refused', async t => {
  const f = await fixture(t); await writeFile(path.join(f.dir, 'untracked'), 'change');
  const result = await f.run().done;
  assert.equal(result.code, 1); assert.match(result.output, /dirty/);
  assert.equal(await exists(path.join(f.lock, 'owner')), false);
});

test('gate includes fresh installed acceptance immediately after app e2e', () => {
  const index = suites.findIndex(suite => suite.name === 'app-e2e');
  assert.ok(index >= 0);
  const installed = suites[index + 1];
  assert.equal(installed.name, 'app-installed');
  assert.equal(installed.command, 'pnpm');
  assert.deepEqual(installed.args, ['--filter', '@backbone-next/app', 'e2e:installed']);
});

test('installed suite writes a fresh commit-bound DMG hash to gate.json', async t => {
  const identity = new URL('../packages/surfaces/app/scripts/build-identity.ts', import.meta.url).href;
  const code = `import {sourceIdentity} from ${JSON.stringify(identity)};
    import {mkdirSync,writeFileSync,existsSync} from 'node:fs'; import {createHash} from 'node:crypto';
    import assert from 'node:assert/strict';
    const at='packages/surfaces/app/dist';
    assert.equal(existsSync(at+'/build.json'),false); assert.equal(existsSync(at+'/package/build.json'),false);
    mkdirSync(at+'/package',{recursive:true});
    const compiled={...sourceIdentity(),id:'gate-build'};
    const info={compiled,sourceChangedAfterBuild:false,dmg:'dist/package/test.dmg',sha256:createHash('sha256').update('fresh').digest('hex')};
    writeFileSync(at+'/build.json',JSON.stringify(compiled)); writeFileSync(at+'/package/test.dmg','fresh');
    writeFileSync(at+'/package/build.json',JSON.stringify(info)); console.log('  1 passed (1s)');`;
  const f = await fixture(t, undefined, [{ name: 'app-installed', command: process.execPath, args: ['--input-type=module', '-e', code] }]);
  await writeFile(path.join(f.dir, '.git/info/exclude'), 'packages/\n');
  const dist = path.join(f.dir, 'packages/surfaces/app/dist');
  await mkdir(path.join(dist, 'package'), { recursive: true });
  for (const file of ['build.json', 'package/build.json']) await writeFile(path.join(dist, file), 'stale');
  assert.equal((await f.run(['--only', 'app-installed']).done).code, 0);
  const record = JSON.parse(await readFile(path.join(f.out, 'gate.json')));
  const installed = record.suites[0];
  assert.equal(installed.packagedApp.commit, record.commit);
  assert.match(installed.packagedApp.sha256, /^[a-f0-9]{64}$/);
  assert.equal(installed.packagedApp.buildId, 'gate-build');
  assert.equal(installed.passed, 1);
});

test('installed timeout includes packaging before test startup', async t => {
  const f = await fixture(t, undefined, [{ name: 'app-installed', command: process.execPath, args: ['-e', "console.log('packaging');setInterval(()=>{},1000)"] }]);
  assert.equal((await f.run(['--only', 'app-installed', '--suite-timeout', '0.01']).done).code, 1);
  const record = JSON.parse(await readFile(path.join(f.out, 'gate.json')));
  assert.equal(record.suites[0].timedOut, true);
  assert.equal(record.overall, 'failed');
  assert.ok(record.suites[0].installedEvidenceError);
});
