import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import type { Turn } from '../src/api.ts';
import { createParallelWork, type ParallelDeps, type StoredThread } from '../src/composition/parallel-work.ts';
import { ThreadJournal } from '../src/composition/thread-journal.ts';
import type { RunHandle } from '../src/composition/core.ts';
import type { ChildStart } from '../src/ports/harness.ts';
import { freshHome, settings } from './helpers.ts';

// The authority port waits after the child is reserved, then refuses delegation. No real Core call.
test('concurrent identical named calls join a refused admission and never claim a reserved child started', async () => {
  const home = freshHome();
  const turn: Turn = { id: 'parent-turn', side: false, reads: [], user: { text: 'Find facts', settings, attachments: [], at: '' }, work: { startedAt: '', harness: 'fake', steps: [] }, effects: [], status: 'running' };
  const parent: StoredThread = { summary: { id: 'parent', projectId: 'project', title: 'Parent', pinned: false, unread: false, archived: false, running: true, updatedAt: '' }, turns: [turn], sideTurns: [], clientKeys: [] };
  const threads = new Map([[parent.summary.id, parent]]), running = new Map<string, AbortController>();
  let entered!: () => void, release!: () => void, delegations = 0;
  const entering = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const link = { id: { agent: 'agent', mandate: 'parent-mandate' }, person: () => ({}), runOf: () => ({}),
    read: async () => ({ rows: [{ parent_id: null }] }),
    call: async () => { delegations++; entered(); await blocked; throw new Error('Controlled delegation refusal'); },
  };
  const work = createParallelWork({ home, threads, running, journal: new ThreadJournal(home),
    material: { load: () => undefined, list: () => [] }, link: async () => link, piece: () => null,
    native: () => false, interrupted: () => false, closing: () => false, registerCarrier() {}, emptied() {},
    newTurn: () => ({ ...turn, id: 'child-turn' }),
    agentRole: async () => ({ text: 'Find facts', agentRole: { name: 'researcher', digest: 'definition', tools: ['Read'] } }),
  } as unknown as ParallelDeps);
  const tools = work.coordination(parent, turn, {} as RunHandle, new AbortController().signal);
  const request = { agent: 'own/researcher', role: 'worker' as const, brief: 'Find facts' };
  const first = tools.startChild(request);
  await entering;
  assert.equal(threads.size, 2, 'one child is reserved but has not been admitted');
  let secondSettled = false;
  const second = tools.startChild(request).then(result => { secondSettled = true; return result; });
  let results: ChildStart[] = [];
  try {
    await setImmediate();
    assert.equal(secondSettled, false, 'a reservation is not a started child');
  } finally {
    release();
    results = await Promise.all([first, second]);
  }
  assert.deepEqual(results.map(result => result.outcome), ['REFUSED', 'REFUSED']);
  assert.equal(delegations, 1, 'both callers see the same admission result');
  assert.equal(threads.size, 1); assert.equal(running.size, 0);
});
