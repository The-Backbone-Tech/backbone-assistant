// A task's restriction reaches main turns, direct child follow-ups and side questions through Host.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitFor } from '../../../scripts/lib/test-hang.ts';
import { startScriptedModel } from '../src/testing/scripted-model.ts';
import { idle, open, settings, value } from './helpers.ts';

test('memory off remains off for child follow-ups and side questions while another task recalls normally', async t => {
  const model = await startScriptedModel('memory-scope', () => ({ text: 'Done.' }));
  t.after(() => model.close());
  const previousEndpoint = process.env.BACKBONE_MODEL_ENDPOINT, previousModel = process.env.BACKBONE_MODEL_ID;
  process.env.BACKBONE_MODEL_ENDPOINT = model.url; process.env.BACKBONE_MODEL_ID = model.model;
  t.after(() => {
    if (previousEndpoint === undefined) delete process.env.BACKBONE_MODEL_ENDPOINT; else process.env.BACKBONE_MODEL_ENDPOINT = previousEndpoint;
    if (previousModel === undefined) delete process.env.BACKBONE_MODEL_ID; else process.env.BACKBONE_MODEL_ID = previousModel;
  });
  const { host } = open(undefined, { harness: 'harness-pi' });
  const projectId = value(await host.call('projects.create', { name: 'Memory scope', kind: 'folder' })).id;
  const training = value(await host.call('turns.send', { projectId, text: 'Prepare the report', attachments: [], settings, clientKey: 'skill-source' }));
  await idle(host, training.threadId);
  const draft = value(await host.call('skills.draft', { threadId: training.threadId }));
  const listed = (await host.call('memory.get', {})).skills.find(skill => skill.id === draft.id)!;
  value(await host.call('skills.put', { id: listed.id, base: listed.revision!, text: listed.body! + '\nThe learned report marker is ultramarine.\n' }));
  value(await host.call('skills.decide', { id: listed.id, verdict: 'accept' }));
  value(await host.call('memory.put', { topic: 'reports', text: 'The report marker is cobalt.' }));
  value(await host.call('memory.instructions.put', { scope: 'person', text: 'Include the instruction marker vermilion.' }));
  const offRequestsFrom = model.requests.length;
  const sent = value(await host.call('turns.send', { projectId, text: 'Remember that my report marker is saffron. Prepare the report.', attachments: [], settings: { ...settings, memory: 'off' }, clientKey: 'off-parent' }));
  assert.equal((await idle(host, sent.threadId)).turns[0].memory?.off, true);
  const child = value(await host.call('children.start', { parentThreadId: sent.threadId, text: 'Prepare report', role: 'worker', clientKey: 'off-child' }));
  assert.equal((await idle(host, child.threadId)).turns[0].memory?.off, true);
  value(await host.call('turns.send', { projectId, threadId: child.threadId, text: 'Prepare report again', attachments: [], settings, clientKey: 'off-child-followup' }));
  const followed = await idle(host, child.threadId);
  assert.equal(followed.turns.at(-1)?.user.settings?.memory, 'off');
  assert.equal(followed.turns.at(-1)?.memory?.off, true);
  const side = value(await host.call('sidechat.ask', { threadId: sent.threadId, text: 'Prepare report on the side', clientKey: 'off-side' }));
  await waitFor(async () => {
    const thread = value(await host.call('threads.get', { id: sent.threadId }));
    return thread.sideTurns.find(turn => turn.id === side.id)?.status === 'done';
  }, 'off side question finishes');
  const thread = value(await host.call('threads.get', { id: sent.threadId }));
  assert.equal(thread.sideTurns.find(turn => turn.id === side.id)?.memory?.off, true);
  for (const request of model.requests.slice(offRequestsFrom)) {
    const body = JSON.parse(request.body);
    assert.doesNotMatch(JSON.stringify(body.messages), /cobalt|vermilion|ultramarine/);
    assert.doesNotMatch(JSON.stringify(body.tools), /memory_search|propose_memory/);
  }
  assert.equal((await host.call('memory.get', {})).entries.length, 1);
  const normal = value(await host.call('turns.send', { projectId, text: 'Prepare the report with its marker.', attachments: [], settings, clientKey: 'normal-task' }));
  await idle(host, normal.threadId);
  assert.match(model.requests.at(-1)!.body, /cobalt/);
  assert.match(model.requests.at(-1)!.body, /ultramarine/, 'another task can still use the accepted learned skill');
});
