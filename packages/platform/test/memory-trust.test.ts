import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { MemoryStore } from '../src/memory/store.ts';
import { freshHome } from './helpers.ts';

const live = () => 'current' as const;

test('recalled memory distinguishes personal, imported and external words without making any instructions', () => {
  const store = new MemoryStore(freshHome());
  store.setInstructions({ scope: 'person', text: 'Use metric units.' });
  const personal = store.add({ topic: 'launch', text: 'The launch budget is 40k.', origin: { kind: 'turn' }, sources: [] }, live)!;
  const imported = store.add({ topic: 'launch', text: 'The launch venue is Porto.', origin: { kind: 'import', source: 'notes.md' }, sources: [] }, live)!;
  const web = store.add({ topic: 'launch', text: 'The launch website lists Friday.', origin: { kind: 'import', source: 'https://example.test/launch' }, sources: [] }, live)!;
  const derived = store.add({ topic: 'launch', text: 'The launch estimate is provisional.', origin: { kind: 'engine' }, sources: [{ id: 'doc', name: 'quote.md', version: 1 }] }, live)!;
  assert.equal(personal.trust, 'personal');
  assert.equal(imported.trust, 'imported');
  assert.equal(web.trust, 'untrusted');
  assert.equal(derived.trust, 'untrusted');
  const recall = store.recall('p', 'launch', live, []);
  assert.equal(recall.used.length, 4);
  assert.ok(recall.instructions.includes('Use metric units.'));
  for (const entry of [personal, imported, web, derived]) {
    assert.ok(recall.text.includes(entry.text));
    assert.ok(!recall.instructions.includes(entry.text));
    const line = recall.text.split('\n').find((line) => line.includes(entry.text))!;
    assert.ok(line.includes(`[${entry.trust}]`), 'every recalled line identifies its tier');
  }
  assert.ok(/untrusted/i.test(recall.text));
  assert.deepEqual(store.search('launch', live).map((e) => e.trust).sort(), ['imported', 'personal', 'untrusted', 'untrusted']);
});

test('equal relevance prefers personal provenance but relevant external lines remain findable', () => {
  const store = new MemoryStore(freshHome());
  const personal = store.add({ topic: 'launch', text: 'The launch is Friday.', origin: { kind: 'person' }, sources: [] }, live)!;
  const external = store.add({ topic: 'launch', text: 'The launch is Monday.', origin: { kind: 'import', source: 'notes.md' }, sources: [] }, live)!;
  assert.equal(store.search('launch', live)[0].id, personal.id);
  assert.equal(store.search('Monday', live)[0].id, external.id);
});

test('duplicate, merge, undo and reopen retain the least trusted contributing provenance', () => {
  const home = freshHome();
  const store = new MemoryStore(home);
  const a = store.add({ topic: 'launch', text: 'The launch is Friday.', origin: { kind: 'import', source: 'notes.md' }, sources: [] }, live)!;
  const b = store.add({ topic: 'launch', text: 'The launch is in Porto.', origin: { kind: 'person' }, sources: [] }, live)!;
  assert.equal(store.add({ topic: a.topic, text: a.text, origin: { kind: 'person' }, sources: [] }, live)!.trust, 'imported');
  const merged = store.merge({ id: randomUUID(), topic: a.topic, text: 'The launch is Friday in Porto.', origin: { kind: 'merge' }, sources: [], at: new Date().toISOString(), replaces: [a, b].map(({ id, text }) => ({ id, text })) }, live)!;
  assert.equal(merged.trust, 'imported');
  assert.equal(new MemoryStore(home).list(live)[0].trust, 'imported');
  store.forget(merged.id);
  assert.equal(store.restore([merged], live), 1);
  assert.equal(new MemoryStore(home).list(live)[0].trust, 'imported');
});

test('old metadata and direct human edits preserve provenance without rewriting the person\'s words', () => {
  const home = freshHome();
  const store = new MemoryStore(home);
  const line = store.add({ topic: 'launch', text: 'The launch estimate is provisional.', origin: { kind: 'engine' }, sources: [] }, live)!;
  const sidecar = join(home, 'memory', '.entries.json');
  const metadata = JSON.parse(readFileSync(sidecar, 'utf8'));
  delete metadata[line.id].trust;
  writeFileSync(sidecar, JSON.stringify(metadata));
  const topic = join(home, 'memory', 'topics', 'launch.md');
  const edited = readFileSync(topic, 'utf8').replace('provisional', 'final');
  writeFileSync(topic, edited);
  const entry = new MemoryStore(home).list(live)[0];
  assert.equal(entry.origin.kind, 'person', 'human edits still own their line');
  assert.equal(entry.trust, 'untrusted', 'editing an old engine line does not silently promote its provenance');
  assert.equal(readFileSync(topic, 'utf8'), edited);
});
