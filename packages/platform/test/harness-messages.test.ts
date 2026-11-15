import { unexpectedMaterialRead } from './fixtures/synthetic-material-reader.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHarnessTurn } from '../src/composition/harness-turn.ts';
import { MaterialStore } from '../src/stub/material.ts';
import type { Turn } from '../src/api.ts';
import type { HarnessEvent, HarnessV1 } from '../src/ports/harness.ts';

test('native item snapshots show progress separately, preserve exact result versions and do not invent canonical effects', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'harness-message-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const material = new MaterialStore(home, {}, () => {});
  const result = material.create('project', 'result.md', 'text/markdown', Buffer.from('agent v1'), 'working', 'agent');
  assert.equal((await material.save(result.id, 'person v2', 1)).ok, true);
  const turn: Turn = { id: 'turn', side: false, user: { text: 'Continue', attachments: [], at: '' }, work: { startedAt: '', harness: 'native fixture', steps: [] }, effects: [], status: 'running' };
  const events: HarnessEvent[] = [
    { type: 'text', delta: 'Working.', message: { id: 'note', text: 'Working.', phase: 'commentary', complete: false } },
    { type: 'text', delta: 'Still working.', message: { id: 'note', text: 'Still working.', phase: 'commentary', complete: true } },
    { type: 'tool', id: 'cmd', tool: 'native_staged', phase: 'proposed', label: 'Work in temporary drafts' },
    { type: 'tool', id: 'cmd', tool: 'native_staged', phase: 'done', label: 'Work in temporary drafts' },
    { type: 'text', delta: 'Old streamed wording', message: { id: 'final', text: 'Old streamed wording', phase: 'final_answer', complete: false } },
    { type: 'text', delta: '', message: { id: 'final', text: 'Actual final answer.', phase: 'final_answer', complete: true } },
    { type: 'usage', input: 5, output: 2 },
  ];
  const snapshots: { text?: string; files: unknown; usage: unknown }[] = [];
  const harness: HarnessV1 = { specificationVersion: 'v1', id: 'native-fixture', label: 'native fixture', start() {
    return { events: (async function* () { yield* events; })(), steer() {}, stop() {}, outcome: Promise.resolve({ status: 'done', answer: 'Actual final answer.', usage: { input: 5, output: 2 } }) };
  } };
  await runHarnessTurn({ material, projectId: 'project', gateway: { read: unexpectedMaterialRead, async write() { throw new Error('No canonical write was requested'); } },
    writeDelayMs: 0, signal: new AbortController().signal, threadId: 'thread', harness,
    route: { kind: 'native', provider: 'codex', baseUrl: '', model: 'fixture', label: 'fixture', credential: null },
    credential: async () => { throw new Error('No credential access'); }, history: [], resumed: false,
    recoveredFiles: [{ materialId: result.id, name: result.name, version: 1 }],
    progress() { snapshots.push({ text: turn.answer?.text, files: structuredClone(turn.answer?.files), usage: structuredClone(turn.work.usage) }); },
  }, turn, []);
  assert.equal(snapshots[0].text, '', 'commentary belongs in the existing work block');
  assert.ok(snapshots.some((s) => s.text === 'Actual final answer.'), 'complete snapshot replaces provisional text before final outcome');
  assert.deepEqual(turn.work.steps, [{ kind: 'note', label: 'Still working.' }, { kind: 'note', label: 'Work in temporary drafts · completed in staging' }]);
  assert.deepEqual(turn.effects, []);
  assert.deepEqual(turn.answer, { text: 'Actual final answer.', files: [{ materialId: result.id, name: result.name, version: 1 }] });
  assert.equal(material.load(result.id)?.current, 2);
  assert.equal(Buffer.from(material.bytes(result.id, 2)).toString(), 'person v2');
  assert.deepEqual(turn.work.usage, { input: 5, output: 2 });
  assert.equal(turn.status, 'done');
});

test('delta-only harnesses remain compatible with the existing stream consumer', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'harness-legacy-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const material = new MaterialStore(home, {}, () => {});
  const turn: Turn = { id: 'turn', side: false, user: { text: 'Hello', attachments: [], at: '' }, work: { startedAt: '', harness: 'legacy', steps: [] }, effects: [], status: 'running' };
  const text: string[] = [];
  const harness: HarnessV1 = { specificationVersion: 'v1', id: 'legacy', label: 'legacy', start() {
    return { events: (async function* () { yield { type: 'text' as const, delta: 'Hello ' }; yield { type: 'text' as const, delta: 'world.' }; })(),
      outcome: Promise.resolve({ status: 'done', answer: 'Hello world.', usage: { input: 0, output: 0 } }), stop() {}, steer() {} };
  } };
  await runHarnessTurn({ material, projectId: 'project', gateway: { read: unexpectedMaterialRead, async write() { throw new Error('No write'); } },
    writeDelayMs: 0, signal: new AbortController().signal, threadId: 'thread', harness,
    route: { kind: 'endpoint', provider: 'openai-compatible', baseUrl: 'http://localhost', model: 'fixture', label: 'fixture', credential: null },
    credential: async () => { throw new Error('No credential'); }, history: [], resumed: false,
    progress() { text.push(turn.answer?.text ?? ''); },
  }, turn, []);
  // Streamed words are saved together (at most every 200 ms); the last save holds the whole answer.
  assert.equal(text.at(-1), 'Hello world.');
  assert.equal(turn.answer?.text, 'Hello world.');
  assert.deepEqual(turn.work.steps, []);
  assert.equal(turn.status, 'done');
});

for (const phase of [null, 'final_answer'] as const) {
  test(`v2 platform applies terminal order before outcome accounting (${phase})`, async (t) => {
    const home = mkdtempSync(join(tmpdir(), 'harness-order-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const material = new MaterialStore(home, {}, () => {});
    const turn: Turn = { id: 'turn', side: false, user: { text: 'Continue', attachments: [], at: '' }, work: { startedAt: '', harness: 'fixture', steps: [] }, effects: [], status: 'running' };
    const first = { id: 'first', phase, text: 'Earlier.', complete: true }, last = { id: 'last', phase, text: 'Actual last answer.', complete: true };
    const events: HarnessEvent[] = [
      { type: 'text', delta: last.text, message: last },
      { type: 'text', delta: first.text, message: first },
      { type: 'messages', messages: [first, last] },
    ];
    const snapshots: string[] = [];
    const harness: HarnessV1 = { specificationVersion: 'v1', id: 'fixture', label: 'fixture', start() {
      return { events: (async function* () { yield* events; })(),
        outcome: Promise.resolve({ status: 'done', answer: last.text, usage: { input: 0, output: 0 } }), stop() {}, steer() {} };
    } };
    await runHarnessTurn({ material, projectId: 'project', gateway: { read: unexpectedMaterialRead, async write() { throw new Error('No write'); } },
      writeDelayMs: 0, signal: new AbortController().signal, threadId: 'thread', harness,
      route: { kind: 'native', provider: 'codex', baseUrl: '', model: 'fixture', label: 'fixture', credential: null },
      credential: async () => { throw new Error('No credential'); }, history: [], resumed: false,
      progress() { snapshots.push(turn.answer?.text ?? ''); },
    }, turn, []);
    // The terminal order decides what is saved last, whatever order the deltas came in.
    assert.equal(snapshots.at(-1), last.text);
    assert.equal(turn.answer?.text, last.text);
    assert.equal(turn.status, 'done');
  });
}

test('streamed words are saved at most every 200 ms, and the turn waits for the last of them', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'harness-stream-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const material = new MaterialStore(home, {}, () => {});
  const turn: Turn = { id: 'turn', side: false, user: { text: 'Write', attachments: [], at: '' }, work: { startedAt: '', harness: 'fast', steps: [] }, effects: [], status: 'running' };
  // A model writing 300 tokens over about 600 ms: before, every token wrote the thread and refreshed every view.
  const words = Array.from({ length: 300 }, (_, i) => `w${i} `);
  const harness: HarnessV1 = { specificationVersion: 'v1', id: 'fast', label: 'fast', start() {
    return { events: (async function* () { for (const w of words) { yield { type: 'text' as const, delta: w }; await new Promise((r) => setTimeout(r, 2)); } })(),
      outcome: Promise.resolve({ status: 'done', answer: words.join(''), usage: { input: 0, output: 0 } }), stop() {}, steer() {} };
  } };
  const saved: string[] = [];
  await runHarnessTurn({ material, projectId: 'project', gateway: { read: unexpectedMaterialRead, async write() { throw new Error('No write'); } },
    writeDelayMs: 0, signal: new AbortController().signal, threadId: 'thread', harness,
    route: { kind: 'native', provider: 'codex', baseUrl: '', model: 'fixture', label: 'fixture', credential: null },
    credential: async () => { throw new Error('No credential access'); }, history: [], resumed: false, recoveredFiles: [],
    progress() { saved.push(turn.answer?.text ?? ''); },
  }, turn, []);
  assert.ok(saved.length <= 12, `saved ${saved.length} times for 300 streamed words`);
  assert.ok(saved.includes(words.join('')), 'the whole answer was saved before the turn settled');
  assert.equal(turn.answer?.text, words.join(''));
});

test('a sub-agent the engine spawned, and what it ran, are shown in the work of its turn', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'harness-subagent-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const material = new MaterialStore(home, {}, () => {});
  const turn: Turn = { id: 'turn', side: false, user: { text: 'Delegate', attachments: [], at: '' }, work: { startedAt: '', harness: 'native fixture', steps: [] }, effects: [], status: 'running' };
  const events: HarnessEvent[] = [
    { type: 'tool', id: 'subagent:child', tool: 'native_subagent', phase: 'proposed', label: 'Sub-agent /root/helper started' },
    { type: 'tool', id: 'child-command', tool: 'native_subagent', phase: 'done', label: 'Sub-agent /root/helper ran cat note.md' },
    { type: 'tool', id: 'subagent:child', tool: 'native_subagent', phase: 'done', label: 'Sub-agent /root/helper finished' },
    { type: 'text', delta: 'Done.' },
  ];
  const harness: HarnessV1 = { specificationVersion: 'v1', id: 'native-fixture', label: 'native fixture', start() {
    return { events: (async function* () { yield* events; })(), steer() {}, stop() {}, outcome: Promise.resolve({ status: 'done', answer: 'Done.', usage: { input: 0, output: 0 } }) };
  } };
  await runHarnessTurn({ material, projectId: 'project', gateway: { read: unexpectedMaterialRead, async write() { throw new Error('No write'); } },
    writeDelayMs: 0, signal: new AbortController().signal, threadId: 'thread', harness,
    route: { kind: 'native', provider: 'codex', baseUrl: '', model: 'fixture', label: 'fixture', credential: null },
    credential: async () => { throw new Error('No credential access'); }, history: [], resumed: false, recoveredFiles: [], progress() {},
  }, turn, []);
  assert.deepEqual(turn.work.steps, [
    { kind: 'note', label: 'Sub-agent /root/helper finished' },
    { kind: 'note', label: 'Sub-agent /root/helper ran cat note.md' },
  ]);
  assert.deepEqual(turn.effects, [], 'the work of a sub-agent is staged, never a canonical effect');
});

test('native command and output details are redacted before every Host projection', async t => {
  const home = mkdtempSync(join(tmpdir(), 'native-redaction-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const material = new MaterialStore(home, {}, () => {});
  const known = 'fake-known-value-for-this-test';
  const bearer = 'fake-header-value-for-this-test', assigned = 'fake-export-value-for-this-test';
  const turn: Turn = { id: 'turn', side: false, user: { text: 'Inspect', attachments: [], at: '' }, work: { startedAt: '', harness: 'native', steps: [] }, effects: [], status: 'running' };
  const events: HarnessEvent[] = [
    { type: 'tool', id: 'curl', tool: 'native_staged', phase: 'done', label: 'Work in temporary drafts', detail: `curl -H "Authorization: Bearer ${bearer}" https://example.invalid; output: ${known}` },
    { type: 'tool', id: 'export', tool: 'native_subagent', phase: 'done', label: `export X_TOKEN=${assigned}`, detail: 'Authorization: Basic dXNlcjpmYWtlLXBhc3N3b3Jk\nKEY=short SECRET="two words" PASSWORD=secret sk-proj-fake1234567890ABCDEF\nQ7nB4xV9kT2mW8cR5pH3yL6sF1dJ0aZq' }, // public-tree: synthetic
  ];
  const harness: HarnessV1 = { specificationVersion: 'v1', id: 'native-fixture', label: 'native', start() { return { events: (async function* () { yield* events; })(), steer() {}, stop() {}, outcome: Promise.resolve({ status: 'done', answer: 'Done.', usage: { input: 0, output: 0 } }) }; } };
  const projections: string[] = [];
  await runHarnessTurn({ material, projectId: 'project', gateway: { read: unexpectedMaterialRead, async write() { throw Error('No write'); } }, writeDelayMs: 0, signal: new AbortController().signal, threadId: 'thread', harness,
    route: { kind: 'native', provider: 'codex', baseUrl: '', model: 'fixture', label: 'fixture', credential: null }, credential: async () => { throw Error('No route credential'); }, credentials: async () => [known], history: [], resumed: false,
    progress() { projections.push(JSON.stringify(turn)); },
  }, turn, []);
  const saved = projections.join('\n');
  for (const value of [known, bearer, assigned, 'dXNlcjpmYWtlLXBhc3N3b3Jk', 'short', 'two words', 'sk-proj-fake1234567890ABCDEF', 'Q7nB4xV9kT2mW8cR5pH3yL6sF1dJ0aZq']) assert.ok(!saved.includes(value), value); // public-tree: synthetic
  assert.match(saved, /Authorization: Bearer \[credential\]/); assert.match(saved, /X_TOKEN=\[credential\]/);
  assert.equal(turn.status, 'done');
});


test('only inspection-relevant native steps and unknown outcomes retain an ISO observation time', async t => {
  const home = mkdtempSync(join(tmpdir(), 'harness-step-times-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const material = new MaterialStore(home, {}, () => {});
  const turn: Turn = { id: 'turn', side: false, user: { text: 'Work', attachments: [], at: '' }, work: { startedAt: '', harness: 'fixture', steps: [] }, effects: [], status: 'running' };
  const events: HarnessEvent[] = [
    { type: 'tool', id: 'read', tool: 'native_connector', readOnly: true, phase: 'done', label: 'Read the account' },
    { type: 'tool', id: 'write', tool: 'native_connector', readOnly: false, phase: 'proposed', label: 'Change the account' },
    { type: 'tool', id: 'write', tool: 'native_connector', readOnly: false, phase: 'done', label: 'Changed the account' },
    { type: 'tool', id: 'uncertain', tool: 'other', phase: 'unknown', label: 'Uncertain action' },
  ];
  const observed: string[] = [];
  const harness: HarnessV1 = { specificationVersion: 'v1', id: 'fixture', label: 'fixture', start() {
    return { events: (async function* () { yield* events; })(), stop() {}, steer() {}, outcome: Promise.resolve({ status: 'done', answer: 'Finished.', usage: { input: 0, output: 0 } }) };
  } };
  await runHarnessTurn({ material, projectId: 'project', gateway: { read: unexpectedMaterialRead, async write() { throw Error('No write'); } },
    writeDelayMs: 0, signal: new AbortController().signal, threadId: 'thread', harness,
    route: { kind: 'native', provider: 'codex', baseUrl: '', model: 'fixture', label: 'fixture', credential: null },
    credential: async () => { throw Error('No credential'); }, history: [], resumed: false,
    progress() { const at = turn.work.steps.find(s => s.label.includes('account') && s.at)?.at; if (at) observed.push(at); },
  }, turn, []);
  assert.equal(turn.work.steps.length, 3);
  assert.deepEqual(turn.work.steps[0], { kind: 'note', label: 'Read the account' });
  for (const step of turn.work.steps.slice(1)) assert.equal(new Date(step.at!).toISOString(), step.at);
  assert.ok(observed.length >= 2);
  assert.equal(new Set(observed).size, 1, 'later phases preserve the first observation time');
});
