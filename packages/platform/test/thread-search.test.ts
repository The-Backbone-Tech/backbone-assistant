import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Turn } from '../src/api.ts';
import type { StoredThread } from '../src/composition/thread-journal.ts';
import { searchThreads } from '../src/composition/thread-search.ts';

function thread(id: string, title: string, words = '', answer = ''): StoredThread {
  return {
    summary: { id, projectId: 'project', title, pinned: false, unread: false, archived: false, running: false, updatedAt: '2026-11-10T00:00:00Z' },
    turns: [turn(id, words, answer)], sideTurns: [], clientKeys: [],
  };
}
function turn(id: string, words: string, answer: string): Turn {
  return { id, side: false, status: 'done', user: { text: words, attachments: [], at: '2026-11-10T00:00:00Z' }, answer: { text: answer, files: [] }, work: { steps: [], startedAt: '2026-11-10T00:00:00Z', harness: 'stub' }, effects: [] };
}

test('every matching conversation and place is returned beyond fifty hits', () => {
  const threads = Array.from({ length: 80 }, (_, i) => thread(`t${i}`, 'Old chat', 'quasar', 'quasar'));
  threads[0].summary.archived = true;
  const hits = searchThreads(threads, 'quasar');
  assert.equal(hits.length, 160);
  assert.equal(new Set(hits.map(h => h.threadId)).size, 80);
  assert.ok(hits.some(h => h.threadId === 't0'));
});

test('relevance ranks a focused answer ahead of a recent incidental mention', () => {
  const focused = thread('focused', 'Old work', '', 'quasar quasar orbit');
  const incidental = thread('incidental', 'New work', '', `quasar ${'unrelated material '.repeat(200)}`);
  incidental.summary.updatedAt = '2026-11-11T00:00:00Z';
  assert.equal(searchThreads([incidental, focused], 'quasar')[0].threadId, 'focused');
});

test('every query word must occur in the same conversation, across titles, turns and answers', () => {
  const across = thread('across', 'zebra', 'crossing', 'memo');
  const together = thread('together', 'Work', 'zebra crossing memo');
  const partial = thread('partial', 'zebra', 'crossing');
  const hits = searchThreads([across, partial, together], 'zebra memo crossing');
  assert.deepEqual(new Set(hits.map(h => h.threadId)), new Set(['across', 'together']));
  assert.equal(hits[0].threadId, 'together');
  assert.ok(hits.some(h => h.threadId === 'across' && h.field === 'title'));
});

test('word search handles punctuation, case, accents and a final word prefix', () => {
  const threads = [thread('match', 'CAFÉ: launch-plan', 'A launch planner'), thread('infix', 'Decafeteria replanning')];
  assert.equal(searchThreads(threads, 'cafe, LAUNCH pla')[0]?.threadId, 'match');
  assert.deepEqual(searchThreads(threads, 'cafe').map(h => h.threadId), ['match']);
});

test('side conversations are searchable with their own turn identity and a bounded snippet', () => {
  const t = thread('side', 'A chat');
  t.sideTurns.push({ ...turn('side-turn', 'a quick question', `${'context '.repeat(100)}nebula answer`), side: true });
  const hits = searchThreads([t], 'nebula');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].turnId, 'side-turn');
  assert.equal(hits[0].field, 'answer');
  assert.match(hits[0].snippet, /nebula/);
  assert.ok(hits[0].snippet.length < 150);
});

test('edits and deleted conversations cannot leave stale results or cross into another search', () => {
  const threads = [thread('one', 'quasar')];
  assert.equal(searchThreads(threads, 'quasar').length, 1);
  threads[0].summary.title = 'nebula';
  assert.deepEqual(searchThreads(threads, 'quasar'), []);
  assert.equal(searchThreads(threads, 'nebula').length, 1);
  assert.deepEqual(searchThreads([], 'nebula'), []);
  assert.deepEqual(searchThreads([thread('other', 'Unrelated')], 'nebula'), []);
});

test('empty and punctuation-only queries return no hits, and duplicate words do not change results', () => {
  const threads = [thread('one', 'quasar')];
  for (const query of ['', '   ', '.,!?']) assert.deepEqual(searchThreads(threads, query), []);
  assert.deepEqual(searchThreads(threads, 'quasar quasar'), searchThreads(threads, 'quasar'));
});

test('words in code names are searchable on either side of underscores and dots', () => {
  const t = thread('code', 'A coding conversation', `${'context '.repeat(100)}project_notes.md`);
  const hits = searchThreads([t], 'project notes');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].threadId, 'code');
  assert.match(hits[0].snippet, /project_notes\.md/);
});
