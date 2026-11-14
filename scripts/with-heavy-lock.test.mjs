import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHeavy } from './with-heavy-lock.mjs';
import { takeLock, releaseLock } from './heavy-slots.mjs';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { waitFor, hangDetector } from './lib/test-hang.ts';
import { observeChild } from './lib/test-child.ts';

test('wrapper records wall time, load, shared-memory sweeps and the actual command status', async t => {
  const root = mkdtempSync(join(tmpdir(), 'heavy-record-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let sweeps = 0;
  const result = await runHeavy('unit \"quoted\"\nname', [process.execPath, '-e', 'process.exit(7)'], {
    role: 'unit', lock: join(root, 'legacy-lock'), out: join(root, 'runs'), journal: join(root, 'journal.jsonl'), segments: () => 2, wait: 0,
    sample: () => { sweeps++; return { swept: [], kept: [{ id: 1 }], limit: 32 }; }, load: () => [1, 2, 3],
  });
  assert.equal(result.exitCode, 7); assert.equal(sweeps, 2);
  const record = JSON.parse(readFileSync(result.recordFile, 'utf8'));
  assert.ok(record.wallSeconds >= 0 && record.start && record.end);
  assert.deepEqual(record.startLoad, [1, 2, 3]); assert.deepEqual(record.endLoad, [1, 2, 3]);
  assert.equal(record.exitCode, 7); assert.equal(record.startSegments.limit, 32);
  const events = readFileSync(join(root, 'journal.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(e => e.event), ['start', 'end']);
  for (const e of events) {
    assert.equal(e.token, record.token); assert.equal(e.what, record.what); assert.equal(e.cwd, process.cwd());
    assert.equal(e.segments, 2); assert.equal(e.load, 1); assert.ok(e.at && e.wallSeconds >= 0);
  }
  assert.equal(events[0].exit, null); assert.equal(events[1].exit, 7);
});

test('a cleanup failure is recorded and cannot turn a command into success', async t => {
  const root = mkdtempSync(join(tmpdir(), 'heavy-failure-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = await runHeavy('unit', [process.execPath, '-e', 'process.exit(0)'], {
    role: 'unit', lock: join(root, 'legacy-lock'), out: join(root, 'runs'), journal: join(root, 'journal.jsonl'), segments: () => 2, wait: 0,
    sample: () => { throw new Error('ipcs unavailable'); },
  });
  assert.notEqual(result.exitCode, 0);
  const record = JSON.parse(readFileSync(result.recordFile, 'utf8'));
  assert.ok(record.end && record.endLoad && record.startSegments.error && record.endSegments.error);
  assert.equal(existsSync(join(root, 'legacy-lock')), false);
});

test('SIGTERM drains the command, records failure and releases only its lease', async t => {
  const root = mkdtempSync(join(tmpdir(), 'heavy-signal-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ready = join(root, 'ready'), lock = join(root, 'legacy-lock'), out = join(root, 'runs');
  const module = fileURLToPath(new URL('./with-heavy-lock.mjs', import.meta.url));
  const command = [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(ready)},'up');setInterval(()=>{},1000);`];
  const code = `import {runHeavy} from ${JSON.stringify(module)}; const r=await runHeavy('signal',${JSON.stringify(command)},{role:'unit',lock:${JSON.stringify(lock)},out:${JSON.stringify(out)},journal:${JSON.stringify(join(root, 'journal.jsonl'))},segments:()=>0,sample:()=>({swept:[],kept:[]})});process.exitCode=r.exitCode;`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  const output = observeChild(child, 'isolated heavy wrapper');
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
  const ended = new Promise(resolve => child.once('close', code => resolve(code)));
  await waitFor(() => existsSync(ready), 'heavy wrapper starts its command', { diagnostic: () => output.diagnostic('command readiness pending').message });
  assert.ok(existsSync(ready)); child.kill('SIGTERM');
  assert.equal(await hangDetector(ended, 'heavy wrapper drains after SIGTERM', { diagnostic: () => output.diagnostic('shutdown pending').message }), 143); assert.equal(existsSync(`${lock}.b`), false);
  const record = JSON.parse(readFileSync(join(out, readdirSync(out).find(f => f.endsWith('.json'))), 'utf8'));
  assert.equal(record.signal, 'SIGTERM'); assert.equal(record.exitCode, 143);
});

test('a busy legacy slot records an unstarted attempt and exits 75 without a sweep or command', async t => {
  const root = mkdtempSync(join(tmpdir(), 'heavy-wait-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lock = join(root, 'legacy-lock'); mkdirSync(`${lock}.b`);
  const result = await runHeavy('waiting', [process.execPath, '-e', 'process.exit(0)'], { role: 'unit', lock, out: join(root, 'runs'), journal: join(root, 'journal.jsonl'), segments: () => 0, wait: 0, sample: () => assert.fail('no admission') });
  assert.equal(result.exitCode, 75);
  const record = JSON.parse(readFileSync(result.recordFile, 'utf8'));
  assert.equal(record.phase, 'not-started'); assert.ok(record.startLoad && record.endLoad);
  assert.equal(existsSync(`${lock}.b`), true);
});

test('capacity and disabled B refuse the command without acquiring A or writing a start record', async t => {
  const root = mkdtempSync(join(tmpdir(), 'heavy-admission-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lock = join(root, 'lock'), journal = join(root, 'events.jsonl');
  const options = { role: 'unit', lock, journal, out: join(root, 'records'), wait: 0, sample: () => assert.fail('unadmitted run must not sweep') };
  const full = await runHeavy('full', [process.execPath, '-e', 'process.exit(0)'], { ...options, segments: () => 24 });
  assert.equal(full.exitCode, 75); assert.equal(existsSync(lock), false); assert.equal(existsSync(`${lock}.b`), false);
  const { setTrial } = await import('./heavy-slots.mjs'); await setTrial(lock, false);
  const disabled = await runHeavy('disabled', [process.execPath, '-e', 'process.exit(0)'], { ...options, segments: () => 0 });
  assert.equal(disabled.exitCode, 75); assert.equal(existsSync(lock), false); assert.equal(existsSync(journal), false);
});

test('the CLI shares reference B, ignores queued A and appends escaped journal records', async t => {
  const root = mkdtempSync(join(tmpdir(), 'heavy-cli-'));
  t.after(async () => { await releaseLock(lock, 'integrator'); rmSync(root, { recursive: true, force: true }); });
  const { writeFileSync } = await import('node:fs'), { spawnSync } = await import('node:child_process');
  const lock = join(root, '.heavy.lock'), bin = join(root, 'bin'), journal = join(root, 'events.jsonl'), ran = join(root, 'ran');
  mkdirSync(bin); await takeLock(lock, { token: 'integrator', role: 'gate', pid: process.pid }, 0);
  const ipcs = n => writeFileSync(join(bin, 'ipcs'), `#!/usr/bin/env node\nconsole.log('T ID KEY MODE OWNER GROUP\\nShared Memory:');if(!process.argv.includes('-a'))for(let i=0;i<${n};i++)console.log('m '+i+' 0x1 --rw fixture fixture');\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, BACKBONE_HEAVY_LOCK: lock, BACKBONE_HEAVY_ROLE: 'unit', BACKBONE_HEAVY_RECORDS: join(root, 'records'), BACKBONE_HEAVY_JOURNAL: journal, BACKBONE_HEAVY_WAIT_MINUTES: '0' };
  const launcher = fileURLToPath(new URL('./with-heavy-lock', import.meta.url));
  const command = [process.execPath, '-e', `const fs=require('fs');if(!fs.existsSync(${JSON.stringify(`${lock}.b/owner`)}))throw Error('missing B');fs.writeFileSync(${JSON.stringify(ran)},'ran');`];
  ipcs(24);
  const blocked = spawnSync(launcher, ['blocked', ...command], { env, encoding: 'utf8' });
  assert.equal(blocked.status, 75, blocked.stderr); assert.equal(existsSync(ran), false);
  ipcs(23);
  const run = spawnSync(launcher, ['unit "quoted"\nname', ...command], { env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr); assert.equal(existsSync(ran), true);
  const events = readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(e => e.event), ['start', 'end']);
  assert.equal(events[1].exit, 0); assert.equal(events[0].segments, 23); assert.equal(events[1].segments, 23);
  assert.equal(events[0].what, 'unit "quoted"\nname'); assert.equal(events[0].token, events[1].token);
  assert.equal(existsSync(`${lock}.b`), false); assert.equal(existsSync(lock), true);
  assert.equal(JSON.parse(readFileSync(join(root, '.heavy.next'), 'utf8')).token, 'integrator');
});
