import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { join } from 'node:path';
import { ConnectorService } from '../src/connectors/service.ts';
import { freshDir } from './helpers.ts';
import { exportHome } from '../src/composition/backup.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { hostClosed } from '../src/composition/host.ts';
import { ThreadJournal } from '../src/composition/thread-journal.ts';
import { withHomeLock, assertHomeWriteAdmission } from '../src/composition/home-lock.ts';
import { idle, open, settings, value } from './helpers.ts';

async function fixture(kind: 'native' | 'legacy' | 'connector' = 'native', workflow?: 'goal' | 'board') {
  const { host, home } = open();
  const project = value(await host.call('projects.create', { name: 'Checked unknown', kind: 'folder' }));
  const first = value(await host.call('turns.send', { projectId: project.id, text: 'Ready', attachments: [], settings, clientKey: 'first' }));
  await idle(host, first.threadId);
  const sent = value(await host.call('turns.send', { threadId: first.threadId, projectId: project.id, text: 'Ready again', attachments: [], settings, clientKey: 'second' }));
  await idle(host, first.threadId);
  if (workflow === 'goal') value(await host.call('goals.set', { threadId: sent.threadId, text: 'Finish the checked work', baseVersion: 0 }));
  host.close(); await hostClosed(home);
  await withHomeLock(home, async () => {
    assertHomeWriteAdmission(home);
    if (workflow === 'goal') writeFileSync(`${home}/goal-runs.json`, JSON.stringify({ [sent.threadId]: { threadId: sent.threadId, status: 'blocked', budget: 2, used: 1, phase: 'work', startedAt: '2026-11-13T12:00:00.000Z', updatedAt: '2026-11-13T12:00:00.000Z', settings } }));
    if (workflow === 'board') writeFileSync(`${home}/task-board.json`, JSON.stringify({ boards: { [sent.threadId]: { threadId: sent.threadId, size: 1, cards: [{ id: 'card', title: 'Checked work', brief: 'Inspect', status: 'held', unknown: true, dependsOn: [], threadId: sent.threadId, turnId: sent.turnId, attempts: [], retries: 0, requeues: 0, starts: 1, version: 1 }] } } }));
    new ThreadJournal(home).append({ kind: 'turn.closed', threadId: sent.threadId, turnId: sent.turnId, state: {
      status: 'stopped', effects: [], unknownOutcome: true,
      ...(kind === 'native' ? { nativeAccountActivity: true, unknownEvidence: { connectorEffects: [], other: true } } : {}),
      ...(kind === 'connector' ? { unknownEvidence: { connectorEffects: ['f3fbe4ef-b530-409d-a63e-84780bbb4378'] } } : {}),
    } });
  });
  return { home, first, sent, host: open(home).host };
}

for (const kind of ['native', 'legacy'] as const) test(`${kind}: only an exact person check releases controls and survives reopen`, async () => {
  const f = await fixture(kind);
  assert.equal((await f.host.call('threads.restart', f.sent)).ok, false);
  assert.equal((await f.host.call('threads.rewindPreview', f.first)).ok, false);
  const q = value(await f.host.unknownChecks.question(f.sent));
  const mark = value(await f.host.unknownChecks.check({ ...f.sent, revision: q.revision }));
  const turn = value(await f.host.call('threads.get', { id: f.sent.threadId })).turns.at(-1)!;
  assert.equal(turn.unknownOutcome, true); assert.equal(turn.status, 'stopped');
  assert.equal(turn.unknownChecked?.by, JSON.parse(readFileSync(`${f.home}/core.json`, 'utf8')).person);
  assert.deepEqual(turn.unknownChecked, mark);
  assert.equal(new ThreadJournal(f.home).read().filter(e => e.kind === 'turn.unknown.checked').length, 1);
  assert.deepEqual(value(await f.host.unknownChecks.check({ ...f.sent, revision: q.revision })), mark);
  f.host.close(); await hostClosed(f.home);
  const reopened = open(f.home).host;
  assert.deepEqual(value(await reopened.call('threads.get', { id: f.sent.threadId })).turns.at(-1)?.unknownChecked, mark);
  assert.equal((await reopened.call('threads.rewindPreview', f.first)).ok, true);
  value(await reopened.call('threads.restart', f.sent));
  await idle(reopened, f.sent.threadId);
  const preview = value(await reopened.call('threads.rewindPreview', f.first));
  value(await reopened.call('threads.rewind', { ...f.first, revision: preview.revision, clientKey: 'rewind-checked', choices: [] }));
  const rewound = value(await reopened.call('threads.get', { id: f.sent.threadId }));
  const original = rewound.rewinds!.at(-1)!.turns.find(t => t.id === f.sent.turnId)!;
  assert.equal(original.status, 'stopped'); assert.equal(original.unknownOutcome, true); assert.deepEqual(original.unknownChecked, mark);
});

test('connector unknown and general API callers cannot mark a turn checked', async () => {
  const f = await fixture('connector');
  assert.equal((await f.host.unknownChecks.question(f.sent)).ok, false);
  assert.equal((await f.host.unknownChecks.check({ ...f.sent, revision: 'forged' })).ok, false);
  await assert.rejects(() => f.host.call('threads.checked' as never, f.sent as never));
});

test('a crash immediately after the durable check leaves the unknown checked on reopen', async () => {
  const { spawn } = await import('node:child_process');
  const f = await fixture('native', 'board');
  f.host.close(); await hostClosed(f.home);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createHost } from ${JSON.stringify(new URL('../src/composition/host.ts', import.meta.url).href)};
    const host = createHost({ home: process.argv[1], unknownCheckRecorded: () => process.kill(process.pid, 'SIGKILL') });
    const input = JSON.parse(process.argv[2]);
    const q = await host.unknownChecks.question(input);
    if (!q.ok) throw new Error(q.detail);
    await host.unknownChecks.check({ ...input, revision: q.value.revision });
  `, f.home, JSON.stringify(f.sent)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; child.stderr.on('data', b => { err += b; });
  const result = await new Promise<{ code: number | null; signal: string | null }>(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  assert.equal(result.signal, 'SIGKILL', err);
  const reopened = open(f.home).host;
  const turn = value(await reopened.call('threads.get', { id: f.sent.threadId })).turns.at(-1)!;
  assert.equal(turn.unknownOutcome, true); assert.equal(turn.status, 'stopped'); assert.ok(turn.unknownChecked);
  const card = value(await reopened.call('board.get', { threadId: f.sent.threadId })).cards[0];
  assert.equal(card.status, 'failed'); assert.equal(card.unknown, undefined);
  assert.equal((await reopened.call('threads.rewindPreview', f.first)).ok, true);
  value(await reopened.call('threads.restart', f.sent));
  await idle(reopened, f.sent.threadId);
});


test('checking releases the goal uncertainty hold without starting work', async () => {
  const f = await fixture('native', 'goal');
  const blocked = value(await f.host.call('goals.resume', { threadId: f.sent.threadId }));
  assert.equal(blocked.status, 'blocked'); assert.match(blocked.detail ?? '', /unknown/);
  const q = value(await f.host.unknownChecks.question(f.sent));
  value(await f.host.unknownChecks.check({ ...f.sent, revision: q.revision }));
  assert.equal(value(await f.host.call('threads.get', { id: f.sent.threadId })).turns.length, 2);
  const resumed = value(await f.host.call('goals.resume', { threadId: f.sent.threadId }));
  assert.equal(resumed.status, 'running');
  const thread = await idle(f.host, f.sent.threadId);
  assert.equal(thread.turns.length, 3); assert.equal(thread.turns[1].status, 'stopped');
});

test('a stale check and a read-only Host cannot mark an unknown', async () => {
  const f = await fixture('native');
  assert.equal((await f.host.unknownChecks.check({ ...f.sent, revision: 'a'.repeat(64) })).ok, false);
  f.host.close(); await hostClosed(f.home);
  const read = open(f.home, { readOnly: true }).host;
  assert.equal((await read.unknownChecks.question(f.sent)).ok, false);
  assert.equal((await read.unknownChecks.check({ ...f.sent, revision: 'a'.repeat(64) })).ok, false);
});


test('checking preserves a separate person hold on the board card', async () => {
  const f = await fixture('native', 'board');
  const card = value(await f.host.call('board.get', { threadId: f.sent.threadId })).cards[0];
  value(await f.host.call('board.update', { threadId: f.sent.threadId, cardId: card.id, baseVersion: card.version, patch: { status: 'held' } }));
  const q = value(await f.host.unknownChecks.question(f.sent));
  value(await f.host.unknownChecks.check({ ...f.sent, revision: q.revision }));
  const kept = value(await f.host.call('board.get', { threadId: f.sent.threadId })).cards[0];
  assert.equal(kept.status, 'held'); assert.equal(kept.unknown, undefined); assert.equal(kept.detail, 'Held by you.');
});


test('reading uncertain turns adds no home locks or Core reconciliation and leaves import admitted', async t => {
  const f = await fixture('connector');
  // Finish opening before counting just the read, as the app does before polling.
  await f.host.call('host.status', {});
  const original = fs.openSync;
  let locks = 0, reconciliations = 0;
  const files = t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]) === join(f.home, '.lock')) locks++;
    return original(...args);
  });
  const core = t.mock.method(ConnectorService.prototype, 'reconciledTurnEffect', async () => { reconciliations++; return false; });
  value(await f.host.call('threads.get', { id: f.sent.threadId }));
  assert.deepEqual({ reconciliations, locks }, { reconciliations: 0, locks: 0 });
  files.mock.restore(); core.mock.restore();
});

test('reading an eligible turn does not consume backup import admission', async () => {
  const native = await fixture('native');
  value(await native.host.call('threads.get', { id: native.sent.threadId }));
  const from = join(freshDir('checked-import-'), 'export');
  await exportHome({ home: freshDir('checked-empty-source-'), projects: [], documents: () => [], versionPath: () => '', threads: [], receipts: async () => [], secrets: async () => [] }, { to: from });
  // Import reaches its ordinary populated-home validation: reading consumed no admission.
  await assert.rejects(native.host.importExport(from), /not a new, empty home/);
});

test('checking one of two unknown turns leaves the other turn holding the thread', async () => {
  const f = await fixture('native', 'board');
  f.host.close(); await hostClosed(f.home);
  await withHomeLock(f.home, async () => {
    assertHomeWriteAdmission(f.home);
    new ThreadJournal(f.home).append({ kind: 'turn.closed', threadId: f.first.threadId, turnId: f.first.turnId, state: {
      status: 'stopped', effects: [], unknownOutcome: true, unknownEvidence: { connectorEffects: [], other: true },
    } });
  });
  const host = open(f.home).host;
  const q = value(await host.unknownChecks.question(f.first));
  value(await host.unknownChecks.check({ ...f.first, revision: q.revision }));
  const thread = value(await host.call('threads.get', { id: f.sent.threadId }));
  assert.ok(thread.turns[0].unknownChecked);
  assert.equal(thread.turns[1].unknownChecked, undefined);
  assert.ok(thread.turns[1].unknownCheck);
  assert.equal((await host.call('threads.restart', f.sent)).ok, false);
  assert.equal((await host.call('threads.rewindPreview', f.first)).ok, false);
  const card = value(await host.call('board.get', { threadId: f.sent.threadId })).cards[0];
  assert.equal(card.status, 'held'); assert.equal(card.unknown, true);
});


test('later turn evidence invalidates the inspection in the public read projection', async () => {
  const f = await fixture('native');
  const q = value(await f.host.unknownChecks.question(f.sent));
  value(await f.host.unknownChecks.check({ ...f.sent, revision: q.revision }));
  assert.equal(value(await f.host.call('threads.get', { id: f.sent.threadId })).turns[1].unknownCheckedCurrent, true);
  f.host.close(); await hostClosed(f.home);
  await withHomeLock(f.home, async () => {
    assertHomeWriteAdmission(f.home);
    new ThreadJournal(f.home).append({ kind: 'turn.closed', threadId: f.sent.threadId, turnId: f.sent.turnId, state: {
      status: 'refused', effects: [], unknownOutcome: true, unknownEvidence: { connectorEffects: [], other: true },
    } });
  });
  const host = open(f.home).host;
  const changed = value(await host.call('threads.get', { id: f.sent.threadId })).turns[1];
  assert.equal(changed.unknownCheckedCurrent, false); assert.ok(changed.unknownChecked); assert.ok(changed.unknownCheck);
  assert.equal((await host.call('threads.restart', f.sent)).ok, false);
});
