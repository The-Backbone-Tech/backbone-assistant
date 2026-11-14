import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHarnessTurn } from '../src/composition/harness-turn.ts';
import { MaterialStore } from '../src/stub/material.ts';
import type { Turn } from '../src/api.ts';
import type { HarnessEvent, HarnessV1 } from '../src/ports/harness.ts';
import { unexpectedMaterialRead } from './fixtures/synthetic-material-reader.ts';

for (const hint of [false, true, 'completion'] as const) for (const phase of ['done', 'failed', 'refused', 'unknown'] as const) test(`native connector readOnly=${hint} ${phase} is one work step, never a canonical receipt`, async t => {
  const readOnly = hint !== false;
  const startedReadOnly = hint === true;
  const home = mkdtempSync(join(tmpdir(), 'native-connector-work-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const material = new MaterialStore(home, {}, () => {});
  const turn: Turn = { id: 'turn', side: false, user: { text: 'Read calendar', attachments: [], at: '' }, work: { startedAt: '', harness: 'native fixture', steps: [] }, effects: [], status: 'running' };
  const events: HarnessEvent[] = [
    { type: 'tool', id: 'call', tool: 'native_connector', readOnly: startedReadOnly, phase: 'proposed', label: 'Codex connector calendar / search', detail: 'Running in Codex.' },
    { type: 'tool', id: 'call', tool: 'native_connector', readOnly, phase, label: 'Codex connector calendar / search', detail: phase === 'done' ? 'Codex reported completion.' : 'Native status supplied.' },
  ];
  const harness: HarnessV1 = { specificationVersion: 'v1', id: 'native-fixture', label: 'native fixture', start() {
    return { events: (async function* () {
      yield events[0];
      const persisted = JSON.parse(readFileSync(join(home, 'progress.json'), 'utf8'));
      assert.equal(persisted.nativeAccountActivity === true, !startedReadOnly, 'native activity is saved before another event is consumed');
      assert.match(persisted.work.steps[0].label, /Running in Codex/);
      yield events[1];
    })(), steer() {}, stop() {}, outcome: Promise.resolve({ status: 'done', answer: 'Read complete.', usage: { input: 0, output: 0 } }) };
  } };
  const saved: string[] = [];
  await runHarnessTurn({ material, projectId: 'project', gateway: { read: unexpectedMaterialRead, async write() { throw new Error('No canonical effect'); } },
    writeDelayMs: 0, signal: new AbortController().signal, threadId: 'thread', harness,
    route: { kind: 'native', provider: 'codex', baseUrl: '', model: 'fixture', label: 'fixture', credential: null },
    credential: async () => { throw new Error('No API credentials'); }, history: [], resumed: false,
    progress() { writeFileSync(join(home, 'progress.json'), JSON.stringify(turn)); saved.push(...turn.work.steps.filter(step => step.kind === 'note').map(step => step.label)); },
  }, turn, []);
  assert.ok(saved.some(label => label.includes('Running in Codex.')), 'the pending native call is visible');
  assert.equal(turn.nativeAccountActivity === true, !readOnly);
  assert.equal(turn.work.steps.length, 1, 'terminal status replaces the pending step');
  assert.match(turn.work.steps[0].label, /Codex connector calendar \/ search/);
  assert.doesNotMatch(turn.work.steps[0].label, /staging/);
  assert.deepEqual(turn.effects, []);
  assert.equal(turn.status, phase === 'unknown' && !readOnly ? 'stopped' : 'done');
  assert.equal(turn.unknownOutcome === true, phase === 'unknown' && !readOnly);
});
