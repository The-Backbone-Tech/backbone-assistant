// Host/Core are real; the model is an isolated local fixture. No provider or account is used.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startScriptedModel, type Message } from '../src/testing/scripted-model.ts';
import { b64, idle, open, settings, value } from './helpers.ts';

const words = (m: Message) => typeof m.content === 'string' ? m.content : (m.content ?? []).map((p) => p.text ?? '').join('');
test('Host withdrawal cancels a side question after a recorded read and leaves the main turn alone', async (t) => {
  let entered!: () => void, release!: () => void, mainEntered!: () => void, mainRelease!: () => void;
  const mainReady = new Promise<void>((resolve) => { mainEntered = resolve; });
  const mainHeld = new Promise<void>((resolve) => { mainRelease = resolve; });
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const model = await startScriptedModel('side-withdraw-host', (messages) => {
    const start = messages.findLastIndex((m) => m.role === 'user');
    if (words(messages[start]).includes('SIDE WITHDRAW') && !messages.slice(start + 1).some((m) => m.role === 'tool')) return { calls: [{ name: 'read_file', args: { name: 'note.md' } }] };
    return { text: 'Fixture result' };
  }, { before: async (messages) => {
    const start = messages.findLastIndex((m) => m.role === 'user');
    if (words(messages[start]).includes('SIDE WITHDRAW') && messages.slice(start + 1).some((m) => m.role === 'tool')) { entered(); await held; }
    if (words(messages[start]).includes('MAIN WITHDRAW HOLD')) { mainEntered(); await mainHeld; }
  } });
  const previous = { endpoint: process.env.BACKBONE_MODEL_ENDPOINT, model: process.env.BACKBONE_MODEL_ID };
  process.env.BACKBONE_MODEL_ENDPOINT = model.url; process.env.BACKBONE_MODEL_ID = model.model;
  t.after(async () => { release(); mainRelease(); await model.close(); if (previous.endpoint === undefined) delete process.env.BACKBONE_MODEL_ENDPOINT; else process.env.BACKBONE_MODEL_ENDPOINT = previous.endpoint; if (previous.model === undefined) delete process.env.BACKBONE_MODEL_ID; else process.env.BACKBONE_MODEL_ID = previous.model; });
  const { host } = open(undefined, { harness: 'harness-pi' });
  const project = value(await host.call('projects.create', { name: 'Withdraw side', kind: 'folder' }));
  const file = value(await host.call('material.attach', { projectId: project.id, name: 'note.md', base64: b64('synthetic source'), mediaType: 'text/markdown' }));
  const sent = value(await host.call('turns.send', { projectId: project.id, text: 'Main question', attachments: [], settings, clientKey: 'main' }));
  assert.equal((await idle(host, sent.threadId)).turns[0].status, 'done');
  const pending = host.call('sidechat.ask', { threadId: sent.threadId, text: 'SIDE WITHDRAW', clientKey: 'side' });
  await ready;
  const running = value(await host.call('threads.get', { id: sent.threadId }));
  assert.ok(running.sideTurns[0].reads?.some((read) => read.id === file.id));
  value(await host.call('turns.send', { threadId: sent.threadId, projectId: project.id, text: 'MAIN WITHDRAW HOLD', attachments: [], settings, clientKey: 'follow' }));
  await mainReady;
  value(await host.call('material.lifecycle', { id: file.id, version: file.current, lifecycle: 0, state: 'withdrawn' }));
  release();
  const side = value(await pending); assert.equal(side.status, 'stopped'); assert.equal(side.withheld, true); assert.equal(side.effects.length, 0);
  const stored = value(await host.call('threads.get', { id: sent.threadId })); assert.equal(stored.turns[0].status, 'done'); assert.equal(stored.turns[1].status, 'running');
  mainRelease(); assert.equal((await idle(host, sent.threadId)).turns[1].status, 'done');
  const retry = value(await host.call('sidechat.ask', { threadId: sent.threadId, text: 'SIDE WITHDRAW', clientKey: 'side' })); assert.equal(retry.id, side.id);
});
