import { pollUntil } from './helpers.ts';
import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; native SQL deadlines are asserted separately.
// One thread through the Host seam on v0.8, in its own database: contract and run, write, a real
// SIGKILL, recovery, an UNKNOWN that holds its target, Stop and restart.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {withHomeLock} from '../src/composition/home-lock.ts';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { retainOriginalWrite } from '../src/composition/thread-custody.ts';
import { MaterialStore } from '../src/stub/material.ts';
import { plaintextKeys } from '../src/keys/vault.ts';
import { createHost } from '../src/composition/host.ts';
import { CoreLink } from '../src/composition/core.ts';
import { createV08Host, type V08Host, type V08HostOptions } from '../src/authority/sql-v08/host.ts';
import { openSqlV08PersonalRuntime } from '../src/authority/sql-v08/transport.ts';
import { identityMint, presentPersonSessions } from '../src/authority/sql-v08/session-owner.ts';
import { scriptedPresence } from './sql-v08-cluster.ts';
import type { PresenceAnswer } from '../src/authority/sql-v08/session-owner.ts';
import type { PersonRequest, SqlClient, SqlOutcome, SqlPool, SqlV08PersonalRuntime } from '../src/authority/sql-v08/types.ts';
import { bootstrapWorkspace, crossingRows, fixtureSessions, startV08Cluster, type V08Cluster } from './sql-v08-cluster.ts';

const LEASE_MS = 800;
const settings = { permission: 'full', model: 'stub', effort: 4, runsOn: 'this-computer', mode: 'chat' } as const;
let cluster: V08Cluster; let app: pg.Pool; let observer: pg.Pool; let identity: pg.Pool; let admin: pg.Pool;
const homes: string[] = [];

before(async () => {
  cluster = await startV08Cluster();
  app = new pg.Pool({ connectionString: cluster.appUrl, max: 4 });
  observer = new pg.Pool({ connectionString: cluster.observerUrl, max: 4 });
  identity = new pg.Pool({ connectionString: cluster.identityUrl, max: 2 });
  admin = new pg.Pool({ connectionString: cluster.adminUrl, max: 2 });
}, { timeout: TEST_HANG_MS * 2 });
after(async () => {
  await Promise.allSettled([app?.end(), observer?.end(), identity?.end(), admin?.end()]);
  await cluster?.stop();
  for (const home of homes) rmSync(home, { recursive: true, force: true });
}, { timeout: TEST_HANG_MS * 2 });

const value = <T>(r: { ok: true; value: T } | { ok: false; detail: string }): T => { if (!r.ok) throw new Error(r.detail); return r.value; };
const committed = <T>(o: SqlOutcome<T>): T => { assert.equal(o.status, 'committed', JSON.stringify(o)); return (o as { value: T }).value; };

async function scenario(extra: Partial<V08HostOptions> = {}, presence = scriptedPresence()) {
  const w = await bootstrapWorkspace(cluster.adminUrl, 'Host');
  const binding = { workspaceId: w.workspaceId, personId: w.ownerId, accountId: 'synthetic-account' };
  const home = mkdtempSync(join(tmpdir(), 'backbone-v08-home-')); homes.push(home);
  const sessions = presentPersonSessions({ binding, mint: identityMint(identity, binding), presence });
  const open = (more: Partial<V08HostOptions> = {}) => createV08Host({ home, appPool: app, observerPool: observer, sessions, binding, dispatchLeaseMs: LEASE_MS, ...extra, ...more });
  const opened = await openSqlV08PersonalRuntime({ appPool: app, observerPool: observer, binding, sessions });
  assert.equal(opened.status, 'ready');
  const runtime = (opened as { runtime: SqlV08PersonalRuntime }).runtime;
  return { binding, home, open, runtime, sessions };
}

async function settled(host: V08Host, id: string) {
  return await pollUntil(async active => {
    while (active()) {
      const t = value(await host.call('threads.get', { id }));
      if (!t.summary.running && t.turns.at(-1)?.status !== 'running') return t;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('The turn did not settle.');
  }, "packages/platform/test/sql-v08-host-sql.ts settled");
}
const send = async (host: V08Host, projectId: string, clientKey: string, threadId?: string) =>
  value(await host.call('turns.send', { threadId, projectId, text: 'Write a brief from this.', attachments: [], settings, clientKey }));
const attemptsOf = async (workspace: string) => (await admin.query('SELECT status, class, tool, operation, cost, target_sha256 AS target, args_sha256 AS args, key FROM app.effect_attempts WHERE workspace_id = $1 ORDER BY id', [workspace])).rows;
const runsOf = async (workspace: string) => (await admin.query('SELECT id, status, fence FROM app.runs WHERE workspace_id = $1 ORDER BY id', [workspace])).rows as { id: string; status: string; fence: string }[];

function spawnChild(s: Awaited<ReturnType<typeof scenario>>, projectId: string, env: Record<string, string>) {
  return spawn(process.execPath, [fileURLToPath(new URL('./crash-v08.ts', import.meta.url)), JSON.stringify({ home: s.home, appUrl: cluster.appUrl, observerUrl: cluster.observerUrl, identityUrl: cluster.identityUrl, binding: s.binding, projectId, leaseMs: LEASE_MS })],
    { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
}

async function kill(s: Awaited<ReturnType<typeof scenario>>, at: string) {
  const host = await s.open();
  const project = value(await host.call('projects.create', { name: 'Killed', kind: 'folder' }));
  await host.close();
  const child = spawnChild(s, project.id, { BACKBONE_CRASH_AT: at });
  let stderr = ''; child.stderr.on('data', (d) => (stderr += d));
  const signal = await new Promise((resolve) => child.once('exit', (_c, sig) => resolve(sig)));
  assert.equal(signal, 'SIGKILL', `the child was not killed at ${at}: ${stderr}`);
  return project.id;
}
async function recovered(s: Awaited<ReturnType<typeof scenario>>) {
  const host = await s.open();
  const [summary] = await host.call('threads.list', {});
  const thread = await settled(host, summary.id);
  return { host, thread, turn: thread.turns.at(-1)! };
}

test('a thread forms its contract, admits a run and writes through the door', { timeout: TEST_HANG_MS * 2 }, async () => {
  const s = await scenario();
  const host = await s.open();
  const project = value(await host.call('projects.create', { name: 'First', kind: 'folder' }));
  const { threadId } = await send(host, project.id, 'first');
  const thread = await settled(host, threadId);
  const turn = thread.turns[0];
  assert.equal(turn.status, 'done');
  assert.deepEqual(turn.effects.map((e) => [e.target, e.outcome]), [['brief.md', 'DONE']]);
  assert.equal((await host.call('material.list', { projectId: project.id })).map((e) => `${e.name} v${e.current}`).join(), 'brief.md v1');
  const [attempt, ...more] = await attemptsOf(s.binding.workspaceId);
  assert.equal(more.length, 0);
  // The door assigned these; the turn only named a file. No name reaches the kernel.
  assert.deepEqual([attempt.status, attempt.class, attempt.tool, attempt.operation, Number(attempt.cost)], ['executed', 'document', 'workspace', 'write_document', 1]);
  for (const digest of [attempt.target, attempt.args, attempt.key]) assert.match(digest, /^[0-9a-f]{64}$/);
  assert.deepEqual((await runsOf(s.binding.workspaceId)).map((r) => r.status), ['finished'], 'it did what it said, with nothing open');
  await host.close();
});

test('killed before any attempt: nothing was written, and the target stays free', { timeout: TEST_HANG_MS * 2 }, async () => {
  const s = await scenario();
  const projectId = await kill(s, 'write.custodied');
  assert.equal((await attemptsOf(s.binding.workspaceId)).length, 0);
  const { host, thread, turn } = await recovered(s);
  assert.equal(turn.status, 'stopped');
  assert.match(turn.answer?.text ?? '', /nothing was written/i);
  assert.deepEqual((await runsOf(s.binding.workspaceId)).map((r) => r.status), ['cancelled'], 'only a closed run proves no proposal can still land');
  await send(host, projectId, 'again', thread.summary.id);
  assert.equal((await settled(host, thread.summary.id)).turns.at(-1)?.status, 'done');
  await host.close();
});

for (const point of ['write.attempted', 'write.claimed']) {
  test(`killed at ${point}: the attempt is denied, never dispatched and never resumed`, { timeout: TEST_HANG_MS * 2 }, async () => {
    const s = await scenario();
    const projectId = await kill(s, point);
    const { host, turn } = await recovered(s);
    assert.equal(turn.status, 'stopped');
    assert.deepEqual(turn.effects.map((e) => e.outcome), ['REFUSED']);
    assert.deepEqual((await attemptsOf(s.binding.workspaceId)).map((a) => a.status), ['denied']);
    assert.equal((await host.call('material.list', { projectId })).length, 0);
    await host.close();
  });
}

test('killed after dispatch began with no bytes: UNKNOWN, held, and never resent across restarts', { timeout: TEST_HANG_MS * 2 }, async () => {
  const s = await scenario();
  const projectId = await kill(s, 'write.begun');
  const first = await recovered(s);
  assert.equal(first.turn.status, 'stopped');
  assert.deepEqual(first.turn.effects.map((e) => e.outcome), ['UNKNOWN']);
  assert.match(first.turn.answer?.text ?? '', /interrupted/i);
  assert.deepEqual((await attemptsOf(s.binding.workspaceId)).map((a) => a.status), ['unknown']);
  await first.host.close();
  const second = await recovered(s);
  assert.deepEqual(second.turn.effects.map((e) => e.outcome), ['UNKNOWN']);
  assert.equal((await second.host.call('material.list', { projectId })).length, 0, 'not resent');
  // The same target from a new turn is refused by the kernel, across the whole workspace.
  await send(second.host, projectId, 'again', second.thread.summary.id);
  const after = (await settled(second.host, second.thread.summary.id)).turns.at(-1)!;
  assert.deepEqual(after.effects.map((e) => e.outcome), ['REFUSED']);
  assert.match(after.effects[0].detail ?? '', /UNKNOWN/);
  assert.equal((await second.host.call('material.list', { projectId })).length, 0);
  assert.deepEqual((await attemptsOf(s.binding.workspaceId)).map((a) => a.status), ['unknown'], 'the kernel refused it before any row');
  // Another target goes through: the hold is the target's, not the workspace's.
  const other = value(await second.host.call('projects.create', { name: 'Other', kind: 'folder' }));
  const elsewhere = await send(second.host, other.id, 'other');
  assert.equal((await settled(second.host, elsewhere.threadId)).turns.at(-1)?.status, 'done');
  await second.host.close();
});

test('killed after the bytes landed: inspection reconciles it, once, from what it found', { timeout: TEST_HANG_MS * 2 }, async () => {
  const s = await scenario();
  const projectId = await kill(s, 'write.materialised');
  const { host, turn } = await recovered(s);
  assert.deepEqual(turn.effects.map((e) => e.outcome), ['DONE']);
  assert.equal(turn.status, 'stopped', 'the work finished, the turn did not');
  assert.match(turn.answer?.text ?? '', /interrupted/i);
  assert.deepEqual((turn.answer?.files ?? []).map((f) => f.name), ['brief.md']);
  const [entry, ...others] = (await host.call('material.list', { projectId }));
  assert.equal(others.length, 0);
  assert.equal(entry.versions.length, 1, 'one version, not a resend');
  const { rows } = await admin.query('SELECT status, reconciliation_sha256 AS seen FROM app.effect_attempts WHERE workspace_id = $1', [s.binding.workspaceId]);
  assert.equal(rows[0].status, 'executed');
  assert.equal(rows[0].seen, entry.versions[0].sha256);
  await host.close();
});

test('killed after settling, before the turn saved: recovery keeps the receipt and closes the run', { timeout: TEST_HANG_MS * 2 }, async () => {
  const s = await scenario();
  const projectId = await kill(s, 'write.settled');
  const onDisk = JSON.parse(readFileSync(join(s.home, 'threads', readdirSync(join(s.home, 'threads'))[0]), 'utf8'));
  assert.equal(onDisk.turns.at(-1).status, 'running', 'the kill came before the saved turn knew');
  const { host, turn } = await recovered(s);
  assert.deepEqual(turn.effects.map((e) => e.outcome), ['DONE']);
  assert.equal(turn.status, 'stopped', 'the write finished, the turn did not');
  assert.deepEqual((turn.answer?.files ?? []).map((f) => f.name), ['brief.md']);
  const { rows } = await admin.query('SELECT status, reconciliation_sha256 AS seen FROM app.effect_attempts WHERE workspace_id = $1', [s.binding.workspaceId]);
  assert.deepEqual([rows[0].status, rows[0].seen], ['executed', null], 'its own settle, not a reconciliation');
  assert.equal((await host.call('material.list', { projectId }))[0].versions.length, 1);
  assert.deepEqual((await runsOf(s.binding.workspaceId)).map((r) => r.status), ['cancelled']);
  await host.close();
});

test('killed after the turn saved: restart only closes the run', { timeout: TEST_HANG_MS * 2 }, async () => {
  const s = await scenario();
  await kill(s, 'turn.finished');
  assert.deepEqual((await runsOf(s.binding.workspaceId)).map((r) => r.status), ['running']);
  const { host, turn } = await recovered(s);
  assert.equal(turn.status, 'done');
  await pollUntil(async active => { while (active() && ((await runsOf(s.binding.workspaceId))[0].status === 'running')) await new Promise((r) => setTimeout(r, 20)); }, "packages/platform/test/sql-v08-host-sql.ts:205 polling state");
  assert.deepEqual((await runsOf(s.binding.workspaceId)).map((r) => r.status), ['cancelled']);
  await host.close();
});

test('recovery needs no person session: the door closes the dead run and says what happened', { timeout: TEST_HANG_MS * 2 }, async () => {
  const s = await scenario();
  await kill(s, 'write.custodied');
  let calls = 0;
  const real = fixtureSessions(cluster.adminUrl, s.binding);
  const host = await s.open({ sessions: { current: async () => (++calls > 2 ? { status: 'required' as const } : real.current()) } });
  const [summary] = await host.call('threads.list', {});
  const turn = (await settled(host, summary.id)).turns.at(-1)!;
  assert.equal(turn.status, 'stopped');
  assert.match(turn.answer?.text ?? '', /nothing was written/i);
  assert.deepEqual((await runsOf(s.binding.workspaceId)).map((r) => r.status), ['cancelled']);
  await host.close();
});

test('Stop before dispatch denies the attempt and the run stays closed after restart', { timeout: TEST_HANG_MS * 2 }, async () => {
  let release!: () => void; let reached!: () => void;
  const atClaim = new Promise<void>((r) => (reached = r)); const gate = new Promise<void>((r) => (release = r));
  const s = await scenario({ pause: async (point) => { if (point === 'write.claimed') { reached(); await gate; } } });
  const host = await s.open();
  const project = value(await host.call('projects.create', { name: 'Stopped', kind: 'folder' }));
  const { threadId } = await send(host, project.id, 'stop');
  await atClaim;
  const stopping = host.call('turns.stop', { threadId });
  await pollUntil(async active => { while (active() && ((await runsOf(s.binding.workspaceId))[0].status !== 'cancelled')) await new Promise((r) => setTimeout(r, 20)); }, "packages/platform/test/sql-v08-host-sql.ts:233 polling state");
  assert.equal((await runsOf(s.binding.workspaceId))[0].status, 'cancelled', 'Stop closes the run while the write still holds the home lock');
  release();
  assert.equal(value(await stopping).stopped, true);
  const turn = (await settled(host, threadId)).turns.at(-1)!;
  assert.equal(turn.status, 'stopped');
  assert.deepEqual(turn.effects.map((e) => e.outcome), ['REFUSED']);
  assert.deepEqual((await attemptsOf(s.binding.workspaceId)).map((a) => a.status), ['denied']);
  await host.close();
  const again = await s.open();
  const restarted = await settled(again, threadId);
  assert.equal(restarted.turns.at(-1)?.status, 'stopped');
  assert.equal((await again.call('material.list', { projectId: project.id })).length, 0);
  assert.equal((await runsOf(s.binding.workspaceId)).length, 1, 'no new run');
  await again.close();
});

test('a Stop whose close is still on its way binds the dispatch all the same', { timeout: TEST_HANG_MS * 2 }, async () => {
  let release!: () => void; let reached!: () => void; let slow = false;
  const atClaim = new Promise<void>((r) => (reached = r)); const gate = new Promise<void>((r) => (release = r));
  const s = await scenario({ pause: async (point) => { if (point === 'write.claimed') { reached(); await gate; } } });
  const real = fixtureSessions(cluster.adminUrl, s.binding);
  const host = await s.open({ sessions: { current: async () => { if (slow) await new Promise((r) => setTimeout(r, 300)); return real.current(); } } });
  const project = value(await host.call('projects.create', { name: 'Slow close', kind: 'folder' }));
  const { threadId } = await send(host, project.id, 'stop');
  await atClaim;
  slow = true;
  const stopping = host.call('turns.stop', { threadId });
  release();
  await stopping;
  const turn = (await settled(host, threadId)).turns.at(-1)!;
  assert.deepEqual(turn.effects.map((e) => e.outcome), ['REFUSED']);
  assert.deepEqual((await attemptsOf(s.binding.workspaceId)).map((a) => a.status), ['denied'], 'it never began');
  await host.close();
});

test('Stop during dispatch leaves UNKNOWN, and restart resends nothing', { timeout: TEST_HANG_MS * 2 }, async () => {
  const s = await scenario({ writeDelayMs: 60_000 });
  const host = await s.open();
  const project = value(await host.call('projects.create', { name: 'Mid write', kind: 'folder' }));
  const { threadId } = await send(host, project.id, 'stop');
  await pollUntil(async active => { while (active() && ((await attemptsOf(s.binding.workspaceId))[0]?.status !== 'dispatching')) await new Promise((r) => setTimeout(r, 20)); }, "packages/platform/test/sql-v08-host-sql.ts:274 polling state");
  value(await host.call('turns.stop', { threadId }));
  const turn = (await settled(host, threadId)).turns.at(-1)!;
  assert.equal(turn.status, 'stopped');
  assert.deepEqual(turn.effects.map((e) => e.outcome), ['UNKNOWN']);
  await host.close();
  const again = await s.open({ writeDelayMs: 0 });
  const restarted = await settled(again, threadId);
  assert.deepEqual(restarted.turns.at(-1)?.effects.map((e) => e.outcome), ['UNKNOWN']);
  assert.equal((await again.call('material.list', { projectId: project.id })).length, 0);
  const [row, ...more] = await attemptsOf(s.binding.workspaceId);
  assert.equal(more.length, 0); assert.equal(row.status, 'unknown');
  const [run] = await runsOf(s.binding.workspaceId);
  const stale = await s.runtime.door.attempt({ run: run.id, fence: Number(run.fence) - 1, secret: 'stale' }, { class: 'document', tool: 'workspace', operation: 'write_document', target: 'a'.repeat(64), args: 'b'.repeat(64), key: 'c'.repeat(64), cost: 1 });
  assert.equal(stale.status, 'denied');
  await again.close();
});

test('a stale fence is refused on a live run, and the fence alone decides it', { timeout: TEST_HANG_MS * 2 }, async () => {
  let release!: () => void; let reached!: () => void;
  const atClaim = new Promise<void>((r) => (reached = r)); const gate = new Promise<void>((r) => (release = r));
  const s = await scenario({ pause: async (point) => { if (point === 'write.claimed') { reached(); await gate; } } });
  const host = await s.open();
  const project = value(await host.call('projects.create', { name: 'Fence', kind: 'folder' }));
  const { threadId } = await send(host, project.id, 'fence');
  await atClaim;
  const [run] = await runsOf(s.binding.workspaceId);
  assert.equal(run.status, 'running');
  const made = { class: 'document', tool: 'workspace', operation: 'write_document', target: 'a'.repeat(64), args: 'b'.repeat(64), key: 'c'.repeat(64), cost: 1 } as const;
  const fence = Number(run.fence);
  assert.equal((await s.runtime.door.attempt({ run: run.id, fence: fence + 1, secret: 'unused' }, made)).status, 'denied');
  assert.equal((await s.runtime.door.attempt({ run: run.id, fence, secret: 'unused' }, made)).status, 'committed', 'the same request at the live fence goes in');
  release();
  await settled(host, threadId);
  await host.close();
});

/** The real commit happens and its acknowledgement is lost, once, on the named door call. */
function losing(pool: SqlPool, call: string): SqlPool & { armed: boolean } {
  const lossy = { armed: true, connect: async (): Promise<SqlClient> => {
    const client = await pool.connect();
    let hit = false;
    return { release: (error) => client.release(error), query: async (sql, values) => {
      if (lossy.armed && sql.includes(call)) hit = true;
      const result = await client.query(sql, values);
      if (hit && sql === 'COMMIT') { lossy.armed = false; hit = false; throw new Error('the connection went away'); }
      return result;
    } };
  } };
  return lossy;
}

test('a lost settle acknowledgement is UNKNOWN in the turn, never a drafted file, and restart reconciles it', { timeout: TEST_HANG_MS * 2 }, async () => {
  const s = await scenario();
  const host = await s.open({ observerPool: losing(observer, 'gov.settle_attempt') });
  const project = value(await host.call('projects.create', { name: 'Lost settle', kind: 'folder' }));
  const { threadId } = await send(host, project.id, 'lost');
  const turn = (await settled(host, threadId)).turns.at(-1)!;
  assert.equal(turn.status, 'stopped');
  assert.deepEqual(turn.effects.map((e) => e.outcome), ['UNKNOWN']);
  assert.match(turn.answer?.text ?? '', /not confirmed/i);
  assert.doesNotMatch(turn.answer?.text ?? '', /drafted/i);
  assert.equal(turn.completed, undefined);
  await host.close();
  // The turn is already stopped, so recovery rewrites it after the host answers.
  const again = await s.open();
  const effects = async () => value(await again.call('threads.get', { id: threadId })).turns.at(-1)!.effects.map((e) => e.outcome);
  await pollUntil(async active => { while (active() && ((await effects())[0] !== 'DONE')) await new Promise((r) => setTimeout(r, 20)); }, "packages/platform/test/sql-v08-host-sql.ts:341 polling state");
  assert.deepEqual(await effects(), ['DONE']);
  await again.close();
});

test('a lost begin acknowledgement is swept at restart though the turn had stopped, and holds its target', { timeout: TEST_HANG_MS * 2 }, async () => {
  const s = await scenario();
  const host = await s.open({ observerPool: losing(observer, 'gov.begin_attempt') });
  const project = value(await host.call('projects.create', { name: 'Lost begin', kind: 'folder' }));
  const { threadId } = await send(host, project.id, 'lost');
  assert.equal((await settled(host, threadId)).turns.at(-1)?.status, 'stopped');
  assert.deepEqual((await attemptsOf(s.binding.workspaceId)).map((a) => a.status), ['dispatching']);
  await host.close();
  const { host: again } = await recovered(s);
  await pollUntil(async active => { while (active() && ((await attemptsOf(s.binding.workspaceId))[0].status === 'dispatching')) await new Promise((r) => setTimeout(r, 20)); }, "packages/platform/test/sql-v08-host-sql.ts:355 polling state");
  assert.deepEqual((await attemptsOf(s.binding.workspaceId)).map((a) => a.status), ['unknown']);
  await send(again, project.id, 'retry', threadId);
  const retry = (await settled(again, threadId)).turns.at(-1)!;
  assert.deepEqual(retry.effects.map((e) => e.outcome), ['REFUSED']);
  assert.equal((await again.call('material.list', { projectId: project.id })).length, 0);
  await again.close();
});

test('a dispatching row holds its target in the same process, before any sweep can reach it', { timeout: TEST_HANG_MS * 2 }, async () => {
  const s = await scenario({ dispatchLeaseMs: 30_000 });
  const host = await s.open({ observerPool: losing(observer, 'gov.begin_attempt') });
  const project = value(await host.call('projects.create', { name: 'Held', kind: 'folder' }));
  const { threadId } = await send(host, project.id, 'lost');
  await settled(host, threadId);
  await send(host, project.id, 'retry', threadId);
  const retry = (await settled(host, threadId)).turns.at(-1)!;
  assert.deepEqual(retry.effects.map((e) => e.outcome), ['REFUSED']);
  assert.equal((await host.call('material.list', { projectId: project.id })).length, 0);
  assert.deepEqual((await attemptsOf(s.binding.workspaceId)).map((a) => a.status), ['dispatching']);
  await host.close();
});

test('a second host cannot open a home whose owner is alive, even one stopped by the system', { timeout: TEST_HANG_MS * 2 }, async () => {
  const s = await scenario();
  const opened = await s.open();
  const project = value(await opened.call('projects.create', { name: 'Owned', kind: 'folder' }));
  await assert.rejects(s.open(), /in use|another process/i, 'a live host in this process');
  await opened.close();
  const child = spawnChild(s, project.id, { BACKBONE_V08_WRITE_DELAY_MS: '60000' });
  await pollUntil(async active => { while (active() && ((await attemptsOf(s.binding.workspaceId))[0]?.status !== 'dispatching')) await new Promise((r) => setTimeout(r, 25)); }, "packages/platform/test/sql-v08-host-sql.ts:385 polling state");
  assert.equal((await attemptsOf(s.binding.workspaceId))[0]?.status, 'dispatching');
  child.kill('SIGSTOP');
  await assert.rejects(s.open(), /in use|another process/i, 'a paused owner is not a dead one');
  assert.deepEqual((await runsOf(s.binding.workspaceId)).map((r) => r.status), ['running'], 'and its run was not closed under it');
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
  const { host, turn } = await recovered(s);
  assert.deepEqual(turn.effects.map((e) => e.outcome), ['UNKNOWN']);
  await host.close();
});

test('a run closed from outside before the last check stops the bytes', { timeout: TEST_HANG_MS * 2 }, async () => {
  let release!: () => void; let reached!: () => void;
  const atBegun = new Promise<void>((r) => (reached = r)); const gate = new Promise<void>((r) => (release = r));
  const s = await scenario({ pause: async (point) => { if (point === 'write.begun') { reached(); await gate; } } });
  const host = await s.open();
  const project = value(await host.call('projects.create', { name: 'Closed outside', kind: 'folder' }));
  const { threadId } = await send(host, project.id, 'outside');
  await atBegun;
  const [run] = await runsOf(s.binding.workspaceId);
  committed(await s.runtime.person.cancel(run.id));
  release();
  const turn = (await settled(host, threadId)).turns.at(-1)!;
  assert.deepEqual(turn.effects.map((e) => e.outcome), ['REFUSED']);
  assert.equal((await host.call('material.list', { projectId: project.id })).length, 0, 'no bytes after the close');
  assert.deepEqual((await attemptsOf(s.binding.workspaceId)).map((a) => a.status), ['failed']);
  await host.close();
});

test('a home names one kernel and one database', { timeout: TEST_HANG_MS * 2 }, async () => {
  const s = await scenario();
  await (await s.open()).close();
  // The older host and its core link refuse it, before starting anything.
  assert.throws(() => { createHost({ home: s.home }).close(); }, /kernel/i);
  await assert.rejects(CoreLink.open({ home: s.home }), /kernel/i);
  // A home the older core already holds is refused the other way.
  const older = mkdtempSync(join(tmpdir(), 'backbone-v08-home-')); homes.push(older);
  writeFileSync(join(older, 'core.json'), '{}');
  const refused = createV08Host({ home: older, appPool: app, observerPool: observer, sessions: s.sessions, binding: s.binding });
  await assert.rejects(refused, /kernel|another/i);
  assert.equal(existsSync(join(older, 'kernel.json')), false);
  // The same workspace and person in another database is another record.
  const other = await startV08Cluster();
  const pools = [new pg.Pool({ connectionString: other.appUrl, max: 2 }), new pg.Pool({ connectionString: other.observerUrl, max: 2 }), new pg.Pool({ connectionString: other.identityUrl, max: 2 })];
  try {
    await bootstrapWorkspace(other.adminUrl, 'Other', { workspaceId: s.binding.workspaceId, ownerId: s.binding.personId });
    await assert.rejects(createV08Host({ home: s.home, appPool: pools[0], observerPool: pools[1], sessions: presentPersonSessions({ binding: s.binding, mint: identityMint(pools[2], s.binding), presence: scriptedPresence() }), binding: s.binding }), /database/i);
  } finally { await Promise.allSettled(pools.map((p) => p.end())); await other.stop(); }
  // A refusal leaves the owner free for the right one.
  await (await s.open()).close();
});

test('unreadable custody never says nothing was written; the task\'s attempts decide', { timeout: TEST_HANG_MS * 2 }, async () => {
  const s = await scenario();
  await kill(s, 'write.begun');
  const [name] = readdirSync(join(s.home, 'threads'));
  const path = join(s.home, 'threads', name);
  const stored = JSON.parse(readFileSync(path, 'utf8'));
  const [key] = Object.keys(stored.writeCustody.writes);
  stored.writeCustody.writes[key].digest = '0'.repeat(64);
  writeFileSync(path, JSON.stringify(stored));
  const { host, turn } = await recovered(s);
  assert.doesNotMatch(turn.answer?.text ?? '', /nothing was written/i);
  assert.deepEqual(turn.effects.map((e) => e.outcome), ['UNKNOWN']);
  await host.close();
});

test('absent custody says unsure, not nothing was written', { timeout: TEST_HANG_MS * 2 }, async () => {
  const s = await scenario();
  await kill(s, 'write.custodied');
  const [name] = readdirSync(join(s.home, 'threads'));
  const path = join(s.home, 'threads', name);
  const stored = JSON.parse(readFileSync(path, 'utf8'));
  delete stored.writeCustody;
  writeFileSync(path, JSON.stringify(stored));
  const { host, turn } = await recovered(s);
  assert.equal(turn.status, 'stopped');
  assert.doesNotMatch(turn.answer?.text ?? '', /nothing was written/i);
  assert.match(turn.answer?.text ?? '', /unsure/i);
  await host.close();
});

test('killed between the private version and the folder: recovery finishes the projection', { timeout: TEST_HANG_MS * 2 }, async () => {
  const s = await scenario();
  const projectId = await kill(s, 'write.projecting');
  const projects = JSON.parse(readFileSync(join(s.home, 'projects.json'), 'utf8')) as { id: string; dir: string }[];
  const inFolder = join(s.home, 'projects', projects.find((p) => p.id === projectId)!.dir, 'brief.md');
  assert.equal(existsSync(inFolder), false);
  const { host, turn } = await recovered(s);
  assert.deepEqual(turn.effects.map((e) => e.outcome), ['DONE']);
  assert.equal(existsSync(inFolder), true, 'a file the person can open');
  const [entry] = await host.call('material.list', { projectId });
  assert.equal(readFileSync(inFolder, 'utf8'), Buffer.from(value(await host.call('material.read', { id: entry.id })).text!).toString());
  await host.close();
});

const folderOf = (s: Awaited<ReturnType<typeof scenario>>, projectId: string) => {
  const projects = JSON.parse(readFileSync(join(s.home, 'projects.json'), 'utf8')) as { id: string; dir: string }[];
  return join(s.home, 'projects', projects.find((p) => p.id === projectId)!.dir);
};
const reached = async (child: ReturnType<typeof spawnChild>) => assert.equal(await new Promise((resolve) => child.once('exit', (_c, sig) => resolve(sig))), 'SIGKILL');
const statusesOf = async (s: Awaited<ReturnType<typeof scenario>>) => (await attemptsOf(s.binding.workspaceId)).map((a) => a.status);

test('killed again between the folder copy and the reconcile: the hold stands until both are done', { timeout: TEST_HANG_MS * 2 }, async () => {
  const s = await scenario();
  const projectId = await kill(s, 'write.projecting');
  await reached(spawnChild(s, projectId, { BACKBONE_CRASH_AT: 'recover.projected' }));
  assert.deepEqual(await statusesOf(s), ['unknown'], 'the kill came before the reconcile');
  const { host, turn } = await recovered(s);
  assert.deepEqual(turn.effects.map((e) => e.outcome), ['DONE']);
  assert.deepEqual(await statusesOf(s), ['executed']);
  await host.close();
});

test('a different file in the folder is kept, and neither DONE nor a release follows', { timeout: TEST_HANG_MS * 2 }, async () => {
  const s = await scenario();
  const projectId = await kill(s, 'write.projecting');
  const inFolder = join(folderOf(s, projectId), 'brief.md');
  mkdirSync(folderOf(s, projectId), { recursive: true });
  writeFileSync(inFolder, 'the person wrote this');
  const { host, thread, turn } = await recovered(s);
  assert.deepEqual(turn.effects.map((e) => e.outcome), ['UNKNOWN']);
  assert.match(turn.effects[0].detail ?? '', /different file/i);
  assert.equal(turn.status, 'stopped');
  assert.deepEqual(await statusesOf(s), ['unknown']);
  assert.equal(readFileSync(inFolder, 'utf8'), 'the person wrote this');
  await send(host, projectId, 'retry', thread.summary.id);
  assert.deepEqual((await settled(host, thread.summary.id)).turns.at(-1)?.effects.map((e) => e.outcome), ['REFUSED']);
  await host.close();
});

test('an attempt custody does not name is evidence, though custody still names the run', { timeout: TEST_HANG_MS * 2 }, async () => {
  const s = await scenario();
  const projectId = await kill(s, 'write.begun');
  const [name] = readdirSync(join(s.home, 'threads'));
  const path = join(s.home, 'threads', name);
  const before = JSON.parse(readFileSync(path, 'utf8'));
  const [key] = Object.keys(before.writeCustody.writes);
  const original = before.writeCustody.writes[key];
  await retainOriginalWrite(s.home, before.summary.id, original.run, original.turn, projectId, { ...original.target, name: 'other.md' });
  const stored = JSON.parse(readFileSync(path, 'utf8'));
  delete stored.writeCustody.writes[key];
  writeFileSync(path, JSON.stringify(stored));
  const { host, turn } = await recovered(s);
  assert.doesNotMatch(turn.answer?.text ?? '', /nothing was written/i);
  assert.deepEqual(turn.effects.map((e) => e.outcome), ['UNKNOWN']);
  await host.close();
});

/** Every claim on this pool is refused by the database, as a persistent fault would be. */
const refusingClaims = (pool: SqlPool): SqlPool => ({ connect: async () => {
  const client = await pool.connect();
  return { release: (error) => client.release(error), query: async (sql, values) => {
    if (sql.includes('gov.claim_attempt')) throw Object.assign(new Error('refused'), { code: '23514' });
    return client.query(sql, values);
  } };
} });

// A close ends what was waiting and a sweep ends a lapsed claim, so recovery claims nothing and the target is free.
for (const [point, dispatchLeaseMs] of [['write.attempted', 60_000], ['write.claimed', LEASE_MS]] as const) {
  test(`a killed write at ${point} is ended by its close, with nothing sent and no claim needed`, { timeout: TEST_HANG_MS * 2 }, async () => {
    const s = await scenario();
    const projectId = await kill(s, point);
    const host = await s.open({ observerPool: refusingClaims(observer), dispatchLeaseMs });
    const [summary] = await host.call('threads.list', {});
    const thread = await settled(host, summary.id);
    assert.deepEqual(thread.turns[0].effects.map((e) => e.outcome), ['REFUSED']);
    assert.equal((await host.call('material.list', { projectId })).length, 0);
    assert.deepEqual(await statusesOf(s), ['denied']);
    await host.close();
  });
}

test('close returns from a write that never ends, and keeps the home until it does', { timeout: TEST_HANG_MS * 2 }, async () => {
  let release!: () => void; let arrived!: () => void;
  const atClaim = new Promise<void>((r) => (arrived = r)); const gate = new Promise<void>((r) => (release = r));
  const s = await scenario({ pause: async (point) => { if (point === 'write.claimed') { arrived(); await gate; } } });
  const host = await s.open();
  const project = value(await host.call('projects.create', { name: 'Hung', kind: 'folder' }));
  await send(host, project.id, 'hung');
  await atClaim;
  await host.close();
  await assert.rejects(s.open(), /in use/i, 'a write is still out, so the owner stays');
  release();
});

test('a malformed thread fails the open and leaves the home free', { timeout: TEST_HANG_MS * 2 }, async () => {
  const s = await scenario();
  await (await s.open()).close();
  const bad = join(s.home, 'threads', 'bad.json');
  writeFileSync(bad, '{');
  await assert.rejects(s.open(), SyntaxError);
  rmSync(bad);
  await (await s.open()).close();
});

for (const [point, outcome, bytes, status] of [['write.landing', 'REFUSED', 0, 'failed'], ['write.landed', 'UNKNOWN', 1, 'unknown']] as const) {
  test(`the home lock lost at ${point}: ${outcome}`, { timeout: TEST_HANG_MS * 2 }, async () => {
    let release!: () => void; let arrived!: () => void;
    const at = new Promise<void>((r) => (arrived = r)); const gate = new Promise<void>((r) => (release = r));
    const s = await scenario({ pause: async (p) => { if (p === point) { arrived(); await gate; } } });
    const host = await s.open();
    const project = value(await host.call('projects.create', { name: 'Lock lost', kind: 'folder' }));
    const { threadId } = await send(host, project.id, 'lost');
    await at;
    rmSync(join(s.home, '.lock'), { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 3_500));
    release();
    const turn = (await settled(host, threadId)).turns.at(-1)!;
    assert.deepEqual(turn.effects.map((e) => e.outcome), [outcome]);
    assert.equal((await host.call('material.list', { projectId: project.id })).length, bytes);
    assert.deepEqual(await statusesOf(s), [status]);
    await host.close();
  });
}

test('a write waits at its dispatch without holding the home', { timeout: TEST_HANG_MS * 2 }, async () => {
  let release!: () => void; let arrived!: () => void;
  const atClaim = new Promise<void>((r) => (arrived = r)); const gate = new Promise<void>((r) => (release = r));
  const s = await scenario({ pause: async (point) => { if (point === 'write.claimed') { arrived(); await gate; } } });
  const host = await s.open();
  const project = value(await host.call('projects.create', { name: 'Unheld', kind: 'folder' }));
  const { threadId } = await send(host, project.id, 'unheld');
  await atClaim;
  const read = await Promise.race([host.call('material.list', { projectId: project.id }).then(() => 'read'), new Promise((r) => setTimeout(() => r('blocked'), 1_000))]);
  release();
  assert.equal(read, 'read');
  await settled(host, threadId);
  await host.close();
});

test('the older core opens no home the v0.8 host holds, and claims one it opens', { timeout: TEST_HANG_MS * 2 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'backbone-v08-home-')); homes.push(home);
  const link = await CoreLink.open({ home, keys: plaintextKeys() });
  await link.close();
  assert.equal(JSON.parse(readFileSync(join(home, 'kernel.json'), 'utf8')).kernel, 'core');
  const s = await scenario();
  await assert.rejects(createV08Host({ home, appPool: app, observerPool: observer, sessions: s.sessions, binding: s.binding }), /core kernel/i);
});

const gated = () => { let release!: () => void; const gate = new Promise<void>((r) => (release = r)); return { gate, release }; };

test('close waits for a send paused before its run, then refuses every later call', { timeout: TEST_HANG_MS * 2 }, async () => {
  const s = await scenario();
  const real = fixtureSessions(cluster.adminUrl, s.binding);
  const { gate, release } = gated(); let hold = false; let reached!: () => void;
  const atSession = new Promise<void>((r) => (reached = r));
  const host = await s.open({ sessions: { current: async () => { if (hold) { reached(); await gate; } return real.current(); } } });
  const project = value(await host.call('projects.create', { name: 'Closing', kind: 'folder' }));
  hold = true;
  const sending = host.call('turns.send', { projectId: project.id, text: 'Write a brief from this.', attachments: [], settings, clientKey: 'closing' });
  await atSession;
  const closing = host.close();
  await assert.rejects(s.open(), /in use/i, 'the send can still write, so the owner stays');
  release();
  await closing;
  await sending.catch(() => {});
  const late = await host.call('threads.list', {}) as unknown as { ok: boolean };
  assert.equal(late.ok, false);
  await (await s.open()).close();
});

const later = (s: Awaited<ReturnType<typeof scenario>>, projectId: string) => {
  const store = new MaterialStore(s.home, {}, () => {});
  const [entry] = store.list(projectId, true);
  return store.save(entry.id, 'a later version', 1, 'person');
};

test('a later version answers for the folder: its copy is finished before the hold lifts', { timeout: TEST_HANG_MS * 2 }, async () => {
  const s = await scenario();
  const projectId = await kill(s, 'write.projecting');
  assert.equal((await later(s, projectId)).ok, true);
  const { host, turn } = await recovered(s);
  assert.deepEqual(turn.effects.map((e) => e.outcome), ['DONE']);
  assert.deepEqual(await statusesOf(s), ['executed']);
  assert.equal(readFileSync(join(folderOf(s, projectId), 'brief.md'), 'utf8'), 'a later version');
  await host.close();
});

test('a later version with a different file in the folder keeps the file and the hold', { timeout: TEST_HANG_MS * 2 }, async () => {
  const s = await scenario();
  const projectId = await kill(s, 'write.projecting');
  assert.equal((await later(s, projectId)).ok, true);
  mkdirSync(folderOf(s, projectId), { recursive: true });
  writeFileSync(join(folderOf(s, projectId), 'brief.md'), 'the person wrote this');
  const { host, turn } = await recovered(s);
  assert.deepEqual(turn.effects.map((e) => e.outcome), ['UNKNOWN']);
  assert.deepEqual(await statusesOf(s), ['unknown']);
  assert.equal(readFileSync(join(folderOf(s, projectId), 'brief.md'), 'utf8'), 'the person wrote this');
  await host.close();
});

for (const [name, lose, outcome, status] of [['with the lock', false, 'REFUSED', 'failed'], ['having lost the lock', true, 'UNKNOWN', 'unknown']] as const) {
  test(`a write that fails ${name} after it began: ${outcome}`, { timeout: TEST_HANG_MS * 2 }, async () => {
    const { gate, release } = gated(); let arrived!: () => void;
    const at = new Promise<void>((r) => (arrived = r));
    const s = await scenario({ pause: async (p) => { if (p === 'write.performing') { arrived(); await gate; } } });
    const host = await s.open();
    const project = value(await host.call('projects.create', { name: 'Failed write', kind: 'folder' }));
    const { threadId } = await send(host, project.id, 'failed');
    await at;
    const stored = JSON.parse(readFileSync(join(s.home, 'threads', `${threadId}.json`), 'utf8'));
    const [original] = Object.values(stored.writeCustody.writes) as { target: { document: string } }[];
    mkdirSync(join(s.home, 'material', original.target.document), { recursive: true });
    writeFileSync(join(s.home, 'material', original.target.document, 'versions'), 'in the way');
    if (lose) { rmSync(join(s.home, '.lock'), { recursive: true, force: true }); await new Promise((r) => setTimeout(r, 3_500)); }
    release();
    const turn = (await settled(host, threadId)).turns.at(-1)!;
    assert.deepEqual(turn.effects.map((e) => e.outcome), [outcome]);
    assert.deepEqual(await statusesOf(s), [status]);
    await host.close();
  });
}

const dropTask = (s: Awaited<ReturnType<typeof scenario>>) => {
  const [name] = readdirSync(join(s.home, 'threads'));
  const path = join(s.home, 'threads', name);
  const stored = JSON.parse(readFileSync(path, 'utf8'));
  delete stored.task; delete stored.plane;
  writeFileSync(path, JSON.stringify(stored));
  return { path, stored };
};

test('a run custody names is this home\'s, though the thread lost its task', { timeout: TEST_HANG_MS * 2 }, async () => {
  const s = await scenario();
  await kill(s, 'write.begun');
  dropTask(s);
  const { host, turn } = await recovered(s);
  assert.deepEqual(turn.effects.map((e) => e.outcome), ['UNKNOWN']);
  assert.deepEqual((await runsOf(s.binding.workspaceId)).map((r) => r.status), ['cancelled']);
  assert.deepEqual(await statusesOf(s), ['unknown']);
  await host.close();
});

test('a run the kernel does not know is unsure, never nothing was written', { timeout: TEST_HANG_MS * 2 }, async () => {
  const s = await scenario();
  const projectId = await kill(s, 'write.custodied');
  const { path, stored } = dropTask(s);
  const [key] = Object.keys(stored.writeCustody.writes);
  const original = stored.writeCustody.writes[key];
  await retainOriginalWrite(s.home, stored.summary.id, randomUUID(), original.turn, projectId, { ...original.target, name: 'other.md' });
  const again = JSON.parse(readFileSync(path, 'utf8'));
  delete again.writeCustody.writes[key];
  writeFileSync(path, JSON.stringify(again));
  const { host, turn } = await recovered(s);
  assert.doesNotMatch(turn.answer?.text ?? '', /nothing was written/i);
  assert.match(turn.answer?.text ?? '', /unsure/i);
  await host.close();
});

/** Reads of the kernel's rows never answer until released, as a stalled database call would not. */
function stalling(pool: SqlPool, gate: Promise<void>): SqlPool {
  return { connect: async () => {
    const client = await pool.connect();
    return { release: (error) => client.release(error), query: async (sql, values) => {
      if (sql.includes('gov.dump_crossing_rows') || sql.includes('gov.read_attempts')) await gate;
      return client.query(sql, values);
    } };
  } };
}

test('a stalled database call bounds recovery and send, and the attempt stays held and reported', { timeout: TEST_HANG_MS * 2 }, async () => {
  const s = await scenario();
  const projectId = await kill(s, 'write.begun');
  const { gate, release } = gated();
  const host = await s.open({ observerPool: stalling(observer, gate), sqlTimeoutMs: 300 });
  const [summary] = await host.call('threads.list', {});
  const other = value(await host.call('projects.create', { name: 'Elsewhere', kind: 'folder' }));
  const { threadId } = await send(host, other.id, 'elsewhere');
  assert.deepEqual((await settled(host, threadId)).turns.at(-1)?.effects.map((e) => e.outcome), ['REFUSED']);
  const held = value(await host.call('threads.get', { id: summary.id })).turns.at(-1)!;
  assert.equal(held.status, 'running');
  assert.match(held.answer?.text ?? '', /unsure/i);
  await host.close();
  release();
  const again = await s.open();
  const turn = (await settled(again, summary.id)).turns.at(-1)!;
  assert.deepEqual(turn.effects.map((e) => e.outcome), ['UNKNOWN']);
  assert.equal((await again.call('material.list', { projectId })).length, 0);
  await again.close();
});

test('a turn that wrote nothing or was refused says so: only a clean turn finishes its run', { timeout: TEST_HANG_MS * 2 }, async () => {
  const s = await scenario({ dispatchLeaseMs: 30_000 });
  const host = await s.open({ observerPool: losing(observer, 'gov.begin_attempt') });
  const project = value(await host.call('projects.create', { name: 'Refused', kind: 'folder' }));
  const { threadId } = await send(host, project.id, 'lost');
  await settled(host, threadId);
  await send(host, project.id, 'held', threadId);
  const held = (await settled(host, threadId)).turns.at(-1)!;
  assert.deepEqual(held.effects.map((e) => e.outcome), ['REFUSED']);
  assert.match(held.effects[0].detail ?? '', /held/i);
  assert.match(held.effects[0].detail ?? '', /nothing was sent/i);
  assert.deepEqual((await runsOf(s.binding.workspaceId)).map((r) => r.status), ['cancelled', 'cancelled']);
  await host.close();
});

test('a live run with full authority is refused the held target by code, and only that target', { timeout: TEST_HANG_MS * 2 }, async () => {
  const s = await scenario({ dispatchLeaseMs: 30_000 });
  const host = await s.open({ observerPool: losing(observer, 'gov.begin_attempt') });
  const project = value(await host.call('projects.create', { name: 'Code', kind: 'folder' }));
  const { threadId } = await send(host, project.id, 'lost');
  await settled(host, threadId);
  const [row] = await attemptsOf(s.binding.workspaceId);
  const { rows } = await admin.query('SELECT plane_id AS plane, task_id AS task FROM app.runs WHERE workspace_id = $1', [s.binding.workspaceId]);
  const fresh = committed(await s.runtime.person.admitRun({ plane: rows[0].plane, task: rows[0].task }));
  const made = { class: 'document', tool: 'workspace', operation: 'write_document', args: 'b'.repeat(64), cost: 1 } as const;
  assert.deepEqual(await s.runtime.door.attempt(fresh, { ...made, target: row.target, key: 'c'.repeat(64) }), { status: 'denied', code: '55006' });
  assert.equal((await s.runtime.door.attempt(fresh, { ...made, target: 'a'.repeat(64), key: 'd'.repeat(64) })).status, 'committed', 'the same run, on a free target');
  await host.close();
});

test('a turn the kernel will not let finish ends cancelled, and its write stands', { timeout: TEST_HANG_MS * 2 }, async () => {
  const s = await scenario({ pause: async (point) => {
    if (point !== 'write.landed') return;
    const { rows } = await admin.query('SELECT plane_id AS plane FROM app.runs WHERE workspace_id = $1', [s.binding.workspaceId]);
    committed(await s.runtime.person.revokeContract(rows[0].plane));
  } });
  const host = await s.open();
  const project = value(await host.call('projects.create', { name: 'Revoked', kind: 'folder' }));
  const { threadId } = await send(host, project.id, 'revoked');
  const turn = (await settled(host, threadId)).turns.at(-1)!;
  assert.deepEqual(turn.effects.map((e) => e.outcome), ['DONE']);
  await pollUntil(async active => { while (active() && ((await runsOf(s.binding.workspaceId))[0].status === 'running')) await new Promise((r) => setTimeout(r, 20)); }, "packages/platform/test/sql-v08-host-sql.ts:809 polling state");
  assert.deepEqual((await runsOf(s.binding.workspaceId)).map((r) => r.status), ['cancelled']);
  await host.close();
});

test('a contract revoked before the last check lands nothing, though the run still reads running', { timeout: TEST_HANG_MS * 2 }, async () => {
  const s = await scenario({ pause: async (point) => {
    if (point !== 'write.landing') return;
    const { rows } = await admin.query('SELECT plane_id AS plane FROM app.runs WHERE workspace_id = $1', [s.binding.workspaceId]);
    committed(await s.runtime.person.revokeContract(rows[0].plane));
    assert.deepEqual((await runsOf(s.binding.workspaceId)).map((r) => r.status), ['running'], 'a revoke leaves the status alone');
  } });
  const host = await s.open();
  const project = value(await host.call('projects.create', { name: 'Revoked', kind: 'folder' }));
  const { threadId } = await send(host, project.id, 'revoked');
  const turn = (await settled(host, threadId)).turns.at(-1)!;
  assert.notEqual(turn.effects[0].outcome, 'DONE');
  assert.match(turn.effects[0].detail ?? '', /changed before it was written/);
  assert.equal(existsSync(join(folderOf(s, project.id), 'brief.md')), false, 'no bytes');
  await host.close();
});

test('the kernel is asked last: a revoke during the hold check lands nothing', { timeout: TEST_HANG_MS * 2 }, async () => {
  let armed = false; let plane = '';
  const s = await scenario({ pause: async (point) => {
    if (point !== 'write.landing') return;
    plane = (await admin.query('SELECT plane_id AS plane FROM app.runs WHERE workspace_id = $1', [s.binding.workspaceId])).rows[0].plane;
    armed = true;
  } });
  const revoking: SqlPool = { connect: async () => {
    const client = await observer.connect();
    return { release: (error) => client.release(error), query: async (sql, values) => {
      if (armed && sql.includes('pg_locks')) { armed = false; committed(await s.runtime.person.revokeContract(plane)); }
      return client.query(sql, values);
    } };
  } };
  const host = await s.open({ observerPool: revoking });
  const project = value(await host.call('projects.create', { name: 'Revoked', kind: 'folder' }));
  const { threadId } = await send(host, project.id, 'revoked');
  const turn = (await settled(host, threadId)).turns.at(-1)!;
  assert.notEqual(turn.effects[0].outcome, 'DONE');
  assert.equal(existsSync(join(folderOf(s, project.id), 'brief.md')), false, 'no bytes');
  await host.close();
});

/** A turn whose write is held: the contract is narrowed once, after the claim. */
async function heldWrite(presence = scriptedPresence()) {
  let narrowed = false;
  const s = await scenario({ pause: async (point) => {
    if (point !== 'write.claimed' || narrowed) return;
    narrowed = true;
    const { rows } = await admin.query('SELECT plane_id AS plane, task_id AS task FROM app.runs WHERE workspace_id = $1', [s.binding.workspaceId]);
    committed(await s.runtime.person.formContract(rows[0].plane, { purpose: rows[0].task, data: ['project-material'], tools: ['workspace'], destinations: ['write_document'], models: ['stub'], budget: 1_000, ceiling: 1, ttlMs: 60_000, checker: false }));
  } }, presence);
  const host = await s.open();
  const project = value(await host.call('projects.create', { name: 'Narrowed', kind: 'folder' }));
  const { threadId } = await send(host, project.id, 'narrowed');
  let effect = value(await host.call('threads.get', { id: threadId })).turns.at(-1)!.effects[0];
  await pollUntil(async active => {
    while (active() && (!/waits for acceptance/.test(effect?.detail ?? ''))) {
       await new Promise((r) => setTimeout(r, 20));
       effect = value(await host.call('threads.get', { id: threadId })).turns.at(-1)!.effects[0];
     }
  }, "packages/platform/test/sql-v08-host-sql.ts:867 heldWrite");
  assert.match(effect.detail ?? '', /waits for acceptance/);
  assert.deepEqual(await statusesOf(s), ['held']);
  return { s, host, project, threadId, effect };
}

test('a held write goes out only on a confirmed acceptance of the exact statement', { timeout: TEST_HANG_MS * 2 }, async () => {
  const { s, host, project, threadId, effect } = await heldWrite();
  const unconfirmed = await host.decideHeld({ threadId, attempt: effect.key, decision: 'accept', confirmation: { attempt: effect.key, statementSha256: digest('another statement') } });
  assert.equal(unconfirmed.ok, false);
  assert.deepEqual(await statusesOf(s), ['held']);
  assert.equal(existsSync(join(folderOf(s, project.id), 'brief.md')), false, 'no bytes while it waits');
  assert.equal(value(await host.decideHeld({ threadId, attempt: effect.key, decision: 'accept', confirmation: confirmation(effect) })).outcome, 'ACCEPTED');
  const turn = (await settled(host, threadId)).turns.at(-1)!;
  assert.deepEqual(turn.effects.map((e) => e.outcome), ['DONE']);
  assert.deepEqual(await statusesOf(s), ['executed']);
  const { rows } = await admin.query('SELECT accepted_by FROM app.effect_attempts WHERE workspace_id = $1', [s.binding.workspaceId]);
  assert.equal(rows[0].accepted_by, s.binding.personId);
  await host.close();
});

test('a held write refused by its statement sends nothing, and says it was refused', { timeout: TEST_HANG_MS * 2 }, async () => {
  const { s, host, project, threadId, effect } = await heldWrite();
  assert.equal(value(await host.decideHeld({ threadId, attempt: effect.key, decision: 'deny', confirmation: confirmation(effect) })).outcome, 'REFUSED');
  const turn = (await settled(host, threadId)).turns.at(-1)!;
  assert.equal(turn.effects[0].outcome, 'REFUSED');
  assert.match(turn.effects[0].detail ?? '', /was refused/);
  assert.equal(existsSync(join(folderOf(s, project.id), 'brief.md')), false, 'no bytes');
  assert.deepEqual(await statusesOf(s), ['denied']);
  await host.close();
});

test('a held write the person does not confirm in the owner\'s own surface stays held, and the person saw its statement', { timeout: TEST_HANG_MS * 2 }, async () => {
  const asked: PersonRequest[] = [];
  const answers: PresenceAnswer[] = [];
  const { s, host, project, threadId, effect } = await heldWrite({ attests: 'fixture', confirm: async (r) => { asked.push(r); return r.act !== 'accept-held' ? 'confirmed' : answers.shift() ?? 'declined'; } });
  // The renderer's digest matches, but the person, asked by the session owner, says no.
  const declined = await host.decideHeld({ threadId, attempt: effect.key, decision: 'accept', confirmation: confirmation(effect) });
  assert.equal(declined.ok, false);
  assert.deepEqual(await statusesOf(s), ['held']);
  assert.equal(existsSync(join(folderOf(s, project.id), 'brief.md')), false);
  const question = asked.find((r) => r.act === 'accept-held')!;
  assert.ok(question.statement!.startsWith(effect.detail!), 'the exact statement the turn showed');
  const { rows: [row] } = await admin.query('SELECT id, args_sha256 AS args FROM app.effect_attempts WHERE workspace_id = $1', [s.binding.workspaceId]);
  assert.match(question.statement!, /Project Narrowed, file brief\.md, \d+ bytes, content sha256 [0-9a-f]{64}/, 'the project, file and bytes it releases');
  assert.ok(question.statement!.includes(row.id) && question.statement!.includes(row.args), 'and the attempt and arguments SQL executes');
  assert.ok(question.statement!.includes('The content, in full:\n') && question.statement!.length > effect.detail!.length + 200, 'and the content it releases');
  assert.ok(asked.some((r) => r.act === 'form-contract' && /budget 1000/.test(r.statement ?? '')), 'forming the thread\'s contract asked for its terms');
  answers.push('confirmed');
  assert.equal(value(await host.decideHeld({ threadId, attempt: effect.key, decision: 'accept', confirmation: confirmation(effect) })).outcome, 'ACCEPTED');
  await settled(host, threadId);
  assert.deepEqual(await statusesOf(s), ['executed']);
  await host.close();
});

test('a Stop ends the wait on a held write, and its close ends the row', { timeout: TEST_HANG_MS * 2 }, async () => {
  const { s, host, threadId } = await heldWrite();
  value(await host.call('turns.stop', { threadId }));
  const turn = (await settled(host, threadId)).turns.at(-1)!;
  assert.equal(turn.effects[0].outcome, 'REFUSED');
  assert.deepEqual(await statusesOf(s), ['denied']);
  await host.close();
});

test('the owner settles a promotion UNKNOWN past a dead checker, on the exact statement, and a lost ack is told by its digest', { timeout: TEST_HANG_MS * 2 }, async () => {
  const s = await scenario();
  const plane = committed(await s.runtime.person.createPlane('Promotion'));
  const task = committed(await s.runtime.person.createTask(plane, 'Promotion'));
  committed(await s.runtime.person.formContract(plane, { purpose: task, data: ['project-material'], tools: ['workspace'], destinations: ['write_document'], models: ['stub'], budget: 10, ceiling: 2, ttlMs: 60_000, checker: false }));
  const maker = committed(await s.runtime.person.admitRun({ plane, task }));
  const checker = committed(await s.runtime.person.admitRun({ plane, task }));
  const { intent, snapshot } = await crossingRows(cluster.adminUrl, { workspaceId: s.binding.workspaceId, run: maker.run, checkerRun: checker.run });
  committed(await s.runtime.door.recordUnknownCrossing(intent, snapshot, 1));
  const host = await s.open();
  const [unknown] = value(await host.promotionUnknowns());
  assert.equal(unknown.snapshot, snapshot);
  const word = { attempt: snapshot, statementSha256: digest(unknown.statement) };
  const live = await host.settlePromotionUnknown({ ...unknown, observed: 'execution-error', confirmation: word });
  assert.match((live as { detail: string }).detail, /checker may still be live/);
  committed(await s.runtime.door.closeRun(checker.run, checker.fence, 'cancelled'));
  for (const wrong of [undefined, { ...word, statementSha256: digest('other') }, { ...word, attempt: intent }]) {
    const refused = await host.settlePromotionUnknown({ ...unknown, observed: 'execution-error', confirmation: wrong });
    assert.match((refused as { detail: string }).detail, /exact statement/);
  }
  assert.equal(value(await host.promotionUnknowns()).length, 1, 'nothing moved');
  assert.equal((await host.settlePromotionUnknown({ ...unknown, observed: 'approved-executed', confirmation: word })).ok, false, 'no spent verdict');
  await host.close();
  const lossy = await s.open({ appPool: losing(app, 'gov.reconcile_promotion_as_owner') });
  const lost = await lossy.settlePromotionUnknown({ ...unknown, observed: 'execution-error', confirmation: word });
  assert.equal(lost.ok, false);
  const again = value(await lossy.settlePromotionUnknown({ ...unknown, observed: 'execution-error', confirmation: word }));
  assert.match(again.detail, /already recorded as execution-error by a confirmation with these same words/);
  assert.doesNotMatch(again.detail, /You stated/);
  assert.deepEqual(value(await lossy.promotionUnknowns()), []);
  const { rows } = await admin.query('SELECT disposition, reconciled_by, reconciliation_sha256 AS seen FROM app.verifier_attempts WHERE snapshot_id = $1', [snapshot]);
  assert.equal(rows[0].disposition, 'execution-error');
  assert.equal(rows[0].reconciled_by, s.binding.personId);
  assert.match(rows[0].seen, /^[0-9a-f]{64}$/);
  assert.equal((await lossy.settlePromotionUnknown({ ...unknown, observed: 'approved-executed', confirmation: word })).ok, false, 'another word does not replace it');
  await lossy.close();
  // A host whose presence attests a person never takes the fixture's settlement as its own.
  const personal = await s.open({ sessions: presentPersonSessions({ binding: s.binding, mint: identityMint(identity, s.binding), presence: { attests: 'person', confirm: async () => 'confirmed' } }) });
  const theirs = await personal.settlePromotionUnknown({ ...unknown, observed: 'execution-error', confirmation: word });
  assert.equal(theirs.ok, false);
  assert.match((theirs as { detail: string }).detail, /already settled, and not by this confirmation/);
  await personal.close();
});

const stops = (point: string) => { const { gate, release } = gated(); let reached!: () => void; const at = new Promise<void>((r) => (reached = r)); return { at, release, pause: async (p: string) => { if (p === point) { reached(); await gate; } } }; };
/** A real copy of a home, as a backup restore makes one: its threads, tasks and custody, not its owner or any live socket. */
function copyOf(home: string) {
  const copy = mkdtempSync(join(tmpdir(), 'backbone-v08-home-')); homes.push(copy);
  cpSync(home, copy, { recursive: true, filter: (from) => !lstatSync(from).isSocket() && !from.endsWith('.lock') });
  return copy;
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const confirmation = (effect: { key: string; detail?: string }) => ({ attempt: effect.key, statementSha256: digest(effect.detail ?? '') });

test('a copied home cannot open while its dispatcher is past the last check, so it closes nothing', { timeout: TEST_HANG_MS * 2 }, async () => {
  const landing = stops('write.performing');
  const s = await scenario({ pause: landing.pause, dispatchLeaseMs: 300 });
  const live = await s.open();
  const project = value(await live.call('projects.create', { name: 'Copied', kind: 'folder' }));
  const { threadId } = await send(live, project.id, 'first');
  await landing.at;
  const copy = copyOf(s.home);
  assert.ok(Object.keys(JSON.parse(readFileSync(join(copy, 'threads', `${threadId}.json`), 'utf8')).writeCustody.writes).length, 'the copy names the same custody');
  await assert.rejects(s.open({ home: copy, pause: undefined }), /in use/i);
  assert.deepEqual((await runsOf(s.binding.workspaceId)).map((r) => r.status), ['running'], 'its run was not closed');
  assert.deepEqual(await statusesOf(s), ['dispatching'], 'nor swept, nor settled');
  landing.release();
  assert.deepEqual((await settled(live, threadId)).turns.at(-1)?.effects.map((e) => e.outcome), ['DONE']);
  await live.close();
  await (await s.open({ home: copy, pause: undefined })).close();
  assert.deepEqual(await statusesOf(s), ['executed']);
});

test('a second home on the workspace does not open, and opens once the first has gone', { timeout: TEST_HANG_MS * 2 }, async () => {
  const s = await scenario();
  const first = await s.open();
  const other = mkdtempSync(join(tmpdir(), 'backbone-v08-home-')); homes.push(other);
  await assert.rejects(s.open({ home: other }), /in use/i);
  await first.close();
  await (await s.open({ home: other })).close();
});

test('two doors claiming one target together: the kernel lets exactly one begin', { timeout: TEST_HANG_MS * 2 }, async () => {
  const s = await scenario();
  const plane = committed(await s.runtime.person.createPlane('Race'));
  const task = committed(await s.runtime.person.createTask(plane, 'Race'));
  committed(await s.runtime.person.formContract(plane, { purpose: task, data: ['project-material'], tools: ['workspace'], destinations: ['write_document'], models: ['stub'], budget: 10, ceiling: 2, ttlMs: 60_000, checker: false }));
  const made = { class: 'document', tool: 'workspace', operation: 'write_document', target: 'a'.repeat(64), args: 'b'.repeat(64), cost: 1 } as const;
  const start = async (key: string) => {
    const handle = committed(await s.runtime.person.admitRun({ plane, task }));
    const id = committed(await s.runtime.door.attempt(handle, { ...made, key: key.repeat(64) }));
    return { id, claim: committed(await s.runtime.door.claim(id, 30_000))! };
  };
  const [one, two] = [await start('c'), await start('d')];
  assert.equal(committed(await s.runtime.door.begin(one.id, one.claim, made.args, made.target)), true);
  assert.equal(committed(await s.runtime.door.begin(two.id, two.claim, made.args, made.target)), false);
  assert.deepEqual((await statusesOf(s)).sort(), ['attempted', 'dispatching']);
});

test('a host that loses its database hold lands nothing and stops acting', { timeout: TEST_HANG_MS * 2 }, async () => {
  const landing = stops('write.landing');
  const s = await scenario({ pause: landing.pause });
  const host = await s.open();
  const project = value(await host.call('projects.create', { name: 'Dropped', kind: 'folder' }));
  const { threadId } = await send(host, project.id, 'dropped');
  await landing.at;
  const { rows } = await admin.query("SELECT pg_terminate_backend(pid) AS gone FROM pg_locks WHERE locktype = 'advisory' AND granted");
  assert.equal(rows.length, 1, 'one hold is out');
  await pollUntil(async active => { while (active() && ((await host.call('threads.list', {}) as unknown as { ok?: boolean }).ok !== false)) await new Promise((r) => setTimeout(r, 20)); }, "packages/platform/test/sql-v08-host-sql.ts:1042 polling state");
  const late = await host.call('turns.send', { projectId: project.id, text: 'Write a brief from this.', attachments: [], settings, clientKey: 'late' });
  assert.equal(late.ok, false);
  assert.match((late as { detail: string }).detail, /in use|lost|hold/i);
  landing.release();
  await host.close();
  assert.equal(existsSync(join(s.home, 'projects', project.id, 'brief.md')), false, 'no bytes after the hold went');
  assert.notEqual((await statusesOf(s))[0], 'executed');
  assert.deepEqual((await runsOf(s.binding.workspaceId)).map((r) => r.status), ['cancelled']);
});

const failing = (pool: SqlPool, call: string, times = Infinity): SqlPool => { let left = times; return { connect: async () => {
  const client = await pool.connect();
  return { release: (error) => client.release(error), query: async (sql, values) => {
    if (sql.includes(call) && left-- > 0) throw new Error('the connection went away');
    return client.query(sql, values);
  } };
} }; };

test('a close that stays unconfirmed is never reported as stopped or complete', { timeout: TEST_HANG_MS * 2 }, async () => {
  const atBegun = stops('write.claimed');
  const s = await scenario({ pause: atBegun.pause });
  const host = await s.open({ observerPool: failing(observer, 'gov.close_run') });
  const project = value(await host.call('projects.create', { name: 'Unclosed', kind: 'folder' }));
  const { threadId } = await send(host, project.id, 'unclosed');
  await atBegun.at;
  const stopped = value(await host.call('turns.stop', { threadId }));
  assert.equal(stopped.stopped, false, 'the run is still running');
  atBegun.release();
  const turn = (await settled(host, threadId)).turns.at(-1)!;
  assert.equal(turn.status, 'stopped');
  assert.match(turn.answer?.text ?? '', /not confirmed/i);
  assert.deepEqual((await runsOf(s.binding.workspaceId)).map((r) => r.status), ['running']);
  await host.close();
  await (await s.open()).close();
  assert.deepEqual((await runsOf(s.binding.workspaceId)).map((r) => r.status), ['cancelled'], 'restart closes it');
});

test('a clean turn whose close stays unconfirmed does not read as done', { timeout: TEST_HANG_MS * 2 }, async () => {
  const s = await scenario();
  const host = await s.open({ observerPool: failing(observer, 'gov.close_run') });
  const project = value(await host.call('projects.create', { name: 'Unfinished', kind: 'folder' }));
  const { threadId } = await send(host, project.id, 'clean');
  const turn = (await settled(host, threadId)).turns.at(-1)!;
  assert.deepEqual(turn.effects.map((e) => e.outcome), ['DONE']);
  assert.equal(turn.status, 'stopped');
  assert.match(turn.answer?.text ?? '', /not confirmed/i);
  await host.close();
});

test('a close that fails once is tried again, and a lost acknowledgement is read back', { timeout: TEST_HANG_MS * 2 }, async () => {
  for (const pool of [failing(observer, 'gov.close_run', 1), losing(observer, 'gov.close_run')]) {
    const s = await scenario();
    const host = await s.open({ observerPool: pool });
    const project = value(await host.call('projects.create', { name: 'Retried', kind: 'folder' }));
    const { threadId } = await send(host, project.id, 'retried');
    assert.equal((await settled(host, threadId)).turns.at(-1)?.status, 'done');
    assert.deepEqual((await runsOf(s.binding.workspaceId)).map((r) => r.status), ['finished']);
    await host.close();
  }
});

test('a confirmation must name the attempt and the exact statement shown', { timeout: TEST_HANG_MS * 2 }, async () => {
  const s = await scenario();
  await kill(s, 'write.begun');
  const { host, thread, turn } = await recovered(s);
  const [effect] = turn.effects;
  const threadId = thread.summary.id;
  const refused = async (input: never) => assert.equal((await host.settleUnknown(input)).ok, false);
  await refused({ threadId, attempt: effect.key } as never);
  await refused({ threadId, attempt: effect.key, confirmation: { attempt: randomUUID(), statementSha256: digest(effect.detail!) } } as never);
  await refused({ threadId, attempt: effect.key, confirmation: { attempt: effect.key, statementSha256: digest('something else') } } as never);
  assert.deepEqual(await statusesOf(s), ['unknown']);
  await host.close();
});

test('a lost reconciliation acknowledgement is told apart by its own digest, and any other failure is not attributed', { timeout: TEST_HANG_MS * 2 }, async () => {
  const s = await scenario();
  await kill(s, 'write.begun');
  const lossy = losing(observer, 'gov.reconcile_attempt');
  const { host, thread, turn } = await (async () => { const open = await s.open({ observerPool: lossy }); const [summary] = await open.call('threads.list', {}); const t = await settled(open, summary.id); return { host: open, thread: t, turn: t.turns.at(-1)! }; })();
  const [effect] = turn.effects;
  const threadId = thread.summary.id;
  const input = { threadId, attempt: effect.key, confirmation: confirmation(effect) };
  const first = await host.settleUnknown(input);
  assert.equal(first.ok, false);
  assert.equal((first as { outcome: string }).outcome, 'UNKNOWN');
  assert.deepEqual(await statusesOf(s), ['failed'], 'it committed; only the answer went');
  value(await host.settleUnknown(input));
  const after = (await settled(host, threadId)).turns.at(-1)!;
  assert.match(after.effects[0].detail ?? '', /already recorded as not written by a confirmation with these same words/i, 'a replay claims no one\'s word');
  await host.close();

  const other = await scenario();
  await kill(other, 'write.begun');
  const opened = await recovered(other);
  const [held] = opened.turn.effects;
  committed(await other.runtime.door.reconcile(held.key, 'failed', 'f'.repeat(64)));
  const refused = await opened.host.settleUnknown({ threadId: opened.thread.summary.id, attempt: held.key, confirmation: confirmation(held) });
  assert.equal(refused.ok, false);
  const shown = (await settled(opened.host, opened.thread.summary.id)).turns.at(-1)!.effects[0];
  assert.equal(shown.outcome, 'REFUSED');
  assert.doesNotMatch(shown.detail ?? '', /confirmed/i);
  await opened.host.close();
});

test('an UNKNOWN with no bytes tells the person, and only their word that it is absent lifts the hold', { timeout: TEST_HANG_MS * 2 }, async () => {
  const s = await scenario();
  const projectId = await kill(s, 'write.begun');
  const { host, thread, turn } = await recovered(s);
  const [effect] = turn.effects;
  assert.equal(effect.outcome, 'UNKNOWN');
  assert.match(effect.detail ?? '', /was not found/i);
  assert.match(effect.detail ?? '', /stays held/i);
  assert.deepEqual(await statusesOf(s), ['unknown'], 'restart alone settles nothing');
  const settledNow = value(await host.settleUnknown({ threadId: thread.summary.id, attempt: effect.key, confirmation: confirmation(effect) }));
  assert.equal(settledNow.outcome, 'REFUSED');
  const after = (await settled(host, thread.summary.id)).turns.at(-1)!;
  assert.deepEqual(after.effects.map((e) => e.outcome), ['REFUSED'], 'never DONE');
  assert.match(after.effects[0].detail ?? '', /fixture session confirmed/i);
  assert.doesNotMatch(after.effects[0].detail ?? '', /a person confirmed/i);
  assert.equal(after.status, 'stopped');
  const { rows } = await admin.query('SELECT status, reconciliation_sha256 AS seen FROM app.effect_attempts WHERE workspace_id = $1', [s.binding.workspaceId]);
  assert.equal(rows[0].status, 'failed');
  assert.match(rows[0].seen, /^[0-9a-f]{64}$/);
  await send(host, projectId, 'again', thread.summary.id);
  const next = (await settled(host, thread.summary.id)).turns.at(-1)!;
  assert.deepEqual(next.effects.map((e) => e.outcome), ['DONE'], 'the person sent it again; nothing resent it');
  await host.close();
  const again = await recovered(s);
  assert.deepEqual(again.thread.turns[0].effects.map((e) => e.outcome), ['REFUSED'], 'the record survives a restart');
  await again.host.close();
});

test('a Stop\'s UNKNOWN settles the same way, with no restart', { timeout: TEST_HANG_MS * 2 }, async () => {
  const s = await scenario({ writeDelayMs: 60_000 });
  const host = await s.open();
  const project = value(await host.call('projects.create', { name: 'Stopped', kind: 'folder' }));
  const { threadId } = await send(host, project.id, 'stop');
  await pollUntil(async active => { while (active() && ((await statusesOf(s))[0] !== 'dispatching')) await new Promise((r) => setTimeout(r, 20)); }, "packages/platform/test/sql-v08-host-sql.ts:1181 polling state");
  value(await host.call('turns.stop', { threadId }));
  const [effect] = (await settled(host, threadId)).turns.at(-1)!.effects;
  assert.equal(effect.outcome, 'UNKNOWN');
  assert.equal(value(await host.settleUnknown({ threadId, attempt: effect.key, confirmation: confirmation(effect) })).outcome, 'REFUSED');
  assert.deepEqual(await statusesOf(s), ['failed']);
  await host.close();
});

test('the settle route refuses whatever is not an absence it can see', { timeout: TEST_HANG_MS * 2 }, async () => {
  // Bytes at the source: the exact route owns it, and the person's word cannot call it not written.
  const landed = await scenario();
  const landedProject = await kill(landed, 'write.projecting');
  mkdirSync(folderOf(landed, landedProject), { recursive: true });
  writeFileSync(join(folderOf(landed, landedProject), 'brief.md'), 'the person wrote this');
  const held = await recovered(landed);
  const found = await held.host.settleUnknown({ threadId: held.thread.summary.id, attempt: held.turn.effects[0].key, confirmation: confirmation(held.turn.effects[0]) });
  assert.equal(found.ok, false);
  assert.match((found as { detail: string }).detail, /found/i);
  assert.deepEqual(await statusesOf(landed), ['unknown']);
  await held.host.close();
  // No person.
  const alone = await scenario();
  await kill(alone, 'write.begun');
  let calls = 0;
  const real = fixtureSessions(cluster.adminUrl, alone.binding);
  const host = await alone.open({ sessions: { current: async () => (++calls > 2 ? { status: 'required' as const } : real.current()) } });
  const [summary] = await host.call('threads.list', {});
  const turn = (await settled(host, summary.id)).turns.at(-1)!;
  assert.equal((await host.settleUnknown({ threadId: summary.id, attempt: turn.effects[0].key, confirmation: confirmation(turn.effects[0]) })).ok, false);
  assert.deepEqual(await statusesOf(alone), ['unknown']);
  await host.close();
  // Custody that cannot say what to look for.
  const lost = await scenario();
  await kill(lost, 'write.begun');
  const file = join(lost.home, 'threads', readdirSync(join(lost.home, 'threads'))[0]);
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  for (const write of Object.values<{ target?: unknown }>(stored.writeCustody.writes)) write.target = { name: 'other' };
  writeFileSync(file, JSON.stringify(stored));
  const blind = await recovered(lost);
  const unreadable = await blind.host.settleUnknown({ threadId: blind.thread.summary.id, attempt: blind.turn.effects[0].key, confirmation: confirmation(blind.turn.effects[0]) });
  assert.match((unreadable as { detail: string }).detail, /cannot say what to look for/);
  assert.deepEqual(await statusesOf(lost), ['unknown']);
  await blind.host.close();
  // A turn still running holds a claim on the question.
  const atBegun = stops('write.begun');
  const live = await scenario({ pause: atBegun.pause });
  const open = await live.open();
  const project = value(await open.call('projects.create', { name: 'Live', kind: 'folder' }));
  const { threadId } = await send(open, project.id, 'live');
  await atBegun.at;
  const [row] = (await admin.query('SELECT id FROM app.effect_attempts WHERE workspace_id = $1', [live.binding.workspaceId])).rows;
  const early = await open.settleUnknown({ threadId, attempt: row.id, confirmation: { attempt: row.id, statementSha256: digest('') } });
  assert.match((early as { detail: string }).detail, /closed run/, 'past the last check, the run decides it');
  atBegun.release();
  await settled(open, threadId);
  await open.close();
  assert.equal((await open.settleUnknown({ threadId, attempt: row.id, confirmation: { attempt: row.id, statementSha256: digest('') } })).ok, false, 'a closed host');
});

test('v08 refuses keyed project creation while preserving the legacy no-key caller', async () => {
  const s=await scenario(), host=await s.open();
  try {
    const refused=await host.call('projects.create',{name:'Keyed project',kind:'folder',clientKey:'keyed'});
    assert.ok(!refused.ok);assert.equal(refused.reason,'NOT_AVAILABLE');assert.equal(refused.outcome,'REFUSED');
    const legacy=value(await host.call('projects.create',{name:'Legacy project',kind:'folder'}));assert.equal(legacy.name,'Legacy project');
  } finally {await host.close();}
});


for (const boundary of ['folder', 'list'] as const) test(`v0.8 project creation checks admission before the ${boundary} write`, async t => {
  const s = await scenario(), host = await s.open();
  let admitted = true, reached = false;
  const statfs = fs.statfsSync, mkdir = fs.mkdirSync;
  mkdir(join(s.home, 'projects'), {recursive:true});
  t.mock.method(fs, 'statfsSync', ((path:fs.PathLike) => ({...statfs(path), ...((!admitted || (boundary === 'folder' && String(path) === join(s.home, 'projects'))) ? {type:0x6969} : {})})) as typeof fs.statfsSync);
  t.mock.method(fs, 'mkdirSync', ((path:fs.PathLike, options:never) => {
    const result = mkdir(path, options);
    if (String(path).startsWith(join(s.home, 'projects') + '/')) {reached = true; admitted = false;}
    return result;
  }) as typeof fs.mkdirSync);
  syncBuiltinESMExports();
  try {
    const receipt = await host.call('projects.create', {name:'Admission', kind:'folder'});
    assert.ok(!receipt.ok);
    assert.equal(receipt.reason, 'NOT_AVAILABLE');
    assert.equal(receipt.outcome, boundary === 'list' ? 'UNKNOWN' : 'REFUSED');
    assert.match(receipt.detail, boundary === 'list' ? /Inspect the project folder and project list before another attempt/ : /This request created nothing/);
    assert.equal(reached, boundary === 'list');
    assert.equal(fs.readdirSync(join(s.home, 'projects')).length, boundary === 'list' ? 1 : 0);
    assert.equal(fs.existsSync(join(s.home, 'projects.json')), false);
    admitted = true;
    t.mock.restoreAll(); syncBuiltinESMExports();
    value(await host.call('projects.create', {name:'After admission', kind:'folder'}));
    const saved = JSON.parse(fs.readFileSync(join(s.home, 'projects.json'), 'utf8'));
    assert.equal(saved.length, 1); assert.equal(saved[0].name, 'After admission');
  } finally {t.mock.restoreAll(); syncBuiltinESMExports(); await host.close();}
});

test('v0.8 project creation waits for the data-folder lock', async () => {
  const s = await scenario(), host = await s.open();
  let release!:()=>void, locked!:()=>void;
  const entered = new Promise<void>(resolve => {locked = resolve;});
  const barrier = new Promise<void>(resolve => {release = resolve;});
  const holder = withHomeLock(s.home, async () => {locked(); await barrier;});
  await entered;
  let finished = false;
  const creation = host.call('projects.create', {name:'Waited', kind:'folder'}).then(receipt => {finished = true; return receipt;});
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false);
    assert.equal(fs.existsSync(join(s.home, 'projects.json')), false);
  } finally {release(); await holder; await creation; await host.close();}
});
