#!/usr/bin/env node
// MACHINE TRIAL (active since 10 Nov 2026 22:24Z): integrator A is .heavy.lock/.heavy.next;
// unit B is .heavy.lock.b, ignores .heavy.next, and starts only below 24 System V segments.
// B appends start/end measurements to backbone/evidence/slot-b-runs.jsonl.
// On the FIRST load-attributed gate failure OVERLAPPING B, the integrator uses --trial-off.
// B holders drain; new B runs are refused. Only explicit --trial-on reopens B.
// Existing package scripts/with-test-cluster and Core globalSetup keep one cluster per suite;
// this wrapper preserves BACKBONE_TEST_PG and never starts a second cluster. Focused DB commands
// must use scripts/with-test-cluster.mjs. Do not launch parallel suites inside a slot.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
import { homedir, loadavg, platform, constants } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { takeLock, releaseLock, systemVSegments } from './heavy-slots.mjs';
import { sweep } from './pg-shm-sweep.mjs';

export async function runHeavy(what, command, options = {}) {
  if (!what || !command.length) throw new Error('usage: with-heavy-lock "<what>" <command...>');
  const lock = resolve(options.lock || process.env.BACKBONE_HEAVY_LOCK || join(homedir(), 'backbone-next-worktrees/.heavy.lock'));
  const out = options.out || process.env.BACKBONE_HEAVY_RECORDS || join(dirname(lock), '.heavy-runs');
  const role = options.role || process.env.BACKBONE_HEAVY_ROLE || 'unit';
  const journal = options.journal || process.env.BACKBONE_HEAVY_JOURNAL || join(homedir(), 'backbone/evidence/slot-b-runs.jsonl');
  const segments = options.segments || systemVSegments;
  const wait = options.wait ?? Number(process.env.BACKBONE_HEAVY_WAIT_MINUTES || 90);
  if (!Number.isFinite(wait) || wait < 0) throw new Error('Heavy wait must be a non-negative number of minutes');
  const token = randomUUID(), load = options.load || loadavg;
  const queuedAt = new Date().toISOString(), waitingStarted = Date.now(), queuedLoad = load();
  const sample = options.sample || (() => platform() === 'darwin' ? sweep({ apply: true }) : { swept: [], kept: [], unavailable: 'System V sweep is macOS-only' });
  const journalEvent = (event, exit, wallSeconds) => {
    if (role !== 'unit') return;
    const count = segments();
    if (!Number.isInteger(count) || count < 0) throw new Error('System V segment count is unknown');
    mkdirSync(dirname(journal), { recursive: true });
    appendFileSync(journal, JSON.stringify({ event, token, what, cwd: process.cwd(), at: new Date().toISOString(), wallSeconds, load: load()[0], segments: count, exit }) + '\n');
  };
  let child, signal;
  const forward = value => {
    signal = value;
    if (child?.pid) try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, value); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  };
  const handlers = Object.fromEntries(['SIGINT', 'SIGTERM', 'SIGHUP'].map(s => [s, () => forward(s)]));
  for (const [s, fn] of Object.entries(handlers)) process.on(s, fn);
  let held = false, record, recordFile;
  try {
    const lease = await takeLock(lock, { pid: process.pid, token, role, what }, wait, () => Boolean(signal), { segments }); held = true;
    mkdirSync(out, { recursive: true }); recordFile = join(out, `${Date.now()}-${token}.json`);
    record = { what, role, ...lease, token, pid: process.pid, queuedAt, waitSeconds: (Date.now() - waitingStarted) / 1000, start: new Date().toISOString(), end: null, startLoad: load(), startSegments: null, endLoad: null, endSegments: null, exitCode: null };
    const save = () => { const temporary = `${recordFile}.tmp`; writeFileSync(temporary, JSON.stringify(record, null, 2) + '\n'); renameSync(temporary, recordFile); };
    save();
    const began = Date.now();
    try {
      journalEvent('start', null, 0);
      try { record.startSegments = sample(); } catch (e) { record.startSegments = { error: e.message }; throw e; }
      save();
      if (signal) throw new Error(`Interrupted before command start: ${signal}`);
      const status = await new Promise((resolveStatus, reject) => {
        child = spawn(command[0], command.slice(1), { stdio: 'inherit', env: { ...process.env, BACKBONE_HEAVY_LOCK: lock, BACKBONE_HEAVY_LEASE: JSON.stringify({ lock, token, slot: lease.slot, role }) }, detached: process.platform !== 'win32' });
        child.once('error', reject); child.once('close', (code, stopped) => resolveStatus(code ?? 128 + (constants.signals[stopped || signal] || 0)));
      });
      record.exitCode = signal ? 128 + constants.signals[signal] : status;
    } catch (e) { record.exitCode = signal ? 128 + constants.signals[signal] : 127; record.error = e.message; }
    finally {
      record.signal = signal || null;
      try { record.endSegments = sample(); } catch (e) { record.endSegments = { error: e.message }; if (record.exitCode === 0) record.exitCode = 1; }
      record.wallSeconds = (Date.now() - began) / 1000; record.end = new Date().toISOString(); record.endLoad = load();
      try { journalEvent('end', record.exitCode, record.wallSeconds); }
      catch (e) { record.journalError = e.message; if (record.exitCode === 0) record.exitCode = 1; }
      save();
    }
    return { exitCode: record.exitCode, recordFile };
  } catch (error) {
    if (held) throw error;
    mkdirSync(out, { recursive: true, mode: 0o700 }); recordFile = join(out, `${Date.now()}-${token}.json`);
    record = { what, role, token, pid: process.pid, phase: 'not-started', start: queuedAt, end: new Date().toISOString(), startLoad: queuedLoad, endLoad: load(), wallSeconds: (Date.now() - waitingStarted) / 1000,
      startSegments: { notRun: 'slot not acquired' }, endSegments: { notRun: 'slot not acquired' }, exitCode: signal ? 128 + constants.signals[signal] : /Heavy lock is held|Slot B is disabled/.test(error.message) ? 75 : 1, error: error.message };
    writeFileSync(recordFile, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
    console.error(error.message);
    return { exitCode: record.exitCode, recordFile };
  } finally {
    if (held) await releaseLock(lock, token);
    for (const [s, fn] of Object.entries(handlers)) process.off(s, fn);
    if (recordFile) console.log(`Heavy run record: ${recordFile}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [what, ...command] = process.argv.slice(2);
  runHeavy(what, command).then(result => { process.exitCode = result.exitCode; }).catch(e => { console.error(e.message); process.exitCode = 1; });
}
