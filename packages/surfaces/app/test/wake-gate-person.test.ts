import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Host } from '@backbone-next/platform/composition';
import { callFromRenderer } from '../electron/renderer-api.ts';
import { confirmWakeGate } from '../electron/wake-gate.ts';

const gate = { command: '/usr/bin/program', args: ['space in argument', '--token=fake-canary'], timeoutMs: 500 };
const settings = { permission: 'full', model: 'stub', effort: 3, runsOn: 'this-computer', mode: 'chat' } as const;
const create = { projectId: 'p', text: 'Inspect changes', when: 'every hour', settings, clientKey: 'k', wakeGate: gate };

test('renderer API calls cannot create, replace or remove wake gates', async () => {
  const calls: unknown[] = [];
  const host = { call: async (...args: unknown[]) => { calls.push(args); return { ok: true }; } } as unknown as Pick<Host, 'call'>;
  for (const [method, args] of [['schedules.create', create], ['schedules.update', { id: 's', baseVersion: 1, patch: { wakeGate: gate } }], ['schedules.update', { id: 's', baseVersion: 1, patch: { wakeGate: null } }]] as const) {
    assert.equal((await callFromRenderer(host, method, args) as { ok: boolean }).ok, false);
  }
  assert.deepEqual(calls, []);
  await callFromRenderer(host, 'schedules.create', { ...create, wakeGate: undefined });
  assert.deepEqual(calls, [], 'an explicitly present field cannot bypass the person boundary');
});

test('native wake-gate confirmation binds the exact program and argv and refuses cancellation', async () => {
  const calls: unknown[] = [];
  const host = { call: async (...args: unknown[]) => { calls.push(args); return { ok: true, value: { id: 's' } }; } } as unknown as Pick<Host, 'call'>;
  const request = { method: 'schedules.create', args: structuredClone(create) };
  const no = await confirmWakeGate(host, request, async (dialog) => {
    assert.ok(dialog.detail.includes(JSON.stringify(gate.command)));
    assert.ok(dialog.detail.includes(JSON.stringify(gate.args)));
    assert.equal(dialog.defaultId, 1);
    return { response: 1 };
  });
  assert.equal(no.ok, false); assert.deepEqual(calls, []);
  const yes = await confirmWakeGate(host, request, async () => {
    request.args.wakeGate.args[0] = 'changed while asking';
    return { response: 0 };
  });
  assert.equal(yes.ok, true);
  assert.deepEqual(calls, [['schedules.create', create]], 'only the immutable arguments shown in main execute');
});

test('native gate replacement checks the schedule version and confirms changes before writing', async () => {
  const schedule = { id: 's', version: 2, text: 'Inspect changes', when: 'every hour', projectId: 'p', settings, wakeGate: gate };
  const writes: unknown[] = [];
  const host = { call: async (method: string, args: unknown) => {
    if (method === 'schedules.get') return { schedules: [schedule] };
    writes.push({ method, args }); return { ok: true, value: schedule };
  } } as unknown as Pick<Host, 'call'>;
  let questions = 0;
  const show = async (dialog: { detail: string }) => { questions++; assert.ok(dialog.detail.includes(JSON.stringify(schedule.text))); return { response: 0 }; };
  assert.equal((await confirmWakeGate(host, { method: 'schedules.update', args: { id: 's', baseVersion: 1, patch: { wakeGate: gate } } }, show)).ok, false);
  assert.equal(questions, 0); assert.deepEqual(writes, []);
  const request = { method: 'schedules.update', args: { id: 's', baseVersion: 2, patch: { wakeGate: { ...gate, args: ['replacement'] } } } };
  assert.equal((await confirmWakeGate(host, request, show)).ok, true);
  assert.deepEqual(writes, [request]); assert.equal(questions, 1);
});

test('native wake-gate confirmation refuses overlapping requests and releases after cancellation or dialog failure', async () => {
  let questions = 0, writes = 0;
  const host = { call: async () => { writes++; return { ok: true }; } } as unknown as Pick<Host, 'call'>;
  const request = { method: 'schedules.create', args: create };
  let cancel!: (answer: { response: number }) => void;
  const first = confirmWakeGate(host, request, () => { questions++; return new Promise(resolve => { cancel = resolve; }); });
  const repeated = await confirmWakeGate(host, request, async () => { questions++; return { response: 1 }; });
  assert.equal(repeated.ok, false);
  assert.equal(questions, 1, 'an overlapping renderer request cannot queue another native dialog');
  assert.equal(writes, 0);
  cancel({ response: 1 }); assert.equal((await first).ok, false);
  await assert.rejects(confirmWakeGate(host, request, async () => { throw new Error('Dialog closed'); }));
  assert.equal((await confirmWakeGate(host, request, async () => { questions++; return { response: 1 }; })).ok, false);
  assert.equal(questions, 2, 'cancellation and dialog failure do not permanently block a later request');
  assert.equal(writes, 0);
});
