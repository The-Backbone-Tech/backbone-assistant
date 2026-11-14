// Host-level side lifecycle: local model only, isolated home, no real account or network provider.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startScriptedModel, type Message, type ScriptedModel } from '../src/testing/scripted-model.ts';
import { idle, open, settings, value } from './helpers.ts';

const words = (message: Message) => typeof message.content === 'string' ? message.content : (message.content ?? []).map((piece) => piece.text ?? '').join('');
let model: ScriptedModel;
let started!: () => void, release!: () => void;
let sideStarted: Promise<void>, held: Promise<void>;
let mainEntered!: () => void, releaseMain!: () => void;
let mainStarted: Promise<void>, mainHeld: Promise<void>;
let oldEndpoint: string | undefined, oldModel: string | undefined;
before(async () => {
  oldEndpoint = process.env.BACKBONE_MODEL_ENDPOINT; oldModel = process.env.BACKBONE_MODEL_ID;
  sideStarted = new Promise((resolve) => { started = resolve; });
  held = new Promise((resolve) => { release = resolve; });
  mainStarted = new Promise((resolve) => { mainEntered = resolve; });
  mainHeld = new Promise((resolve) => { releaseMain = resolve; });
  model = await startScriptedModel('side-host-lifecycle', () => ({ text: 'MODEL ANSWER' }), {
    before: async (messages) => {
      const question = words(messages.findLast((message) => message.role === 'user')!);
      if (question.includes('SIDE HOLD')) { started(); await held; }
      if (question.includes('MAIN HOLD')) { mainEntered(); await mainHeld; }
    },
  });
  process.env.BACKBONE_MODEL_ENDPOINT = model.url; process.env.BACKBONE_MODEL_ID = model.model;
});
after(async () => {
  release();
  releaseMain();
  if (oldEndpoint === undefined) delete process.env.BACKBONE_MODEL_ENDPOINT; else process.env.BACKBONE_MODEL_ENDPOINT = oldEndpoint;
  if (oldModel === undefined) delete process.env.BACKBONE_MODEL_ID; else process.env.BACKBONE_MODEL_ID = oldModel;
  await model.close();
});

test('a keyed in-flight side question is durable, cannot be deleted, and Stop targets it alone', async () => {
  const { host } = open(undefined, { harness: 'harness-pi' });
  const project = value(await host.call('projects.create', { name: 'Side lifecycle', kind: 'folder' }));
  const sent = value(await host.call('turns.send', { projectId: project.id, text: 'Main question', attachments: [], settings, clientKey: 'main' }));
  const main = await idle(host, sent.threadId);
  assert.equal(main.turns[0].status, 'done');
  const question = host.call('sidechat.ask', { threadId: sent.threadId, text: 'SIDE HOLD', clientKey: 'side-key' });
  await sideStarted;
  const before = model.requests.filter((request) => request.body.includes('SIDE HOLD')).length;
  const running = value(await host.call('threads.get', { id: sent.threadId }));
  const side = running.sideTurns.find((turn) => turn.sideClientKey === 'side-key');
  assert.ok(side && side.status === 'running');
  const retry = await host.call('sidechat.ask', { threadId: sent.threadId, text: 'SIDE HOLD', clientKey: 'side-key' });
  assert.ok(retry.ok && retry.value.id === side.id && retry.value.status === 'running');
  const deleted = await host.call('threads.delete', { id: sent.threadId });
  assert.ok(!deleted.ok && deleted.reason === 'NOT_AVAILABLE');
  const follow = value(await host.call('turns.send', { threadId: sent.threadId, projectId: project.id, text: 'MAIN HOLD', attachments: [], settings, clientKey: 'follow' }));
  await mainStarted;
  const wrong = await host.call('sidechat.stop', { threadId: sent.threadId, turnId: follow.turnId });
  assert.ok(wrong.ok && !wrong.value.stopped);
  const stopped = await host.call('sidechat.stop', { threadId: sent.threadId, turnId: side.id });
  assert.ok(stopped.ok && stopped.value.stopped);
  release();
  const result = await question;
  assert.ok(result.ok && result.value.status === 'stopped');
  const after = value(await host.call('threads.get', { id: sent.threadId }));
  assert.equal(after.turns.length, 2);
  assert.equal(after.turns[0].status, 'done');
  assert.equal(after.turns[1].status, 'running', 'Stop in the side pane must not stop the main turn');
  assert.equal(after.sideTurns.length, 1);
  assert.equal(after.sideTurns[0].effects.length, 0);
  assert.equal(model.requests.filter((request) => request.body.includes('SIDE HOLD')).length, before, 'retry and Stop do not send again');
  releaseMain();
  assert.equal((await idle(host, sent.threadId)).turns[1].status, 'done');
});
