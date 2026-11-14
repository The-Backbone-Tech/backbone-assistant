import { unexpectedMaterialRead } from './fixtures/synthetic-material-reader.ts';
// The turn-start race: memory is read again right before the engine starts, after every wait, so a
// source withdrawn while the turn was being prepared never reaches the model.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Turn } from '../src/api.ts';
import { runHarnessTurn } from '../src/composition/harness-turn.ts';
import { MemoryStore } from '../src/memory/store.ts';
import type { HarnessV1, TurnRequest } from '../src/ports/harness.ts';
import type { Gateway } from '../src/stub/harness.ts';
import { MaterialStore } from '../src/stub/material.ts';

test('a source withdrawn while a turn starts takes its memory out of what the engine is given', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'memory-turn-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const material = new MaterialStore(home, {}, () => {});
  const doc = material.create('project', 'budget.md', 'text/markdown', Buffer.from('40k'), 'original', 'person');
  const store = new MemoryStore(home);
  const state = (id: string) => (material.load(id)?.withdrawals?.length ? 'withdrawn' as const : 'current' as const);
  store.add({ topic: 'facts', text: 'The budget is 40k.', origin: { kind: 'turn' }, sources: [{ id: doc.id, name: doc.name, version: 1 }] }, state);
  const gateway: Gateway = { conditionalWrites: true, read: unexpectedMaterialRead, async write() { return undefined; } };
  let given: TurnRequest | undefined;
  let delivered: { instructions?: string; memory?: string } | undefined;
  const harness: HarnessV1 = {
    specificationVersion: 'v1', id: 'test', label: 'test',
    start(request) {
      given = request;
      delivered = request.recall?.();
      return { events: (async function* () {})(), outcome: Promise.resolve({ status: 'done' as const, answer: 'ok', usage: { input: 0, output: 0 } }), steer() {}, stop() {} };
    },
  };
  const turn: Turn = { id: 'turn', side: false, user: { text: 'What is the budget?', attachments: [], at: 'a' }, work: { startedAt: 'a', harness: 'test', steps: [] }, effects: [], status: 'running', reads: [] };
  let withdrawn = false;
  let recordedBeforeWait = false;
  await runHarnessTurn({
    material, projectId: 'project', gateway, writeDelayMs: 0, signal: new AbortController().signal, threadId: 'thread', harness,
    route: { kind: 'native', provider: 'codex', baseUrl: '', model: 'test', label: 'test', credential: null },
    credential: async () => '', history: [], resumed: false,
    // The save made while the turn is prepared is where the person withdraws the document.
    progress() { if (!withdrawn) { withdrawn = true; recordedBeforeWait = !!turn.reads?.some((r) => r.id === doc.id && r.inherited); material.withdraw(doc.id); } },
    memory: { recall: (allowed) => {
      const r = store.recall('project', turn.user.text, state, [], allowed);
      return { instructions: r.instructions, text: r.text, record: { used: r.used, instructions: !!r.instructions, skills: [], remembered: [] }, sources: r.sources };
    } },
  }, turn, []);
  assert.ok(withdrawn);
  assert.ok(given);
  assert.doesNotMatch(delivered?.memory ?? '', /40k/);
  assert.deepEqual(turn.memory?.used, []);
  assert.ok(recordedBeforeWait, 'the recalled source was recorded as read before the wait');
  assert.ok(!turn.reads?.some((r) => r.id === doc.id), 'and once its line was left out of what was sent, it is not this turn\'s, so its answer stays clean');
});

test('an engine that stages before it builds the model input is given memory as it is then', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'memory-stage-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const material = new MaterialStore(home, {}, () => {});
  const doc = material.create('project', 'budget.md', 'text/markdown', Buffer.from('40k'), 'original', 'person');
  const store = new MemoryStore(home);
  const state = (id: string) => (material.load(id)?.withdrawals?.length ? 'withdrawn' as const : 'current' as const);
  store.add({ topic: 'facts', text: 'The budget is 40k.', origin: { kind: 'turn' }, sources: [{ id: doc.id, name: doc.name, version: 1 }] }, state);
  const gateway: Gateway = { conditionalWrites: true, read: unexpectedMaterialRead, async write() { return undefined; } };
  let built: string | undefined;
  const harness: HarnessV1 = {
    specificationVersion: 'v1', id: 'test', label: 'test',
    start(request) {
      // Like Codex: staging and connecting take time after start, and only then is the prompt built.
      const outcome = (async () => {
        await new Promise((r) => setTimeout(r, 20));
        material.withdraw(doc.id);
        built = request.recall ? request.recall().memory ?? '' : undefined;
        return { status: 'done' as const, answer: 'ok', usage: { input: 0, output: 0 } };
      })();
      return { events: (async function* () {})(), outcome, steer() {}, stop() {} };
    },
  };
  const turn: Turn = { id: 'turn', side: false, user: { text: 'What is the budget?', attachments: [], at: 'a' }, work: { startedAt: 'a', harness: 'test', steps: [] }, effects: [], status: 'running', reads: [] };
  await runHarnessTurn({
    material, projectId: 'project', gateway, writeDelayMs: 0, signal: new AbortController().signal, threadId: 'thread', harness,
    route: { kind: 'native', provider: 'codex', baseUrl: '', model: 'test', label: 'test', credential: null },
    credential: async () => '', history: [], resumed: false, progress() {},
    memory: { recall: (allowed) => {
      const r = store.recall('project', turn.user.text, state, [], allowed);
      return { instructions: r.instructions, text: r.text, record: { used: r.used, instructions: !!r.instructions, skills: [], remembered: [] }, sources: r.sources };
    } },
  }, turn, []);
  assert.equal(built, '', 'a source withdrawn while the engine staged takes its line out of the prompt');
  assert.deepEqual(turn.memory?.used, []);
});
