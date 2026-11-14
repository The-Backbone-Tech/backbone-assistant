import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { takeLock, releaseLock, setTrial, countSegments } from './heavy-slots.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import native from 'fs-native-extensions';
import { observeChild } from './lib/test-child.ts';
import { hangDetector } from './lib/test-hang.ts';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'heavy-slots-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lock = join(root, '.heavy.lock'), unit = `${lock}.b`;
  const owner = (token, role) => ({ pid: process.pid, token, role });
  const take = (token, role, segments = () => 0) => takeLock(lock, owner(token, role), 0, undefined, { segments });
  return { root, lock, unit, owner, take };
}

test('units use the reference B directory without taking A or consulting the obsolete switch', async t => {
  const f = fixture(t); writeFileSync(`${f.lock}.trial.json`, '{"enabled":false}');
  await f.take('unit', 'unit');
  assert.equal(existsSync(f.unit), true); assert.equal(existsSync(f.lock), false);
  assert.equal(readFileSync(join(f.unit, 'owner'), 'utf8').includes('unit'), true);
  assert.throws(() => mkdirSync(f.unit), { code: 'EEXIST' });
  await releaseLock(f.lock, 'wrong'); assert.equal(existsSync(f.unit), true);
  await releaseLock(f.lock, 'unit'); assert.equal(existsSync(f.unit), false);
});

test('A and B coexist and units ignore the integrator priority marker', async t => {
  const f = fixture(t);
  await f.take('gate', 'gate');
  assert.equal(existsSync(join(f.root, '.heavy.next')), true);
  await f.take('unit', 'unit');
  assert.equal(existsSync(join(f.lock, 'owner')), true);
  assert.equal(existsSync(join(f.unit, 'owner')), true);
  await releaseLock(f.lock, 'unit'); assert.equal(existsSync(f.lock), true);
  await releaseLock(f.lock, 'gate'); assert.equal(existsSync(join(f.root, '.heavy.next')), false);
});

test('gates wait for legacy A and preserve a priority marker they do not own', async t => {
  const f = fixture(t), next = join(f.root, '.heavy.next');
  writeFileSync(next, 'integrator queued'); mkdirSync(f.lock);
  await assert.rejects(f.take('gate', 'gate'), /held/);
  await f.take('unit', 'unit'); await releaseLock(f.lock, 'unit');
  rmSync(f.lock, { recursive: true });
  await f.take('gate', 'gate'); await releaseLock(f.lock, 'gate');
  assert.equal(readFileSync(next, 'utf8'), 'integrator queued');
});

test('B admits below 24 segments and refuses capacity exhaustion or unknown inspection', async t => {
  const f = fixture(t);
  await assert.rejects(f.take('full', 'unit', () => 24), /held/);
  assert.equal(existsSync(f.unit), false);
  await assert.rejects(f.take('unknown', 'unit', () => { throw new Error('ipcs unavailable'); }), /ipcs/);
  await assert.rejects(f.take('invalid', 'unit', () => NaN), /segment/i);
  await f.take('unit', 'unit', () => 23);
  await assert.rejects(f.take('other', 'unit'), /held/);
  await releaseLock(f.lock, 'unit');
  let samples = 0;
  await assert.rejects(f.take('rising', 'unit', () => samples++ ? 24 : 23), /held/);
  assert.equal(existsSync(f.unit), false);
});

test('trial off drains B and reserves its directory against old wrappers until trial on', async t => {
  const f = fixture(t); await f.take('running', 'unit');
  const off = setTrial(f.lock, false, 'load-attributed gate failure overlapping B');
  await assert.rejects(f.take('new', 'unit'), /disabled/);
  assert.equal(JSON.parse(readFileSync(join(f.unit, 'owner'))).token, 'running');
  await releaseLock(f.lock, 'running'); await off;
  assert.throws(() => mkdirSync(f.unit), { code: 'EEXIST' });
  await assert.rejects(f.take('new', 'unit'), /disabled/);
  await f.take('gate', 'gate'); await releaseLock(f.lock, 'gate');
  await setTrial(f.lock, true);
  await f.take('new', 'unit'); await releaseLock(f.lock, 'new');
});

test('a dead wrapper is not proof that its test descendants ended', async t => {
  const f = fixture(t);
  await takeLock(f.lock, { ...f.owner('unknown', 'unit'), pid: 2147483647 }, 0, undefined, { segments: () => 0 });
  await assert.rejects(f.take('next', 'unit'), /held/);
  await f.take('gate', 'gate'); await releaseLock(f.lock, 'gate');
  await releaseLock(f.lock, 'unknown');
});

test('trial rollback is serialized with an in-flight admission decision', async t => {
  const f = fixture(t), controller = openSync(`${f.lock}.control`, 'a+', 0o600);
  assert.equal(native.tryLock(controller), true);
  const module = fileURLToPath(new URL('./heavy-slots.mjs', import.meta.url)), done = join(f.root, 'rolled-back');
  const code = `import {setTrial} from ${JSON.stringify(module)};import {writeFileSync} from 'node:fs';console.log('ready');await setTrial(${JSON.stringify(f.lock)},false);writeFileSync(${JSON.stringify(done)},'done');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  const ended = new Promise(resolve => child.once('close', resolve));
  try {
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => reject(new Error(`child ended ${code}`))); });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(existsSync(done), false, 'configuration must not overtake the admission controller');
  } finally { closeSync(controller); await ended; }
  assert.equal(existsSync(done), true);
  await assert.rejects(f.take('unit', 'unit'), /disabled/);
});

test('separate processes use the two reference directories and exclude duplicate holders', async t => {
  const f = fixture(t), module = fileURLToPath(new URL('./heavy-slots.mjs', import.meta.url));
  // Readiness includes the signal handler. Keep the child alive until release and its ACK finish.
  const code = `import {takeLock,releaseLock} from ${JSON.stringify(module)};
    await takeLock(${JSON.stringify(f.lock)},{pid:process.pid,token:'child',role:'gate'},0);
    const timer=setInterval(()=>{},1000);
    process.once('SIGTERM',async()=>{
      try{await releaseLock(${JSON.stringify(f.lock)},'child');process.stdout.write('released\\n',()=>clearInterval(timer));}
      catch(error){console.error(error);process.exitCode=1;clearInterval(timer);}
    });
    console.log('held');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  const output = observeChild(child, 'separate heavy-slot holder');
  const ended = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  try {
    await output.waitForOutput(/^held\r?$/m);
    await f.take('parent', 'unit');
    for (const path of [f.lock, f.unit]) assert.throws(() => mkdirSync(path), { code: 'EEXIST' });
    await assert.rejects(f.take('third', 'unit'), /held/);
    await assert.rejects(f.take('gate2', 'gate'), /held/);
  } finally {
    const diagnostic = () => output.diagnostic('pending release or exit').message;
    try {
      await releaseLock(f.lock, 'parent');
      const released = output.waitForOutput(/^released\r?$/m);
      child.kill('SIGTERM');
      await released;
      assert.deepEqual(await hangDetector(ended, 'heavy-slot holder exits after release', { diagnostic }), { code: 0, signal: null });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await hangDetector(ended, 'heavy-slot holder cleanup', { diagnostic });
    }
  }
  assert.equal(existsSync(f.lock), false); assert.equal(existsSync(f.unit), false);
});

test('legacy B holders exclude new units and trial off waits without replacing their owner', async t => {
  const f = fixture(t); mkdirSync(f.unit);
  writeFileSync(join(f.unit, 'owner'), JSON.stringify({ token: 'reference', pid: process.pid }));
  await assert.rejects(f.take('new', 'unit'), /held/);
  const off = setTrial(f.lock, false);
  assert.equal(JSON.parse(readFileSync(join(f.unit, 'owner'))).token, 'reference');
  rmSync(f.unit, { recursive: true }); await off;
  assert.equal(JSON.parse(readFileSync(join(f.unit, 'owner'))).disabled, true);
  await setTrial(f.lock, true); assert.equal(existsSync(f.unit), false);
});

test('trial on supersedes a pending disable without touching the active B owner', async t => {
  const f = fixture(t); await f.take('running', 'unit');
  const off = setTrial(f.lock, false);
  await setTrial(f.lock, true);
  assert.equal(JSON.parse(readFileSync(join(f.unit, 'owner'))).token, 'running');
  await releaseLock(f.lock, 'running'); await off;
  await f.take('next', 'unit'); await releaseLock(f.lock, 'next');
});

test('segment inspection counts actual rows and refuses unrecognised output', () => {
  assert.equal(countSegments('T ID KEY MODE OWNER GROUP\nShared Memory:\nm 1 0x1 --rw user group\nm 2 0x2 --rw user group\n'), 2);
  assert.equal(countSegments('------ Shared Memory Segments --------\nkey shmid owner perms bytes nattch status\n0x00000000 1 user 600 56 0\n'), 1);
  assert.throws(() => countSegments('inspection failed'), /inspection/i);
});
