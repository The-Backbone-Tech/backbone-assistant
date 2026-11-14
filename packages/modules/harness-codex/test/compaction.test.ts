import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NativeTurnEvents } from '../src/events.ts';

test('native compaction stays linked to its thread and turn without inventing a readable summary', () => {
  const projection = new NativeTurnEvents('thread');
  const frame = { threadId: 'thread', turnId: 'turn', item: { type: 'contextCompaction', id: 'compact' } };
  assert.equal(projection.receive('item/started', frame)[0]?.type, 'compaction');
  const [completed] = projection.receive('item/completed', frame);
  assert.ok(completed?.type === 'compaction');
  assert.equal(completed.compaction.sessionId, 'thread');
  assert.equal(completed.compaction.status, 'completed');
  assert.equal(completed.compaction.summary, undefined);
  assert.deepEqual(projection.receive('item/completed', frame), []);
  assert.throws(() => projection.receive('item/completed', { ...frame, threadId: 'other' }), /thread/);
});

test('native web lookup is inspectable in the work record without creating an effect receipt', () => {
  const projection = new NativeTurnEvents('thread');
  const frame = { threadId: 'thread', turnId: 'turn', item: { type: 'webSearch', id: 'search', query: 'local timetable' } };
  const events = projection.receive('item/completed', frame);
  assert.equal(events.length, 1);
  assert.ok(events[0].type === 'tool');
  assert.equal(events[0].tool, 'native_web');
  assert.equal(events[0].phase, 'done');
  assert.equal(events[0].detail, 'local timetable');
  assert.deepEqual(projection.receive('item/completed', frame), []);
});
