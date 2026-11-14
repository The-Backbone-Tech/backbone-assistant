import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryStore } from '../src/memory/store.ts';
import { memoryReferenceText } from '../src/memory/visible.ts';
import { startScriptedModel, type Message } from '../src/testing/scripted-model.ts';
import { freshHome, idle, open, settings, value } from './helpers.ts';

const words = (m: Message) => typeof m.content === 'string' ? m.content : (m.content ?? []).map(c => c.text ?? '').join('');
test('initial recall and a mid-turn memory tool give the model visible format characters', async () => {
  const home = freshHome(), store = new MemoryStore(home);
  const original = 'Friday lunch ' + String.fromCodePoint(0xE0049, 0xE0067) + '\u2063notes';
  store.add({ topic: 'notes', text: original, origin: { kind: 'import', source: 'fixture.md' }, sources: [] }, () => 'current');
  let toolText = '', carriedHistory = false;
  const model = await startScriptedModel('visible-memory', messages => {
    carriedHistory ||= messages.some(m => m.role === 'assistant' && words(m) === memoryReferenceText(original));
    if (messages.some(m => words(m).includes('Consolidate this memory.'))) return { text: '{"changes":[]}' };
    const last = messages.findLast(m => m.role === 'tool');
    if (!last) return { calls: [{ name: 'memory_search', args: { query: 'Friday lunch' } }] };
    toolText = words(last);
    return { text: original };
  });
  const oldEndpoint = process.env.BACKBONE_MODEL_ENDPOINT, oldModel = process.env.BACKBONE_MODEL_ID;
  process.env.BACKBONE_MODEL_ENDPOINT = model.url; process.env.BACKBONE_MODEL_ID = model.model;
  try {
    const { host } = open(home, { harness: 'harness-pi' });
    const project = value(await host.call('projects.create', { name: 'Local memory', kind: 'folder' }));
    const sent = value(await host.call('turns.send', { projectId: project.id, text: 'Check Friday lunch memory.', attachments: [], settings, clientKey: 'visible' }));
    await idle(host, sent.threadId);
    const line = toolText.split('\n').find(line => line.startsWith('- [imported] '));
    assert.ok(line, 'mid-turn results identify their stored provenance');
    assert.equal(JSON.parse(line.slice('- [imported] '.length)), memoryReferenceText(original));
    assert.doesNotMatch(toolText, /\p{Cf}/u);
    const next = value(await host.call('turns.send', { projectId: project.id, threadId: sent.threadId, text: 'Check that memory again.', attachments: [], settings, clientKey: 'replay' }));
    const after = await idle(host, next.threadId);
    assert.ok(carriedHistory, 'an old assistant answer must reach replay only as a visible projection');
    assert.equal(after.turns[0].answer?.text, original, 'stored history remains byte-exact');
    for (const request of model.requests) assert.doesNotMatch(request.body, /\p{Cf}/u);
    assert.equal((await host.call('memory.get', {})).entries[0].text, original);
  } finally {
    if (oldEndpoint === undefined) delete process.env.BACKBONE_MODEL_ENDPOINT; else process.env.BACKBONE_MODEL_ENDPOINT = oldEndpoint;
    if (oldModel === undefined) delete process.env.BACKBONE_MODEL_ID; else process.env.BACKBONE_MODEL_ID = oldModel;
    await model.close();
  }
});
