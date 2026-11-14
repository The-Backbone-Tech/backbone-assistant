import assert from 'node:assert/strict';
import { test } from 'node:test';
import { open, settings, value } from './helpers.ts';
import { startScriptedModel } from '../src/testing/scripted-model.ts';
import { serveApiLine, askWords, type LineAsk } from '../src/composition/api-line.ts';
import { attachApi } from '../src/doors/api-line.ts';

for (const when of ['confirmation', 'dispatch'] as const) test(`selection freezes the shown destination through ${when}`, async () => {
  const a = await startScriptedModel('same-chat-model'), b = await startScriptedModel('same-chat-model');
  const old = { endpoint: process.env.BACKBONE_MODEL_ENDPOINT, model: process.env.BACKBONE_MODEL_ID };
  process.env.BACKBONE_MODEL_ENDPOINT = a.url; process.env.BACKBONE_MODEL_ID = a.model;
  const { host, home } = open(undefined, { harness: 'harness-pi', localModels: { ports: { ollama: 0, lmstudio: 0, llamacpp: 0, vllm: 0 } } });
  const projectId = value(await host.call('projects.create', { name: 'Approval', kind: 'folder' })).id;
  let asked: LineAsk | undefined;
  const server = await serveApiLine({ home, call: async (method, args) => {
    if (method === 'solutions.run' && when === 'dispatch') process.env.BACKBONE_MODEL_ENDPOINT = b.url;
    return host.call(method, args);
  }, confirm: async ask => {
    asked = ask;
    if (when === 'confirmation') process.env.BACKBONE_MODEL_ENDPOINT = b.url;
    return true;
  } });
  const line = await attachApi(home); assert.ok(line);
  try {
    const result = await line.call('solutions.run', { projectId, text: 'Write an editable brief', task: { needs: ['model', 'files'], network: false, spend: 'none' }, settings, clientKey: when });
    // The line treats callback exceptions as refusal, so assert the captured question outside it.
    assert.ok(asked);
    assert.equal(asked.method, 'solutions.run');
    assert.ok('route' in asked && asked.route?.includes(a.model));
    assert.ok('spend' in asked && asked.spend === 'none');
    assert.match(askWords(asked, 'App').detail, /bill/i);
    assert.ok(!result.ok || result.value.started === null);
    assert.equal(a.requests.filter(r => r.body.includes('"messages"')).length, 0);
    assert.equal(b.requests.filter(r => r.body.includes('"messages"')).length, 0);
  } finally {
    line.close(); await server.close(); await a.close(); await b.close();
    if (old.endpoint === undefined) delete process.env.BACKBONE_MODEL_ENDPOINT; else process.env.BACKBONE_MODEL_ENDPOINT = old.endpoint;
    if (old.model === undefined) delete process.env.BACKBONE_MODEL_ID; else process.env.BACKBONE_MODEL_ID = old.model;
  }
});
