import { unexpectedMaterialRead } from './fixtures/synthetic-material-reader.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Turn } from '../src/api.ts';
import { runHarnessTurn, type Checkpoint } from '../src/composition/harness-turn.ts';
import { createMemory } from '../src/composition/memory.ts';
import type { StoredThread } from '../src/composition/thread-journal.ts';
import type { HarnessV1, TurnOutcome, WriteOutcome } from '../src/ports/harness.ts';
import type { Gateway } from '../src/stub/harness.ts';
import { MaterialStore } from '../src/stub/material.ts';

// A reviewer or judge turn reports; it never changes the project. Pi enforces this by offering no
// write tool, but a native engine imports its staged files through `writeIfVersion`, so the host
// itself refuses every write of a read-only turn, whatever the engine offers.
function setup(t: TestContext, readOnly: boolean, start: HarnessV1['start']) {
  const home = mkdtempSync(join(tmpdir(), 'readonly-turns-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const material = new MaterialStore(home, {}, () => {});
  let dispatched = 0;
  const gateway: Gateway = {
    conditionalWrites: true,
    read: unexpectedMaterialRead,
    async write(_target, effect, perform) {
      dispatched++;
      effect.key = `write-${dispatched}`;
      try {
        const result = await perform();
        if (result === 'stopped') return undefined;
        effect.outcome = 'DONE';
        return result;
      } catch (error) { effect.outcome = 'REFUSED'; effect.detail = String(error); return undefined; }
    },
  };
  const turn: Turn = { id: 'turn', side: false, user: { text: 'Review the draft', attachments: [], at: '' },
    work: { startedAt: '', harness: 'controlled', steps: [] }, effects: [], status: 'running' };
  const run = () => runHarnessTurn({ material, projectId: 'project', gateway, writeDelayMs: 0, signal: new AbortController().signal,
    threadId: 'thread', harness: { specificationVersion: 'v1', id: 'controlled', label: 'controlled', start },
    route: { kind: 'native', provider: 'codex', baseUrl: '', model: 'controlled', label: 'controlled', credential: null },
    credential: async () => { throw new Error('No credential in this test'); }, history: [], resumed: false, progress() {},
    ...(readOnly ? { readOnly: true } : {}),
  }, turn, []);
  return { material, turn, run, dispatched: () => dispatched };
}
const done: TurnOutcome = { status: 'done', answer: 'Reviewed', usage: { input: 0, output: 0 } };
const events = async function* () {};

test('a read-only turn writes nothing through either write path, and no effect is dispatched', async (t) => {
  const outcomes: WriteOutcome[] = [];
  const s = setup(t, true, (_request, context) => {
    const signal = new AbortController().signal;
    const outcome = (async () => {
      outcomes.push(await context.tools.write('notes.md', 'reviewer edit', signal));
      outcomes.push(await context.tools.writeIfVersion!('imported.md', 'staged file', { targetVersion: null, sources: [] }, signal));
      return done;
    })();
    return { events: events(), outcome, stop() {}, steer() {} };
  });
  await s.run();
  assert.deepEqual(outcomes.map((o) => o.outcome), ['REFUSED', 'REFUSED']);
  assert.match((outcomes[0] as { detail: string }).detail, /review/i);
  assert.equal(s.dispatched(), 0, 'nothing reached the door');
  assert.deepEqual(s.material.list('project', true), []);
  assert.deepEqual(s.turn.effects, []);
});

test('the same writes from an ordinary turn land, so the refusal is the read-only rule', async (t) => {
  const outcomes: WriteOutcome[] = [];
  const s = setup(t, false, (_request, context) => {
    const signal = new AbortController().signal;
    const outcome = (async () => {
      outcomes.push(await context.tools.write('notes.md', 'edit', signal));
      outcomes.push(await context.tools.writeIfVersion!('imported.md', 'staged file', { targetVersion: null, sources: [] }, signal));
      return done;
    })();
    return { events: events(), outcome, stop() {}, steer() {} };
  });
  await s.run();
  assert.deepEqual(outcomes.map((o) => o.outcome), ['DONE', 'DONE']);
  assert.deepEqual(s.material.list('project').map((m) => m.name).sort(), ['imported.md', 'notes.md']);
});

test('a read-only turn imports nothing a checkpoint kept, and leaves an earlier piece as it was', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'readonly-checkpoint-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const material = new MaterialStore(home, {}, () => {});
  const earlier = material.create('project', 'earlier.md', 'text/markdown', Buffer.from('e'), 'working', 'agent');
  let dispatched = 0;
  const gateway: Gateway = { conditionalWrites: true, read: unexpectedMaterialRead, async write(_t, effect, perform) { dispatched++; const r = await perform(); if (r === 'stopped') return undefined; effect.outcome = 'DONE'; return r; } };
  let saved: Checkpoint | null = { files: [{ name: 'earlier.md', body: 'e', targetVersion: null }, { name: 'later.md', body: 'l', targetVersion: null }], sources: [] };
  const checkpoints = { load: () => saved, save: async (c: Checkpoint) => { saved = c; }, clear: async () => { saved = null; } };
  const turn: Turn = { id: 'turn', side: false, user: { text: 'Review', attachments: [], at: '' }, work: { startedAt: '', harness: 'controlled', steps: [] },
    effects: [{ key: 'k', kind: 'write-working-copy', target: 'earlier.md', outcome: 'DONE' }], status: 'running' };
  await runHarnessTurn({ material, projectId: 'project', gateway, writeDelayMs: 0, signal: new AbortController().signal, threadId: 'thread',
    harness: { specificationVersion: 'v1', id: 'controlled', label: 'controlled', start: () => { throw new Error('no producer on recovery'); } },
    route: { kind: 'native', provider: 'codex', baseUrl: '', model: 'controlled', label: 'controlled', credential: null },
    credential: async () => { throw new Error('No credential in this test'); }, history: [], resumed: true, checkpoints, progress() {}, readOnly: true,
  }, turn, []);
  assert.equal(dispatched, 0);
  assert.deepEqual(material.list('project', true).map((e) => e.name), ['earlier.md']);
  assert.equal(material.load(earlier.id)!.unsure, undefined, 'no metadata changed either');
});

function learner() {
  const home = mkdtempSync(join(tmpdir(), 'readonly-memory-'));
  const memory = createMemory({
    home, userHome: mkdtempSync(join(tmpdir(), 'readonly-memory-user-')), threads: new Map(), emit() {}, projectExists: () => true, credentials: async () => [], now: Date.now,
    material: { load: () => ({ withdrawals: [] }) } as never, brief() {}, unbrief() {}, locked: async <T,>(fn: () => Promise<T>) => fn(),
  });
  return { home, memory };
}
const told = (over: Partial<Turn> = {}): Turn => ({ id: `turn-${Math.random()}`, side: false, effects: [], status: 'done',
  user: { text: 'Our office is in Lisbon.', attachments: [], at: '' }, work: { startedAt: '', harness: 'pi', steps: [] }, answer: { text: 'Reviewed.', files: [] }, ...over });
const threadWith = (turn: Turn, child?: { role: string }) => ({ summary: { id: 'thread-1', projectId: 'p', title: 'T', pinned: false, unread: false, archived: false, running: false, updatedAt: '' },
  turns: [turn], sideTurns: [], clientKeys: ['k'], ...(child ? { child } : {}) }) as unknown as StoredThread;

test('nothing a reviewer or judge turn was shown becomes the person\'s memory; an ordinary turn still teaches it', async (t) => {
  const { home, memory } = learner();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const reviewed = told();
  await memory.learn(threadWith(reviewed, { role: 'reviewer' }), reviewed);
  assert.equal(reviewed.memory?.remembered, undefined, 'a reviewer\'s brief is not the person speaking');
  const judged = told({ judge: { verdict: null, detail: '' } });
  await memory.learn(threadWith(judged), judged);
  assert.equal(judged.memory?.remembered, undefined);
  const ordinary = told();
  await memory.learn(threadWith(ordinary), ordinary);
  assert.equal(ordinary.memory?.remembered?.length, 1, 'the control: the same words from the person are kept');
});
