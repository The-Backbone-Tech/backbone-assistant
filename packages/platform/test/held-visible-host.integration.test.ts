// Real Host/Core and an isolated loopback model; inconsistent material flags are synthetic.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MaterialStore } from '../src/stub/material.ts';
import { startScriptedModel, type Message } from '../src/testing/scripted-model.ts';
import { b64, idle, open, settings, value } from './helpers.ts';
const words = (m: Message) => typeof m.content === 'string' ? m.content : (m.content ?? []).map((p) => p.text ?? '').join('');
test('Host never returns visible-but-held or withdrawn source text to a model', async (t) => {
  const model = await startScriptedModel('held-visible-host', (messages) => {
    const at = messages.findLastIndex((m) => m.role === 'user');
    const text = words(messages[at]); const result = messages.slice(at + 1).find((m) => m.role === 'tool');
    if (!result) return { calls: [{ name: 'read_file', args: { name: text.includes('HELD') ? 'held.md' : text.includes('WITHDRAWN') ? 'withdrawn.md' : 'normal.md' } }] };
    return { text: `Tool result: ${words(result)}` };
  });
  const previous = { endpoint: process.env.BACKBONE_MODEL_ENDPOINT, model: process.env.BACKBONE_MODEL_ID };
  process.env.BACKBONE_MODEL_ENDPOINT = model.url; process.env.BACKBONE_MODEL_ID = model.model;
  t.after(async () => { await model.close(); if (previous.endpoint === undefined) delete process.env.BACKBONE_MODEL_ENDPOINT; else process.env.BACKBONE_MODEL_ENDPOINT = previous.endpoint; if (previous.model === undefined) delete process.env.BACKBONE_MODEL_ID; else process.env.BACKBONE_MODEL_ID = previous.model; });
  const { host, home } = open(undefined, { harness: 'harness-pi' });
  const project = value(await host.call('projects.create', { name: 'Source visibility', kind: 'folder' }));
  const normal = value(await host.call('material.attach', { projectId: project.id, name: 'normal.md', base64: b64('NORMAL-CONTROL'), mediaType: 'text/markdown' }));
  const held = value(await host.call('material.attach', { projectId: project.id, name: 'held.md', base64: b64('HELD-SENTINEL'), mediaType: 'text/markdown' }));
  const withdrawn = value(await host.call('material.attach', { projectId: project.id, name: 'withdrawn.md', base64: b64('WITHDRAWN-SENTINEL'), mediaType: 'text/markdown' }));
  const store = new MaterialStore(home, {}, () => {});
  store.mark(held.id, { hidden: false, held: { id: normal.id, name: normal.name } });
  store.withdraw(withdrawn.id); store.mark(withdrawn.id, { hidden: false });
  const first = value(await host.call('turns.send', { projectId: project.id, text: 'CHECK NORMAL', attachments: [], settings, clientKey: 'normal' }));
  assert.match((await idle(host, first.threadId)).turns[0].answer?.text ?? '', /NORMAL-CONTROL/);
  for (const key of ['HELD', 'WITHDRAWN']) {
    value(await host.call('turns.send', { projectId: project.id, threadId: first.threadId, text: `CHECK ${key}`, attachments: [], settings, clientKey: key }));
    const finished = await idle(host, first.threadId); assert.equal(finished.turns.at(-1)?.status, 'done');
  }
  const requests = JSON.stringify(model.requests); assert.doesNotMatch(requests, /HELD-SENTINEL|WITHDRAWN-SENTINEL/);
});
