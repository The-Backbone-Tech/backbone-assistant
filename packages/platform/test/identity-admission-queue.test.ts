// An identity admission holds a Core connection for its whole request. Reads queued behind a
// write's home lock must not take every admission connection: the running turn stays visible
// and stoppable while the write is still in dispatch (Electron A2, Now).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freshHome, idle, open, settings, value } from './helpers.ts';

test('reads queued behind a write leave threads.get answering while the write runs, and Stop leaves it UNKNOWN', async () => {
  const ctx = open(freshHome(), { writeDelayMs: 4_000 });
  const p = value(await ctx.host.call('projects.create', { name: 'P', kind: 'folder' }));
  const sent = value(await ctx.host.call('turns.send', { projectId: p.id, text: 'Draft a brief for the launch', attachments: [], settings, clientKey: 'first' }));
  // The write has its effect key once it crossed into dispatch, where it holds the home lock.
  for (;;) {
    const turn = value(await ctx.host.call('threads.get', { id: sent.threadId })).turns.at(-1);
    if (turn?.effects.some((effect) => effect.key)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // More queued lock readers than the admission pool has connections.
  let readsDone = 0;
  const reads = Array.from({ length: 12 }, (_, i) => (i % 2 ? ctx.host.call('work.now', { projectId: p.id }) : ctx.host.call('material.list', { projectId: p.id })).then(() => { readsDone++; }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const thread = value(await ctx.host.call('threads.get', { id: sent.threadId }));
  assert.equal(readsDone, 0, 'the queued reads still wait for the write');
  assert.equal(thread.summary.running, true, 'the running turn is visible during the write');
  value(await ctx.host.call('turns.stop', { threadId: sent.threadId }));
  await Promise.all(reads);
  const stopped = await idle(ctx.host, sent.threadId);
  assert.deepEqual(stopped.turns.at(-1)?.effects.map((effect) => effect.outcome), ['UNKNOWN']);
  ctx.host.close();
});
