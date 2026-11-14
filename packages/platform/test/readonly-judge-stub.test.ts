// A goal check is an assessment on every engine, the stand-in included: it writes nothing, even when the
// goal's own words ask for a document (round-2 cross-family review of the read-only fix).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pollUntil, idle, open, settings, value  } from './helpers.ts';

test('a stub goal check whose goal asks for a document writes nothing; the worker turns still may', async () => {
  const { host } = open(undefined, { harness: 'harness-stub' });
  const projectId = value(await host.call('projects.create', { name: 'Ops', kind: 'folder' })).id;
  const sent = value(await host.call('turns.send', { projectId, text: 'Start the plan', attachments: [], settings, clientKey: 'start' }));
  await idle(host, sent.threadId);
  value(await host.call('goals.set', { threadId: sent.threadId, text: 'Write an editable brief.', baseVersion: 0 }));
  value(await host.call('goals.run', { threadId: sent.threadId, budget: 1 }));
  let judged: { effects: { outcome: string; target: string }[] }[] = [];
  await pollUntil(async active => {
    while (active() && (!judged.length)) {
       const t = value(await host.call('threads.get', { id: sent.threadId }));
       if (!t.summary.running) judged = t.turns.filter((turn) => turn.judge && turn.status !== 'running');
       if (!judged.length) await new Promise((r) => setTimeout(r, 20));
     }
  }, "packages/platform/test/readonly-judge-stub.test.ts:15 polling state");
  assert.ok(judged.length, 'a goal check ran');
  for (const turn of judged) assert.deepEqual(turn.effects.filter((e) => e.outcome === 'DONE'), [], 'no goal check landed a write');
});
