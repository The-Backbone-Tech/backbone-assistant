import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessEvent, ToolHost } from '../src/ports/harness.ts';
import type { TelemetryObservation } from '../src/ports/telemetry.ts';
import { TELEMETRY_TOOLS } from '../src/ports/telemetry.ts';
import { observeNativeTools, observeTools, subscribeTelemetry } from '../src/composition/telemetry-observations.ts';

const fixtureTools = (): ToolHost => ({ list: async () => [], read: async () => null, write: async () => ({ outcome: 'REFUSED', detail: 'fixture' }) });

test('a throwing observer cannot change synchronous tool returns or exceptions', () => {
  const home = 'telemetry-sync-fixture', marker = 'tool-content-marker';
  const captured: TelemetryObservation[] = [];
  const offThrowing = subscribeTelemetry(home, () => { throw new Error('observer failed'); });
  const offCapture = subscribeTelemetry(home, event => captured.push(event));
  const failure = new Error(marker), result = [{ name: marker }];
  const tools = { ...fixtureTools(), connectors: () => result, proposeGoal: () => { throw failure; } } as unknown as ToolHost;
  try {
    const observed = observeTools(home, 'thread-id', 'turn-id', tools);
    assert.equal(observed.connectors!(), result);
    assert.throws(() => observed.proposeGoal!(marker), error => error === failure);
    assert.deepEqual(captured.map(event => event.kind === 'tool' && [event.tool, event.outcome]), [['connectors', 'done'], ['proposeGoal', 'failed']]);
    assert.ok(!JSON.stringify(captured).includes(marker));
  } finally { offThrowing(); offCapture(); }
});

test('a throwing observer cannot change asynchronous tool values or rejections', async () => {
  const home = 'telemetry-async-fixture', marker = 'async-tool-content-marker';
  const captured: TelemetryObservation[] = [];
  const offThrowing = subscribeTelemetry(home, () => { throw new Error('observer failed'); });
  const offRejecting = subscribeTelemetry(home, async () => { throw new Error('asynchronous observer failed'); });
  const offCapture = subscribeTelemetry(home, event => captured.push(event));
  const failure = new Error(marker), value = { outcome: 'REFUSED' as const, detail: marker };
  const tools: ToolHost = { ...fixtureTools(), write: async () => value, read: async () => { throw failure; } };
  try {
    const observed = observeTools(home, 'thread-id', 'turn-id', tools);
    assert.equal(await observed.write(marker, marker, new AbortController().signal), value);
    await assert.rejects(observed.read(marker), error => error === failure);
    assert.deepEqual(captured.map(event => event.kind === 'tool' && [event.tool, event.outcome]), [['write', 'refused'], ['read', 'failed']]);
    assert.ok(!JSON.stringify(captured).includes(marker));
  } finally { offThrowing(); offRejecting(); offCapture(); }
});

test('native tool observations use only fixed names and observed timing, with no engine ID or label', () => {
  const home = 'telemetry-native-fixture', marker = 'native-content-marker';
  const captured: TelemetryObservation[] = [];
  let clock = 1000;
  const now = mock.method(Date, 'now', () => clock);
  const offThrowing = subscribeTelemetry(home, () => { throw new Error(marker); });
  const offCapture = subscribeTelemetry(home, event => captured.push(event));
  try {
    const observe = observeNativeTools(home, 'thread-id', 'turn-id');
    const event: Extract<HarnessEvent, { type: 'tool' }> = { type: 'tool', tool: 'native_staged', id: marker, label: marker, phase: 'proposed' };
    observe(event);
    clock = 1010; observe({ ...event, phase: 'done' });
    clock = 1020; observe({ ...event, tool: 'native_subagent', phase: 'proposed' });
    clock = 1060; observe({ ...event, tool: 'native_subagent', phase: 'refused' });
    clock = 1070; observe({ ...event, tool: marker, phase: 'done' });
    clock = 1080; observe({ ...event, id: 'no-proposal', phase: 'unknown' });
    assert.deepEqual(captured, [
      { kind: 'tool', threadId: 'thread-id', turnId: 'turn-id', tool: 'native_staged', startedAt: 1000, endedAt: 1010, outcome: 'done' },
      { kind: 'tool', threadId: 'thread-id', turnId: 'turn-id', tool: 'native_subagent', startedAt: 1020, endedAt: 1060, outcome: 'refused' },
      { kind: 'tool', threadId: 'thread-id', turnId: 'turn-id', tool: 'native_staged', startedAt: 1080, endedAt: 1080, outcome: 'unknown' },
    ]);
    assert.ok(!JSON.stringify(captured).includes(marker));
    assert.ok(TELEMETRY_TOOLS.includes('native_staged') && TELEMETRY_TOOLS.includes('native_subagent'));
  } finally { now.mock.restore(); offThrowing(); offCapture(); }
});

test('native active timing storage is bounded and an evicted proposal becomes a completion point', () => {
  const home = 'telemetry-native-bound-fixture', captured: TelemetryObservation[] = [];
  let clock = 2000;
  const now = mock.method(Date, 'now', () => clock);
  const off = subscribeTelemetry(home, event => captured.push(event));
  try {
    const observe = observeNativeTools(home, 'thread-id', 'turn-id');
    for (let n = 0; n < 129; n++) observe({ id: String(n), tool: 'native_staged', phase: 'proposed' });
    clock = 3000;
    observe({ id: '0', tool: 'native_staged', phase: 'done' });
    observe({ id: '1', tool: 'native_staged', phase: 'done' });
    assert.deepEqual(captured.map(event => event.kind === 'tool' && [event.startedAt, event.endedAt]), [[3000, 3000], [2000, 3000]]);
  } finally { now.mock.restore(); off(); }
});

test('a subscriber and observations agree on homes reached through a filesystem alias', async () => {
  const root = mkdtempSync(join(tmpdir(), 'backbone-telemetry-alias-'));
  const home = join(root, 'home'), alias = join(root, 'alias'), captured: TelemetryObservation[] = [];
  mkdirSync(home); symlinkSync(home, alias, 'dir');
  const off = subscribeTelemetry(alias, event => captured.push(event));
  try {
    await observeTools(home, 'thread-id', 'turn-id', fixtureTools()).list();
    observeNativeTools(home, 'thread-id', 'turn-id')({ tool: 'native_staged', phase: 'done' });
    assert.deepEqual(captured.map(event => event.kind === 'tool' && event.tool), ['list', 'native_staged']);
  } finally { off(); rmSync(root, { recursive: true, force: true }); }
});

test('with no listeners, every observation returns before resolving the home path', async () => {
  const fs = await import('node:fs');
  const { syncBuiltinESMExports } = await import('node:module');
  const { publishTelemetry, observeEffect } = await import('../src/composition/telemetry-observations.ts');
  let calls = 0;
  const probe = mock.method(fs.default, 'realpathSync', () => { calls++; throw new Error('No path resolution is needed'); });
  syncBuiltinESMExports();
  try {
    const home = 'unused-telemetry-home';
    publishTelemetry(home, { kind: 'effect', effectId: 'id', phase: 'held', at: 0, outcome: 'held' });
    observeEffect(home, { effect: 'id' }, 'held');
    const tools = fixtureTools(); assert.equal(observeTools(home, 'thread', 'turn', tools), tools);
    observeNativeTools(home, 'thread', 'turn')({ tool: 'native_staged', phase: 'done' });
    assert.equal(calls, 0);
  } finally { probe.mock.restore(); syncBuiltinESMExports(); }
});
