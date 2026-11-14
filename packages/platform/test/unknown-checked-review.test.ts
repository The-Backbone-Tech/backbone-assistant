import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Turn } from '../src/api.ts';
import { createTaskBoard } from '../src/composition/task-board.ts';
import { exportHome } from '../src/composition/backup.ts';
import { createUnknownChecks, unknownRevision } from '../src/composition/unknown-checks.ts';
import { ThreadJournal, type StoredThread } from '../src/composition/thread-journal.ts';
import { withHomeLock, assertHomeWriteAdmission } from '../src/composition/home-lock.ts';
import { freshDir, value } from './helpers.ts';

const turn = (): Turn => ({ id: 'turn', side: false, status: 'stopped', unknownOutcome: true,
  user: { text: 'Work', at: '2026-11-13T12:00:00.000Z', attachments: [] }, effects: [],
  work: { harness: 'fake', startedAt: '2026-11-13T12:00:00.000Z', steps: [] } });
const thread = (t: Turn) => ({ summary: { id: 'worker', projectId: 'project', title: 'Work', running: false, updatedAt: t.user.at }, turns: [t], sideTurns: [], clientKeys: [] }) as unknown as StoredThread;

for (const changed of [false, true]) test(`export retains inspection with current=${!changed} in JSON and readable history`, async () => {
  const home = freshDir('checked-export-'), t = turn();
  t.unknownChecked = { revision: unknownRevision(t), by: 'owner-id', byName: 'Alex', at: t.user.at, steps: [] } as NonNullable<Turn['unknownChecked']>;
  if (changed) t.work.steps.push({ kind: 'note', label: 'Later evidence' });
  const to = join(freshDir('checked-export-destination-'), 'export');
  await exportHome({ home, projects: [{ id: 'project', name: 'Project', kind: 'folder' }], documents: () => [], versionPath: () => { throw Error('No documents'); },
    threads: [thread(t)], receipts: async () => [], secrets: async () => [] }, { to });
  const json = JSON.parse(readFileSync(join(to, 'threads/t001.json'), 'utf8')).turns[0];
  assert.equal(json.status, 'unknown'); assert.equal(json.unknownChecked.current, !changed);
  const text = readFileSync(join(to, 'threads/t001.md'), 'utf8');
  assert.match(text, changed ? /Earlier check by Alex.*no longer applies/ : /unknown, checked by Alex/);
  assert.match(text, /Checker ID: owner-id/);
  if (changed) assert.doesNotMatch(text, /unknown, checked by/);
});

test('the check records the known person name and only the check marks the host used', async () => {
  const home = freshDir('checked-name-'), t = turn(), threads = new Map([['worker', thread(t)]]);
  let inspections = 0;
  const checks = createUnknownChecks({ admit: (_id, work) => work(), home, threads, journal: new ThreadJournal(home), ready: async () => ({ person: 'owner-id', name: 'Alex' }), unavailable: () => false,
    held: () => [], reconciled: async () => false, enter: (checking?: boolean) => { if (checking !== false) inspections++; return () => {}; }, save: async () => {}, checked() {} });
  const q = value(await checks.question({ threadId: 'worker', turnId: 'turn' }));
  assert.equal(inspections, 0);
  const mark = value(await checks.check({ threadId: 'worker', turnId: 'turn', revision: q.revision }));
  assert.equal(inspections, 1); assert.equal((mark as typeof mark & { byName?: string }).byName, 'Alex');
});

test('a person hold survives a later unknown worker result and replay after checking', async () => {
  const home = freshDir('checked-board-'), t = turn(), worker = thread(t);
  worker.child = { parentThreadId: 'parent', key: 'worker-key' } as StoredThread['child'];
  const parent = { ...thread(turn()), summary: { ...worker.summary, id: 'parent' } };
  const threads = new Map([['parent', parent], ['worker', worker]]);
  const path = join(home, 'task-board.json');
  await withHomeLock(home, async () => {
    assertHomeWriteAdmission(home);
    writeFileSync(path, JSON.stringify({ boards: { parent: { threadId: 'parent', size: 1, cards: [{ id: 'card', title: 'Work', brief: 'Inspect', key: 'card-key', status: 'ready', dependsOn: [], threadId: 'worker', turnId: 'turn', attempts: [], retries: 0, requeues: 0, starts: 1, version: 1 }] } } }));
  });
  const deps: Parameters<typeof createTaskBoard>[0] = { home, threads, readOnly: false, closing: () => false, now: Date.now, backoffMs: 1, emit() {},
    startWorker: async () => { throw Error('Checking never starts a worker'); }, admit: async () => { throw Error('Checking never admits work'); },
    stopTurn() {}, mayHaveWritten: async () => false, withdrawn: () => false, peerSteer: async () => { throw Error('No steering'); } };
  const board = createTaskBoard(deps);
  await withHomeLock(home, async () => {
    value(await board.handlers['board.update']({ threadId: 'parent', cardId: 'card', baseVersion: 1, patch: { status: 'held' } }));
  });
  board.ended(worker, t);
  await board.resume();
  const held = value(await board.handlers['board.get']({ threadId: 'parent' })).cards[0];
  assert.equal(held.status, 'held'); assert.equal(held.unknown, true);
  // A changing detail must not decide who owns the hold.
  t.unknownChecked = { revision: unknownRevision(t), by: 'owner', at: t.user.at, steps: [] };
  await withHomeLock(home, async () => { board.checked(worker); });
  const kept = value(await board.handlers['board.get']({ threadId: 'parent' })).cards[0];
  assert.equal(kept.status, 'held'); assert.equal(kept.unknown, undefined); assert.equal(kept.detail, 'Held by you.');
  const saved = JSON.parse(readFileSync(path, 'utf8')); assert.equal(saved.boards.parent.cards[0].personHeld, true);
  // Recover the canonical check while the board still carries its uncertainty projection.
  saved.boards.parent.cards[0].unknown = true;
  saved.boards.parent.cards[0].detail = 'A worker UNKNOWN outcome replaced the detail.';
  await withHomeLock(home, async () => { assertHomeWriteAdmission(home); writeFileSync(path, JSON.stringify(saved)); });
  const reopened = createTaskBoard(deps);
  await withHomeLock(home, async () => { await reopened.recover(); });
  const recovered = value(await reopened.handlers['board.get']({ threadId: 'parent' })).cards[0];
  assert.equal(recovered.status, 'held'); assert.equal(recovered.unknown, undefined); assert.equal(recovered.detail, 'Held by you.');
});
