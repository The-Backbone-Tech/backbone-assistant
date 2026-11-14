import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createWakeGateRunner } from '../src/schedules/wake-gate.ts';

test('a gate resolves at its deadline without an exit event and keeps an unreferenced reaper', { timeout: 2_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'gate-deadline-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const child = Object.assign(new EventEmitter(), { pid: 12345, unref() { unreferenced++; } });
  let unreferenced = 0, kills = 0;
  const runner = createWakeGateRunner({ spawn: () => child, kill: () => { kills++; }, concurrency: 1 });
  const start = Date.now();
  assert.equal(await runner.check(home, { command: process.execPath, args: [], timeoutMs: 100 }, new AbortController().signal), 'failed');
  assert.ok(Date.now() - start < 1_000);
  assert.ok(kills > 0); assert.ok(unreferenced > 0);
  // The orphan still occupies the only process slot; another check also resolves without spawning.
  assert.equal(await runner.check(home, { command: process.execPath, args: [], timeoutMs: 100 }, new AbortController().signal), 'failed');
  child.emit('exit', null);
});

test('gate concurrency is bounded and abort settles queued and running checks without exit events', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'gate-slots-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const children: EventEmitter[] = [];
  const runner = createWakeGateRunner({ concurrency: 2, kill: () => {}, spawn: () => {
    const child = Object.assign(new EventEmitter(), { pid: 12345 + children.length, unref() {} }); children.push(child); return child;
  } });
  const abort = new AbortController();
  const checks = Array.from({ length: 5 }, () => runner.check(home, { command: process.execPath, args: [], timeoutMs: 500 }, abort.signal));
  assert.equal(children.length, 2);
  abort.abort();
  assert.deepEqual(await Promise.all(checks), ['failed', 'failed', 'failed', 'failed', 'failed']);
  for (const child of children) child.emit('exit', null);
});
