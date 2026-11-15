import { syntheticMaterialReader, unexpectedMaterialRead } from './fixtures/synthetic-material-reader.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Turn } from '../src/api.ts';
import { runHarnessTurn } from '../src/composition/harness-turn.ts';
import type { HarnessV1 } from '../src/ports/harness.ts';
import { MaterialStore } from '../src/stub/material.ts';

test('the synchronous material check binds an actual read, project, version and withdrawal generation', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'material-harness-identity-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const material = new MaterialStore(home, {}, () => {});
  const entry = material.create('p', 'note.md', 'text/markdown', Buffer.from('original'), 'working', 'person');
  const second = material.create('p', 'second.md', 'text/markdown', Buffer.from('second'), 'working', 'person');
  const other = material.create('other', 'note.md', 'text/markdown', Buffer.from('other'), 'working', 'person');
  const turn: Turn = { id: 'turn', side: false, status: 'running', user: { text: 'Read', attachments: [], at: '' }, work: { startedAt: '', harness: 'test', steps: [] }, effects: [] };
  let finishedChecks = false;
  const harness: HarnessV1 = { specificationVersion: 'v1', id: 'test', label: 'test', start(_request, { tools }) {
    const outcome = (async () => {
      const found = (await tools.list())[0];
      assert.deepEqual([found.materialId, found.projectId, found.withdrawals], [entry.id, 'p', 0]);
      const identity = { materialId: found.materialId!, projectId: found.projectId!, version: found.version, withdrawals: found.withdrawals! };
      assert.notEqual(tools.stillGranted!([identity]), true, 'listing alone does not bind a read');
      await tools.read('note.md'); assert.equal(tools.stillGranted!([identity]), true);
      assert.notEqual(tools.stillGranted!([null as never]), true);
      assert.notEqual(tools.stillGranted!(null as never), true);
      assert.notEqual(tools.stillGranted!([{ ...identity, projectId: 'other', materialId: other.id }]), true);
      material.withdraw(entry.id); assert.notEqual(tools.stillGranted!([identity]), true);
      material.restore(entry.id); assert.notEqual(tools.stillGranted!([identity]), true, 'restoring never revives a prior read');
      assert.equal(await tools.read('note.md'), null, 'the prior withdrawn read keeps this turn tainted');
      assert.notEqual(tools.stillGranted!([{ ...identity, withdrawals: 1 }]), true, 'the caller cannot forge a restored generation');
      const newer = (await tools.read('second.md'))!;
      const secondRead = { materialId: newer.materialId!, projectId: newer.projectId!, version: newer.version, withdrawals: newer.withdrawals! };
      assert.notEqual(tools.stillGranted!([secondRead]), true, 'omitting another withdrawn read cannot restore authority');
      assert.notEqual(tools.stillGranted!([]), true, 'an empty list cannot erase the turn’s withdrawn reads');
      await material.save(second.id, 'human edit', 1); assert.notEqual(tools.stillGranted!([secondRead]), true);
      finishedChecks = true;
      return { status: 'done' as const, answer: 'done', usage: { input: 0, output: 0 } };
    })();
    return { events: (async function* () {})(), outcome, steer() {}, stop() {} };
  } };
  await runHarnessTurn({ material, projectId: 'p', gateway: { read: syntheticMaterialReader(home, material, 'p'), async write() { throw new Error('No writes'); } }, writeDelayMs: 0,
    signal: new AbortController().signal, threadId: 'thread', harness, route: { kind: 'endpoint', provider: 'openai-compatible', baseUrl: 'http://localhost', model: 'fixture', label: 'fixture', credential: null },
    credential: async () => { throw new Error('No credential'); }, history: [], resumed: false, progress() {} }, turn, []);
  assert.equal(finishedChecks, true, JSON.stringify(turn));
  assert.equal(turn.withheld, true, 'the withdrawn source also withholds the answer');
});

test('a withdrawn connector source refuses dispatch even if no file identity was passed', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'material-connector-identity-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const material = new MaterialStore(home, {}, () => {});
  const connector = material.create('p', 'connector.md', 'text/markdown', Buffer.from('synthetic connector result'), 'original', 'person');
  const turn: Turn = { id: 'turn', side: false, status: 'running', user: { text: 'Read', attachments: [], at: '' }, work: { startedAt: '', harness: 'test', steps: [] }, effects: [] };
  let checked = false;
  const harness: HarnessV1 = { specificationVersion: 'v1', id: 'test', label: 'test', start(_request, { tools }) {
    const outcome = (async () => {
      (turn.reads ??= []).push({ id: connector.id, name: connector.name, version: connector.current, withdrawals: 0 });
      assert.equal(tools.stillGranted!([]), true, 'a live recorded connector source is allowed');
      material.withdraw(connector.id);
      assert.notEqual(tools.stillGranted!([]), true, 'the withdrawn connector source blocks dispatch');
      checked = true; return { status: 'done' as const, answer: 'done', usage: { input: 0, output: 0 } };
    })(); return { events: (async function* () {})(), outcome, steer() {}, stop() {} };
  } };
  await runHarnessTurn({ material, projectId: 'p', gateway: { read: unexpectedMaterialRead, async write() { throw new Error('No writes'); } }, writeDelayMs: 0,
    signal: new AbortController().signal, threadId: 'thread', harness, route: { kind: 'endpoint', provider: 'openai-compatible', baseUrl: 'http://localhost', model: 'fixture', label: 'fixture', credential: null },
    credential: async () => { throw new Error('No credential'); }, history: [], resumed: false, progress() {} }, turn, []);
  assert.equal(checked, true, JSON.stringify(turn));
});

test('visible but held or withdrawn records never reach ToolHost list or read', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'material-held-visible-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const material = new MaterialStore(home, {}, () => {});
  const normal = material.create('p', 'normal.md', 'text/markdown', Buffer.from('ordinary'), 'original', 'person');
  const held = material.create('p', 'held.md', 'text/markdown', Buffer.from('held secret'), 'working', 'agent');
  const withdrawn = material.create('p', 'withdrawn.md', 'text/markdown', Buffer.from('withdrawn secret'), 'original', 'person');
  material.mark(held.id, { hidden: false, held: { id: normal.id, name: normal.name } });
  material.withdraw(withdrawn.id); material.mark(withdrawn.id, { hidden: false });
  const turn: Turn = { id: 'turn', side: false, status: 'running', user: { text: 'Read', attachments: [], at: '' }, work: { startedAt: '', harness: 'test', steps: [] }, effects: [] };
  let checked = false, reads = 0;
  const harness: HarnessV1 = { specificationVersion: 'v1', id: 'test', label: 'test', start(_request, { tools }) {
    const outcome = (async () => { assert.deepEqual((await tools.list()).map((f) => f.name), ['normal.md']); assert.equal(await tools.read('held.md'), null); assert.equal(await tools.read('withdrawn.md'), null); assert.equal((await tools.read('normal.md'))?.text, 'ordinary'); checked = true; return { status: 'done' as const, answer: 'done', usage: { input: 0, output: 0 } }; })();
    return { events: (async function* () {})(), outcome, steer() {}, stop() {} };
  } };
  await runHarnessTurn({ material, projectId: 'p', gateway: { read: syntheticMaterialReader(home, material, 'p', { onRead: async () => { reads++; } }), async write() { throw new Error('No writes'); } }, writeDelayMs: 0, signal: new AbortController().signal, threadId: 'thread', harness, route: { kind: 'endpoint', provider: 'openai-compatible', baseUrl: 'http://localhost', model: 'fixture', label: 'fixture', credential: null }, credential: async () => { throw new Error('No credential'); }, history: [], resumed: false, progress() {} }, turn, []);
  assert.equal(checked, true); assert.equal(reads, 1);
});

for (const opened of [false, true]) test(`staged project files are availability, with observed read=${opened}`, async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'material-staged-sources-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const material = new MaterialStore(home, {}, () => {});
  const entries = ['downloads-review.md', 'away-check.md'].map(name => material.create('p', name, 'text/markdown', Buffer.from('Synthetic project text'), 'working', 'person'));
  const turn: Turn = { id: 'turn', side: false, status: 'running', user: { text: opened ? 'Use downloads-review.md' : 'What is on my calendar today?', attachments: [], at: '' }, work: { startedAt: '', harness: 'test', steps: [] }, effects: [] };
  let checked = false;
  const harness: HarnessV1 = { specificationVersion: 'v1', id: 'test', label: 'test', start(_request, { tools }) {
    const outcome = (async () => {
      for (const file of await tools.list({ purpose: 'staging' })) await tools.read(file.name, { purpose: 'staging' });
      assert.deepEqual(turn.work.steps.filter(s => s.kind === 'list'), [], 'a staging listing records no listing step');
      if (opened) await tools.read(entries[0].name);
      assert.deepEqual(turn.work.steps.filter(s => s.kind === 'read').map(s => s.label), opened ? ['Read downloads-review.md v1'] : []);
      assert.deepEqual(turn.reads!.filter(r => !r.available).map(r => r.name), opened ? ['downloads-review.md'] : []);
      assert.deepEqual([...new Set(turn.reads!.map(r => r.id))].sort(), entries.map(e => e.id).sort());
      assert.equal(turn.work.steps.filter(s => s.label === 'Made 2 project files available').length, 1);
      assert.equal(tools.stillGranted!([]), true);
      material.withdraw(entries[1].id);
      assert.notEqual(tools.stillGranted!([]), true, 'an unopened staged source still blocks delivery');
      checked = true;
      return { status: 'done' as const, answer: 'Synthetic answer', usage: { input: 0, output: 0 } };
    })();
    return { events: (async function* () {})(), outcome, steer() {}, stop() {} };
  } };
  await runHarnessTurn({ material, projectId: 'p', gateway: { read: syntheticMaterialReader(home, material, 'p'), async write() { throw new Error('No writes'); } }, writeDelayMs: 0,
    signal: new AbortController().signal, threadId: 'thread', harness, route: { kind: 'endpoint', provider: 'openai-compatible', baseUrl: 'http://localhost', model: 'fixture', label: 'fixture', credential: null },
    credential: async () => { throw new Error('No credential'); }, history: [], resumed: false, tell: () => ({ roleTools: ['Glob', 'Read'] }), progress() {} }, turn, []);
  assert.equal(checked, true, JSON.stringify(turn));
  assert.equal(turn.withheld, true);
});

test('a listing the model asks for still records a listing step', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'material-ordinary-list-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const material = new MaterialStore(home, {}, () => {});
  for (const name of ['one.md', 'two.md']) material.create('p', name, 'text/markdown', Buffer.from('Synthetic project text'), 'working', 'person');
  const turn: Turn = { id: 'turn', side: false, status: 'running', user: { text: 'List', attachments: [], at: '' }, work: { startedAt: '', harness: 'test', steps: [] }, effects: [] };
  const harness: HarnessV1 = { specificationVersion: 'v1', id: 'test', label: 'test', start(_request, { tools }) {
    const outcome = (async () => {
      await tools.list({ purpose: 'staging' });
      assert.deepEqual(turn.work.steps.map(s => s.label), []);
      assert.equal((await tools.list()).length, 2);
      assert.deepEqual(turn.work.steps.filter(s => s.kind === 'list').map(s => s.label), ['Listed 2 file(s)']);
      return { status: 'done' as const, answer: 'Synthetic answer', usage: { input: 0, output: 0 } };
    })();
    return { events: (async function* () {})(), outcome, steer() {}, stop() {} };
  } };
  await runHarnessTurn({ material, projectId: 'p', gateway: { read: syntheticMaterialReader(home, material, 'p'), async write() { throw new Error('No writes'); } }, writeDelayMs: 0,
    signal: new AbortController().signal, threadId: 'thread', harness, route: { kind: 'endpoint', provider: 'openai-compatible', baseUrl: 'http://localhost', model: 'fixture', label: 'fixture', credential: null },
    credential: async () => { throw new Error('No credential'); }, history: [], resumed: false, progress() {} }, turn, []);
});
