import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Turn } from '../src/api.ts';
import type { CoreLink } from '../src/composition/core.ts';
import { createTaskBoard } from '../src/composition/task-board.ts';
import { createGoalRuns } from '../src/composition/goal-runs.ts';
import { withinGrantedVersion, type PieceOnDisk } from '../src/composition/pieces.ts';
import { withHomeLock } from '../src/composition/home-lock.ts';
import { applyEvent, ThreadJournal, type StoredThread } from '../src/composition/thread-journal.ts';
import { createThreadRewind } from '../src/composition/thread-rewind.ts';
import { MaterialStore } from '../src/stub/material.ts';

const turn = (status: Turn['status']): Turn => Object.assign({ id: 'turn', side: false, status, user: { text: 'Read calendar', attachments: [], at: '' }, effects: [], work: { startedAt: '', harness: 'codex', steps: [] } }, { nativeAccountActivity: true as const });
const thread = (id: string, turns: Turn[]): StoredThread => ({ summary: { id, projectId: 'project', running: false }, turns, sideTurns: [], clientKeys: [] }) as unknown as StoredThread;

for (const status of ['running', 'stopped', 'done'] as const) test(`board never automatically retries native account activity after ${status}`, async t => {
  const home = mkdtempSync(join(tmpdir(), 'native-account-board-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const work = turn(status);
  if (status === 'stopped') Object.assign(work, { unknownOutcome: true, unknownEvidence: { connectorEffects: [], other: true } });
  if (status === 'done') { work.status = 'stopped'; work.failure = { detail: '503 Service Unavailable after account activity' }; }
  const worker = Object.assign(thread('worker', [work]), { child: { parentThreadId: 'parent', key: 'worker-key' } }) as StoredThread;
  const path = join(home, 'task-board.json');
  writeFileSync(path, JSON.stringify({ boards: { parent: { threadId: 'parent', size: 1, cards: [{ id: 'card', title: 'Calendar', brief: 'Read calendar', status: 'running', dependsOn: [], threadId: 'worker', turnId: 'turn', attempts: [], retries: 0, requeues: 0, starts: 1, version: 1 }] } } }));
  let dispatches = 0;
  const board = createTaskBoard({ home, threads: new Map([['parent', thread('parent', [])], ['worker', worker]]), readOnly: false, closing: () => true, now: Date.now, backoffMs: 1,
    emit() {}, async startWorker() { dispatches++; throw new Error('No new worker'); }, async admit() { dispatches++; throw new Error('No retry'); },
    stopTurn(_thread, turn) { turn.stopRequested = true; }, mayHaveWritten: async () => false, withdrawn: () => false, peerSteer: async () => { throw new Error('No steer'); },
  });
  await withHomeLock(home, async () => { await board.recover(); await board.resume(); });
  const card = JSON.parse(readFileSync(path, 'utf8')).boards.parent.cards[0];
  assert.equal(card.status, 'held');
  assert.deepEqual([card.retries, card.requeues, dispatches], [0, 0, 0]);
});

test('a goal blocks on native unknown evidence before offering to resume a stopped turn', async t => {
  const home = mkdtempSync(join(tmpdir(), 'native-account-goal-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const work = Object.assign(turn('stopped'), { unknownOutcome: true as const, unknownEvidence: { connectorEffects: [], other: true as const } });
  writeFileSync(join(home, 'goal-runs.json'), JSON.stringify({ parent: { threadId: 'parent', status: 'running', used: 1, budget: 3, phase: 'work', startedAt: '', updatedAt: '' } }));
  let changed!: () => void;
  const saved = new Promise<void>(resolve => { changed = resolve; });
  const runs = createGoalRuns({ home, threads: new Map([['parent', thread('parent', [work])]]), material: { load: () => null }, closing: () => false, childrenRunning: () => false,
    emit() { changed(); }, async admit() { throw new Error('No further model call'); },
  });
  await withHomeLock(home, async () => { runs.resume(); await saved; });
  assert.equal(runs.view('parent')?.status, 'blocked');
});

test('native account reach is declared and exceeds the previous module grant', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../../modules/harness-codex/backbone.module.json', import.meta.url), 'utf8'));
  const caps = manifest.capabilities;
  assert.ok(caps.network.includes('native-codex-account-tools-in-full'));
  const link = { person: () => 'person', read: async () => ({ rows: [{ id: 'old', planes: ['personal'], operations: ['workspace.write_document'], effect_classes: [2], network: ['native-codex-managed', 'provider-web-search-in-full'], secrets: 'none' }] }), pieceMandate: async () => 'granted' } as unknown as CoreLink;
  assert.equal(await withinGrantedVersion(link, { manifest, digest: 'new' } as PieceOnDisk), false);
});

test('journal replay retains native account activity independently of a thread snapshot', () => {
  const work = turn('running'); delete work.nativeAccountActivity;
  const threads = new Map([['parent', thread('parent', [work])]]);
  applyEvent(threads, { kind: 'turn.closed', threadId: 'parent', turnId: 'turn', state: { status: 'stopped', effects: [], nativeAccountActivity: true } });
  assert.equal(threads.get('parent')?.turns[0].nativeAccountActivity, true);
});

test('rewind cannot hide a failed native account attempt even without a gateway unknown receipt', async t => {
  const home = mkdtempSync(join(tmpdir(), 'native-account-rewind-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const baseline = turn('done'); baseline.id = 'base'; delete baseline.nativeAccountActivity;
  const failed = turn('stopped');
  const stored = thread('parent', [baseline, failed]);
  const rewind = createThreadRewind({ home, material: new MaterialStore(home, {}, () => {}), threads: new Map([['parent', stored]]), journal: new ThreadJournal(home), projectDir: () => home, busy: () => false, save: async () => {}, changed() {} });
  const result = await rewind.preview({ threadId: 'parent', turnId: 'base' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.detail, /Native account activity/);
});
