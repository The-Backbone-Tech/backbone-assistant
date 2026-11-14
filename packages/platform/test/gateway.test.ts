import { pollUntil } from './helpers.ts';
// The gateway port for doors, over the real core in a fresh data home: grants narrow, the core
// decides, an allowed effect is carried out once and every call returns its receipt.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { join } from 'node:path';
import { grantDoor, openGateway, revokeDoor, sweepInterruptedDispatches } from '../src/composition/gateway.ts';
import { outboxExecutor } from '../src/composition/outbox.ts';
import { CoreLink } from '../src/composition/core.ts';
import { createHost, removeDataHome } from '../src/composition/host.ts';
import { freshDataHome } from '../src/testing/data-home.ts';
import { lapseDispatchClaims } from '../src/testing/time.ts';
const openHost = (h: string) => {
  const host = createHost({ home: h });
  void host.resumeInterrupted().catch(() => {});
  return { host };
};
import type { Gateway, GatewayResult } from '../src/gateway.ts';

const home = freshDataHome('gateway');
const open: Gateway[] = [];
after(async () => {
  for (const g of open) await g.close();
  await removeDataHome(home);
});
const value = <T>(r: GatewayResult<T>): T => {
  if (!r.ok) throw new Error(`refused: ${r.reason}: ${r.detail}`);
  return r.value;
};
async function door(grant: string, executors?: Parameters<typeof openGateway>[0]['executors']) {
  const g = await openGateway({ home, grant, executors });
  open.push(g);
  return g;
}

test('without a grant every call is refused as having no mandate', async () => {
  const g = await door('nobody');
  for (const r of [
    await g.call('effects.propose', { operation: 'outbox.write', args: { name: 'a.txt', content: 'x' }, description: 'x', idempotencyKey: 'k0' }),
    await g.call('effects.list', {}),
    await g.call('knowledge.recall', {}),
  ]) {
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, 'NO_MANDATE');
  }
});

test('an allowed effect is carried out once; the same key returns the same receipt', async () => {
  await grantDoor({ home, name: 'writer', operations: ['outbox.write'], ceiling: 3 });
  const g = await door('writer');
  const first = value(await g.call('effects.propose', { operation: 'outbox.write', args: { name: 'note.txt', content: 'hello' }, description: 'a note', idempotencyKey: 'note-1' }));
  assert.equal(first.outcome, 'DONE');
  assert.equal(readFileSync(join(home, 'outbox/note.txt'), 'utf8'), 'hello');
  const again = value(await g.call('effects.propose', { operation: 'outbox.write', args: { name: 'note.txt', content: 'hello' }, description: 'a note', idempotencyKey: 'note-1' }));
  assert.equal(again.effect, first.effect);
  const reused = await g.call('effects.propose', { operation: 'outbox.write', args: { name: 'other.txt', content: 'x' }, description: 'x', idempotencyKey: 'note-1' });
  assert.equal(!reused.ok && reused.reason, 'REUSED_KEY');
  assert.equal(value(await g.call('effects.get', { idempotencyKey: 'note-1' })).effect, first.effect);
  assert.deepEqual(value(await g.call('effects.list', {})).map((r) => r.effect), [first.effect]);
  assert.deepEqual(value(await g.call('knowledge.recall', { words: ['anything'] })), []);
});

test('authority only narrows: outside the grant is refused, above its ceiling waits for a person', async () => {
  const executors = { 'outbox.write': outboxExecutor(home), 'outbox.other': outboxExecutor(home) };
  await grantDoor({ home, name: 'narrow', operations: ['outbox.write'], ceiling: 2 });
  const g = await door('narrow', executors);
  const outside = value(await g.call('effects.propose', { operation: 'outbox.other', args: { name: 'o.txt', content: 'o' }, description: 'o', idempotencyKey: 'n-1' }));
  assert.equal(outside.outcome, 'REFUSED');
  assert.equal(outside.reason, 'outside_mandate');
  const above = value(await g.call('effects.propose', { operation: 'outbox.write', args: { name: 'w.txt', content: 'w' }, description: 'w', idempotencyKey: 'n-2' }));
  assert.equal(above.outcome, 'AWAITING_DECISION');
  assert.equal(above.reason, 'above_ceiling');
  assert.ok(!existsSync(join(home, 'outbox/o.txt')) && !existsSync(join(home, 'outbox/w.txt')));
});

test('a revoked grant refuses every later call, also from a door opened again', async () => {
  await grantDoor({ home, name: 'revoked', operations: ['outbox.write'], ceiling: 2 });
  const g = await door('revoked');
  const waiting = value(await g.call('effects.propose', { operation: 'outbox.write', args: { name: 'r.txt', content: 'r' }, description: 'r', idempotencyKey: 'r-1' }));
  assert.equal(waiting.outcome, 'AWAITING_DECISION');
  await revokeDoor({ home, name: 'revoked' });
  const later = await g.call('effects.propose', { operation: 'outbox.write', args: { name: 'r2.txt', content: 'r' }, description: 'r', idempotencyKey: 'r-2' });
  assert.equal(!later.ok && later.reason, 'NO_MANDATE');
  const reopened = await door('revoked');
  assert.equal((await reopened.call('effects.list', {})).ok, false);
});

// ---- Review ratchet (cross-family review of pilot/mcp-door, 25 Oct 2026) ----

const crashDispatch = (grant: string, key: string, at: 'effect.claimed' | 'effect.begun') =>
  spawnSync(process.execPath, [fileURLToPath(new URL('./crash-dispatch.ts', import.meta.url)), home, grant, key], {
    encoding: 'utf8',
    env: { ...process.env, BACKBONE_CRASH_AT: at },
  });
/** The effect's status once it reads `want`, or what it reads after 10 s. */
async function eventually(key: string, want: string): Promise<string | undefined> {
  let status: string | undefined;
  await pollUntil(async active => {
    while (active() && (status !== want)) {
       await new Promise((r) => setTimeout(r, 200));
       status = await statusOf(key);
     }
  }, "packages/platform/test/gateway.test.ts:100 eventually");
  return status;
}
async function statusOf(key: string): Promise<string | undefined> {
  const link = await CoreLink.open({ home });
  try {
    const { rows } = await link.read<{ status: string }>(link.system(), 'SELECT status FROM app.effects WHERE idempotency_key = $1', [key]);
    return rows[0]?.status;
  } finally {
    await link.release();
  }
}

test('granting an existing door name again is refused, and the first grant still stands', async () => {
  const first = await grantDoor({ home, name: 'twice', operations: ['outbox.write'], ceiling: 3 });
  await assert.rejects(grantDoor({ home, name: 'twice', operations: ['outbox.write'], ceiling: 3 }), /already/);
  assert.equal(JSON.parse(readFileSync(join(home, 'doors/twice.json'), 'utf8')).mandate, first.mandate);
  await revokeDoor({ home, name: 'twice' });
  const g = await door('twice');
  assert.equal((await g.call('effects.list', {})).ok, false);
});

test('a dispatch killed mid-way is settled UNKNOWN on restart even after the door was revoked, and the door stays refused', async () => {
  await grantDoor({ home, name: 'killed-revoked', operations: ['outbox.write'], ceiling: 3 });
  const child = crashDispatch('killed-revoked', 'kr-1', 'effect.begun');
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  assert.equal(await statusOf('kr-1'), 'dispatching');
  await revokeDoor({ home, name: 'killed-revoked' });
  const g = await door('killed-revoked');
  const refused = await g.call('effects.get', { idempotencyKey: 'kr-1' });
  assert.equal(!refused.ok && refused.reason, 'NO_MANDATE');
  // Its own dispatch claim decides, not the revoked run: in flight until that claim lapses.
  assert.equal(await statusOf('kr-1'), 'dispatching');
  await lapseDispatchClaims(home);
  assert.equal(await eventually('kr-1', 'unknown'), 'unknown');
  assert.ok(!existsSync(join(home, 'outbox/kr-1.txt')));
});

test('a door that never restarts: the app surfaces its interrupted dispatch as UNKNOWN once the door is gone', async () => {
  await grantDoor({ home, name: 'abandoned', operations: ['outbox.write'], ceiling: 3 });
  const child = crashDispatch('abandoned', 'ab-1', 'effect.begun');
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  await lapseDispatchClaims(home);
  const { host } = openHost(home);
  let status: string | undefined;
  await pollUntil(async active => {
    while (active() && (status !== 'unknown')) {
       await new Promise((r) => setTimeout(r, 200));
       status = await statusOf('ab-1');
     }
  }, "packages/platform/test/gateway.test.ts:148 polling state");
  host.close();
  assert.equal(status, 'unknown');
});

test('refusals never echo caller text: not the operation, not argument names or values', async () => {
  await grantDoor({ home, name: 'echo', operations: ['outbox.write'], ceiling: 3 });
  const g = await door('echo');
  const MARK = 'ECHO-MARK-4b1d';
  const results = [
    await g.call('effects.propose', { operation: `x.${MARK}`, args: {}, description: 'd', idempotencyKey: 'e-1' }),
    await g.call('effects.propose', { operation: 'outbox.write', args: { name: 'a.txt', content: 'c', [MARK]: MARK }, description: 'd', idempotencyKey: 'e-2' }),
    await g.call('effects.propose', { operation: 'outbox.write', args: { name: `../${MARK}`, content: 'c' }, description: 'd', idempotencyKey: 'e-3' }),
    await g.call('effects.get', { effect: MARK }),
  ];
  for (const r of results) assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(results).includes(MARK), JSON.stringify(results));
});

test('reading a receipt never dispatches: an effect left claimed stays PENDING until it is proposed again', async () => {
  await grantDoor({ home, name: 'observe', operations: ['outbox.write'], ceiling: 3 });
  const child = crashDispatch('observe', 'ob-1', 'effect.claimed');
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  const g = await openGateway({ home, grant: 'observe', dispatchLeaseMs: 500 });
  open.push(g);
  await new Promise((r) => setTimeout(r, 700));
  const read = value(await g.call('effects.get', { idempotencyKey: 'ob-1' }));
  assert.equal(read.outcome, 'PENDING');
  assert.ok(!existsSync(join(home, 'outbox/ob-1.txt')), 'a read carried the effect out');
  const again = value(await g.call('effects.propose', { operation: 'outbox.write', args: { name: 'ob-1.txt', content: 'ob-1' }, description: 'crash test', idempotencyKey: 'ob-1' }));
  assert.equal(again.outcome, 'DONE');
});

// ---- Review ratchet 2: the sweep decides by the effect's own dispatch claim, never by the run ----

/** An outbox executor whose dispatch waits until `release` is called (or blocks the thread for `blockMs`). */
function slowOutbox(blockMs = 0) {
  const real = outboxExecutor(home);
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  let started = () => {};
  const begun = new Promise<void>((r) => (started = r));
  const executor = {
    ...real,
    async dispatch(args: Record<string, unknown>) {
      started();
      if (blockMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, blockMs);
      else await gate;
      return real.dispatch(args);
    },
  };
  return { executor, begun, release: () => release() };
}

test('revoking a door while a begun dispatch completes: the sweep leaves it, and its true outcome is recorded', async () => {
  await grantDoor({ home, name: 'revoked-midway', operations: ['outbox.write'], ceiling: 3 });
  const slow = slowOutbox();
  const g = await door('revoked-midway', { 'outbox.write': slow.executor });
  const pending = g.call('effects.propose', { operation: 'outbox.write', args: { name: 'rm-1.txt', content: 'rm' }, description: 'd', idempotencyKey: 'rm-1' });
  await slow.begun;
  await revokeDoor({ home, name: 'revoked-midway' });
  const link = await CoreLink.open({ home });
  await sweepInterruptedDispatches(link, { 'outbox.write': outboxExecutor(home) });
  await link.release();
  slow.release();
  await pending;
  assert.equal(await statusOf('rm-1'), 'succeeded');
  assert.equal(readFileSync(join(home, 'outbox/rm-1.txt'), 'utf8'), 'rm');
});

test('a dispatcher paused beyond its run lease: another process sweeping meanwhile does not take its outcome', async () => {
  await grantDoor({ home, name: 'paused', operations: ['outbox.write'], ceiling: 3 });
  const slow = slowOutbox(8_000);
  const g = await door('paused', { 'outbox.write': slow.executor });
  const sweeper = spawn(process.execPath, [fileURLToPath(new URL('./sweeper.ts', import.meta.url)), home, '12000'], { stdio: 'ignore' });
  const exited = new Promise((r) => sweeper.once('exit', r));
  const receipt = value(await g.call('effects.propose', { operation: 'outbox.write', args: { name: 'pa-1.txt', content: 'pa' }, description: 'd', idempotencyKey: 'pa-1' }));
  await exited;
  assert.equal(receipt.outcome, 'DONE');
  assert.equal(await statusOf('pa-1'), 'succeeded');
});

test('a dispatcher slower than its claim: the sweep records UNKNOWN, and its late observation settles the truth without resending', async () => {
  await grantDoor({ home, name: 'slow', operations: ['outbox.write'], ceiling: 3 });
  const slow = slowOutbox();
  let sends = 0;
  const executor = { ...slow.executor, async dispatch(args: Record<string, unknown>) { sends++; return slow.executor.dispatch(args); } };
  const g = await door('slow', { 'outbox.write': executor });
  const pending = g.call('effects.propose', { operation: 'outbox.write', args: { name: 'sl-1.txt', content: 'sl' }, description: 'd', idempotencyKey: 'sl-1' });
  await slow.begun;
  await lapseDispatchClaims(home);
  const link = await CoreLink.open({ home });
  try {
    // Every open gateway also sweeps periodically. Either sweep may win; the
    // observable guarantee is UNKNOWN before the still-held dispatcher answers.
    await sweepInterruptedDispatches(link, { 'outbox.write': outboxExecutor(home) });
    assert.equal(await statusOf('sl-1'), 'unknown');
  } finally {
    await link.release();
    slow.release();
  }
  const receipt = value(await pending);
  assert.equal(receipt.outcome, 'DONE');
  assert.equal(await statusOf('sl-1'), 'succeeded');
  assert.equal(sends, 1, 'recovery and late observation never resend the call');
});
