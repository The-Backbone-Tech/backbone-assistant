import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Turn, HeldCall } from '../src/api.ts';
import { createUnknownChecks } from '../src/composition/unknown-checks.ts';
import { turnUnresolved } from '../src/composition/turn-uncertainty.ts';
import { inActiveHomeLockScope } from '../src/composition/home-lock.ts';
import { ThreadJournal, type StoredThread } from '../src/composition/thread-journal.ts';

for (const other of [false, true]) test(`connector unknown with unattributed remainder=${other} keeps Core verification`, async t => {
  const home = mkdtempSync(join(tmpdir(), 'checked-mixed-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const turn: Turn = { id: 'turn', side: false, status: 'stopped', unknownOutcome: true,
    unknownEvidence: { connectorEffects: ['effect'], ...(other ? { other: true } : {}) },
    user: { at: '2026-11-13T12:00:00.000Z', text: 'Work', attachments: [] }, effects: [],
    work: { harness: 'fake', startedAt: '2026-11-13T12:00:00.000Z', steps: [] } };
  const thread = { summary: { id: 'thread', running: false }, turns: [turn], sideTurns: [], clientKeys: [] } as unknown as StoredThread;
  const held = [{ threadId: 'thread', turnId: 'turn', effect: 'effect', state: 'unknown' }] as HeldCall[];
  let reconciled = false, saves = 0;
  const checks = createUnknownChecks({ admit: (_id, work) => work(), home, threads: new Map([['thread', thread]]), journal: new ThreadJournal(home),
    ready: async () => ({ person: 'owner' }), unavailable: () => false, held: () => held, enter: () => () => {}, checked() {}, save: async () => { saves++; },
    reconciled: async () => { assert.equal(inActiveHomeLockScope(home), false); return reconciled; },
  });
  assert.equal((await checks.question({ threadId: 'thread', turnId: 'turn' })).ok, false);
  reconciled = true;
  const question = await checks.question({ threadId: 'thread', turnId: 'turn' });
  assert.equal(question.ok, other);
  if (!question.ok) { assert.equal(saves, 0); return; }
  const marked = await checks.check({ threadId: 'thread', turnId: 'turn', revision: question.value.revision });
  assert.equal(marked.ok, true); assert.equal(turn.status, 'stopped'); assert.equal(turn.unknownOutcome, true);
  assert.equal(await turnUnresolved('thread', turn, async () => reconciled, held), false);
  reconciled = false;
  assert.equal(await turnUnresolved('thread', turn, async () => reconciled, held), true, 'checking never substitutes for Core verification');
});
