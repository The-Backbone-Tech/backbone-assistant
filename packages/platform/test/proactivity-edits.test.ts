// A preview is an immutable choice of time, including relative times. Rejected edits change nothing.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createProactivity } from '../src/composition/proactivity.ts';
import { withHomeLock } from '../src/composition/home-lock.ts';
import type { Args, Method, Receipt } from '../src/api.ts';

const value = <T>(r: Receipt<T>): T => { assert.ok(r.ok, JSON.stringify(r)); return r.value; };
async function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'schedule-edits-'));
  let now = new Date(2026, 10, 2, 7, 0).getTime();
  const service = createProactivity({ home, threads: new Map(), now: () => now, tickMs: 60_000, readOnly: true,
    closing: () => false, projectExists: () => true, emit: () => {}, material: { load: () => null },
    admit: async () => { throw new Error('No turn is due in edit tests.'); } });
  t.after(async () => { service.close(); await service.whenIdle(); rmSync(home, { recursive: true, force: true }); });
  type M = keyof typeof service.handlers & Method;
  const call = <K extends M>(method: K, args: Args<K>) => withHomeLock(home, async () => {
    const handler = service.handlers[method] as (a: Args<K>) => ReturnType<typeof service.handlers[K]>;
    return await handler(args);
  });
  const created = value(await call('schedules.create', { projectId: 'p', text: 'Summarise unread mail', when: 'every weekday at 8',
    settings: { permission: 'ask', model: 'stub', effort: 3, runsOn: 'this-computer', mode: 'chat' }, clientKey: 'mail' }));
  return { call, created, advance: (minutes: number) => { now += minutes * 60_000; } };
}

test('editing a schedule pins the relative time the person saw instead of parsing it at save', async t => {
  const f = await fixture(t);
  const read = value(await f.call('schedules.parse', { when: 'in 2 hours' }));
  assert.ok(read.nextAt);
  f.advance(15);
  const edited = value(await f.call('schedules.update', { id: f.created.id, baseVersion: f.created.version,
    patch: { when: 'in 2 hours', text: 'Summarise unread mail and flag deadlines' },
    pinned: { rule: read.rule, anchor: read.anchor, firstAt: read.nextAt } }));
  assert.equal(edited.nextAt, read.nextAt);
  assert.equal(edited.text, 'Summarise unread mail and flag deadlines');
  assert.equal(edited.version, f.created.version + 1);
});

test('an expired preview and an invalid edit leave the saved schedule unchanged', async t => {
  const f = await fixture(t);
  const read = value(await f.call('schedules.parse', { when: 'in 1 minute' }));
  f.advance(2);
  const expired = await f.call('schedules.update', { id: f.created.id, baseVersion: f.created.version,
    patch: { when: 'in 1 minute' }, pinned: { rule: read.rule, anchor: read.anchor, firstAt: read.nextAt! } });
  assert.equal(expired.ok, false);
  const invalid = await f.call('schedules.update', { id: f.created.id, baseVersion: f.created.version,
    patch: { when: 'every day at 10', text: 'x'.repeat(4001) } });
  assert.equal(invalid.ok, false);
  assert.deepEqual((await f.call('schedules.get', {})).schedules, [f.created]);
});

test('a confirmed edit preserves pause and refuses a stale version', async t => {
  const f = await fixture(t);
  const paused = value(await f.call('schedules.update', { id: f.created.id, baseVersion: f.created.version, patch: { paused: true } }));
  const read = value(await f.call('schedules.parse', { when: 'every weekday at 10' }));
  const args = { id: paused.id, baseVersion: paused.version, patch: { when: 'every weekday at 10' },
    pinned: { rule: read.rule, anchor: read.anchor, firstAt: read.nextAt! } };
  const edited = value(await f.call('schedules.update', args));
  assert.equal(edited.paused, true);
  assert.equal(edited.nextAt, read.nextAt);
  assert.equal((await f.call('schedules.update', args)).ok, false);
});
