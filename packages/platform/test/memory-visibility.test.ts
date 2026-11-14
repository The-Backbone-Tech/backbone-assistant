import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { MemoryStore } from '../src/memory/store.ts';
import { Meaning } from '../src/memory/embeddings.ts';
import { judgeRequest } from '../src/memory/judge.ts';
import { memoryReferenceJson, memoryReferenceText } from '../src/memory/visible.ts';
import { visibilityAttacks } from './memory-scan-corpus.ts';
import { freshHome } from './helpers.ts';
const live = () => 'current' as const;
const hidden = /[\p{Cf}\p{Default_Ignorable_Code_Point}\p{Cc}\u2028\u2029]/u;

for (const { name, text } of visibilityAttacks) test(`invisible ${name} is visible in recall without changing stored text or provenance`, () => {
  const store = new MemoryStore(freshHome());
  const entry = store.add({ topic: 'notes', text: 'Original words.', origin: { kind: 'engine' }, sources: [] }, live)!;
  const path = join(store.root, 'topics', 'notes.md');
  const original = readFileSync(path, 'utf8').replace('Original words.', text);
  writeFileSync(path, original);
  const stored = store.list(live).find(e => e.id === entry.id)!;
  assert.equal(stored.text, text);
  assert.equal(stored.trust, 'untrusted');
  const recalled = store.recall('p', 'lunch Friday formatting', live, []);
  assert.ok(recalled.used.includes(entry.id));
  const item = recalled.text.split('\n').find(s => s.startsWith('- [untrusted] '))!;
  assert.doesNotMatch(item, hidden);
  assert.equal(JSON.parse(item.slice('- [untrusted] '.length)), memoryReferenceText(text));
  assert.equal(store.search('lunch Friday formatting', live)[0].text, text, 'credential filtering still receives original bytes');
  assert.equal(store.candidates(live)[0].text, text, 'judge snapshots and cache identity remain raw until the boundary');
  assert.equal(readFileSync(path, 'utf8'), original);
});

test('pending proposals are visibly encoded before the bare judge sees them', () => {
  const text = visibilityAttacks[0].text;
  const proposal = { id: 'p', text, topic: 'notes', origin: { kind: 'engine' as const }, sources: [], at: new Date().toISOString() };
  const request = judgeRequest([], [proposal]);
  // Newlines between JSON fields are layout, not concealed bytes inside a line.
  assert.doesNotMatch(request.text.replace(/\n/g, ''), hidden);
  const data = JSON.parse(request.text.slice(request.text.lastIndexOf('\n{\n') + 1));
  assert.equal(data.proposed[0].text, memoryReferenceText(text));
  assert.equal(request.handles.get('P1'), proposal.id);
  assert.equal(proposal.text, text);
});

test('embeddings receive visible text only after original-byte credential checks', async () => {
  const home = freshHome();
  new MemoryStore(home);
  const text = visibilityAttacks[0].text;
  const secret = `private\u2063value`;
  const sent: string[][] = [];
  const meaning = new Meaning(home, (async (_url, init) => {
    const { input } = JSON.parse(String(init?.body)) as { input: string[] };
    sent.push(input);
    return new Response(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [1, 0] })) }));
  }) as typeof fetch);
  meaning.set({ baseUrl: 'http://127.0.0.1:12345/v1', model: 'local-test' });
  await meaning.similarity('Friday lunch', async () => ({ lines: [text, secret], exact: [secret] }));
  assert.ok(sent.flat().includes(memoryReferenceText(text)));
  assert.ok(!sent.flat().includes(memoryReferenceText(secret)), 'formatting cannot mask an exact credential from the guard');
  for (const input of sent.flat()) assert.doesNotMatch(input, hidden);
  assert.equal(JSON.parse(memoryReferenceJson({ text })).text, memoryReferenceText(text));
});


test('the visible projection retains each hidden code point instead of silently removing it', () => {
  const points = [0xe0000, 0xe0049, 0xe007f, 0x202e, 0x2063, 0x034f, 0xfe0f, 0xe0100, 0x115f, 0x1160, 0x17b4, 0x180b, 0x180f, 0x2065, 0x3164, 0xffa0, 8, 0x2028, 0x2029];
  const original = 'Before' + String.fromCodePoint(...points) + 'After';
  const visible = memoryReferenceText(original);
  assert.ok(visible.startsWith('Before') && visible.endsWith('After'));
  assert.doesNotMatch(visible, hidden);
  for (const point of points) assert.ok(visible.includes('\\u{' + point.toString(16) + '}'), 'each original code point must have a visible spelling');
});
