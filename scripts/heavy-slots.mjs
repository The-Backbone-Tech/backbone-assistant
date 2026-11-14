// Machine protocol (10 Nov 2026): integrator A = .heavy.lock plus .heavy.next;
// unit B = .heavy.lock.b, independent of A/priority, admitted only below 24 System V segments.
// First load-attributed gate failure OVERLAPPING B: integrator disables B with --trial-off.
// Existing holders drain; --trial-on is an explicit integrator decision, never automatic.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, existsSync, rmdirSync, openSync, closeSync, fstatSync, constants } from 'node:fs';
import native from 'fs-native-extensions';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const borrowed = new Set(), markers = new Map();
const read = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const priorityPath = lock => lock.endsWith('.heavy.lock') ? join(dirname(lock), '.heavy.next') : `${lock}.next`;
const disabledPath = lock => `${lock}.b.disabled`;
const blocker = owner => owner?.disabled === true && owner?.protocol === 'backbone-slot-b-disabled-v1';
const atomicJson = (file, value) => { const temporary = `${file}.${randomUUID()}`; writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); renameSync(temporary, file); };
const pause = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));

function control(lock, run) {
  // Native advisory lock serializes managed admission/disable; legacy clients share mkdir locks.
  const fd = openSync(`${lock}.control`, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW || 0), 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe heavy-slot control file');
    if (!native.tryLock(fd)) return false;
    return run();
  } finally { closeSync(fd); }
}

export function countSegments(text) {
  if (!/Shared Memory|T\s+ID\s+KEY/i.test(text)) throw new Error('System V segment inspection is unavailable');
  return text.split('\n').filter(line => /^\s*(?:m\s|0x[\da-f]+\s)/i.test(line)).length;
}
export const systemVSegments = () => countSegments(execFileSync('ipcs', ['-m'], { encoding: 'utf8' }));
const segmentCount = inspect => { const n = inspect(); if (!Number.isInteger(n) || n < 0) throw new Error('System V segment count is unknown'); return n; };
const disabledOwner = () => ({ protocol: 'backbone-slot-b-disabled-v1', disabled: true, token: randomUUID(), pid: process.pid, what: 'slot B disabled by integrator' });

/** Disable blocks both this wrapper and the reference mkdir wrapper, without evicting a holder. */
export async function setTrial(lock, enabled, reason = 'integrator decision', wait = 40) {
  mkdirSync(dirname(lock), { recursive: true });
  const deadline = Date.now() + wait * 60000, unit = `${lock}.b`;
  const decision = randomUUID(); let requested = false;
  for (;;) {
    const done = control(lock, () => {
      if (enabled) {
        if (blocker(read(join(unit, 'owner')))) { rmSync(join(unit, 'owner')); rmdirSync(unit); }
        rmSync(disabledPath(lock), { force: true }); return true;
      }
      if (!requested) { atomicJson(disabledPath(lock), { token: decision, reason, at: new Date().toISOString() }); requested = true; }
      else if (read(disabledPath(lock))?.token !== decision) return true; // A newer integrator decision wins.
      if (blocker(read(join(unit, 'owner')))) return true;
      try { mkdirSync(unit); } catch (e) { if (e.code === 'EEXIST') return false; throw e; }
      atomicJson(join(unit, 'owner'), disabledOwner()); return true;
    });
    if (done) return;
    if (Date.now() >= deadline) throw new Error('Slot B disable is pending its current holder; new managed units are refused');
    await pause();
  }
}

function releaseMarker(lock, token) {
  const key = `${lock}:${token}`, marker = markers.get(key);
  if (marker && read(marker)?.token === token) rmSync(marker);
  markers.delete(key);
}

export async function takeLock(lock, owner, wait, isInterrupted = () => false, { segments = systemVSegments } = {}) {
  mkdirSync(dirname(lock), { recursive: true });
  const deadline = Date.now() + wait * 60000, role = owner.role || 'gate', slot = role === 'gate' ? 'A' : 'B';
  if (!['gate', 'unit'].includes(role)) throw new Error('Heavy role must be gate or unit');
  const target = role === 'gate' ? lock : `${lock}.b`;
  let inherited;
  try { inherited = JSON.parse(process.env.BACKBONE_HEAVY_LEASE || 'null'); } catch { /* Invalid hints grant nothing. */ }
  if (inherited?.lock === resolve(lock)) {
    const actual = read(join(inherited.slot === 'A' ? lock : `${lock}.b`, 'owner'));
    if (role !== 'gate' || actual?.role !== 'gate' || inherited.slot !== 'A' || actual?.token !== inherited.token) throw new Error('A nested gate requires its integrator wrapper slot A');
    borrowed.add(`${lock}:${owner.token}`); return { slot: 'A', trial: !existsSync(disabledPath(lock)), borrowed: true };
  }
  try {
    for (;;) {
      if (isInterrupted()) throw new Error('Interrupted while waiting for the heavy lock');
      const acquired = control(lock, () => {
        if (role === 'unit') {
          if (existsSync(disabledPath(lock)) || blocker(read(join(target, 'owner')))) throw new Error('Slot B is disabled by the integrator');
          if (segmentCount(segments) >= 24) return false;
        } else {
          // Preserve another integrator's marker; remove only a marker this run created.
          try { writeFileSync(priorityPath(lock), JSON.stringify(owner), { flag: 'wx' }); markers.set(`${lock}:${owner.token}`, priorityPath(lock)); }
          catch (e) { if (e.code !== 'EEXIST') throw e; }
        }
        try { mkdirSync(target); } catch (e) { if (e.code === 'EEXIST') return false; throw e; }
        try {
          if (role === 'unit' && segmentCount(segments) >= 24) { rmdirSync(target); return false; }
          writeFileSync(join(target, 'owner'), JSON.stringify({ ...owner, role, slot, start: new Date().toISOString() }), { flag: 'wx' });
        } catch (e) { rmdirSync(target); throw e; }
        return { slot, trial: !existsSync(disabledPath(lock)) };
      });
      if (acquired) return acquired;
      if (Date.now() >= deadline) throw new Error(`Heavy lock is held or segment capacity exhausted: ${target}`);
      // Match the reference unit wrapper's ten-second polling without delaying cancellation.
      const delay = Math.min(role === 'unit' ? 10000 : 100, Math.max(1, deadline - Date.now()));
      for (let elapsed = 0; elapsed < delay && !isInterrupted(); elapsed += 100) await pause(Math.min(100, delay - elapsed));
    }
  } catch (e) { releaseMarker(lock, owner.token); throw e; }
}

export async function releaseLock(lock, token) {
  if (borrowed.delete(`${lock}:${token}`)) return;
  for (;;) {
    const done = control(lock, () => {
      for (const target of [lock, `${lock}.b`]) if (read(join(target, 'owner'))?.token === token) {
        if (target !== lock && existsSync(disabledPath(lock))) atomicJson(join(target, 'owner'), disabledOwner());
        else { rmSync(join(target, 'owner')); rmdirSync(target); }
      }
      releaseMarker(lock, token); return true;
    });
    if (done) return;
    await pause();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [action] = process.argv.slice(2);
  if (process.env.BACKBONE_HEAVY_ROLE !== 'gate') throw new Error('Only the integrator (BACKBONE_HEAVY_ROLE=gate) controls the trial');
  const lock = resolve(process.env.BACKBONE_HEAVY_LOCK || join(homedir(), 'backbone-next-worktrees/.heavy.lock'));
  if (!['--trial-on', '--trial-off'].includes(action)) throw new Error('usage: node scripts/heavy-slots.mjs --trial-on | --trial-off');
  await setTrial(lock, action === '--trial-on');
}
