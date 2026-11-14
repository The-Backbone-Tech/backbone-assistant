import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startScriptedModel } from '@backbone-next/platform/testing';
import { createPiHarness } from '../src/index.ts';

for (const finish of ['length', null, 'stop'] as const) test(`completion requires a normal provider stop: ${finish}`, async t => {
  const server = await startScriptedModel('small', () => ({ text: 'North revenue is 8,', finish }));
  t.after(() => server.close());
  const run = createPiHarness().start({ threadId: 't', turnId: 'u', text: 'Revenue?', history: [], attachments: [], effort: 1, resumed: false }, {
    route: { kind: 'endpoint', provider: 'openai-compatible', baseUrl: server.url, model: server.model, label: 'Small local model', credential: null },
    credential: async () => '', tools: { list: async () => [], read: async () => null, write: async () => ({ outcome: 'REFUSED', detail: 'not used' }) },
  });
  for await (const _ of run.events) { /* drain */ }
  const outcome = await run.outcome;
  assert.equal(outcome.status, finish === 'stop' ? 'done' : 'failed');
  assert.equal(outcome.finishReason, finish ?? 'missing');
  if (finish !== 'stop') assert.match(outcome.error!, /cut off.*context|cut off.*connection/i);
  assert.equal(outcome.answer, 'North revenue is 8,');
});

test('a refused tool step carries the reason as readable text', async t => {
  const server = await startScriptedModel('m', messages => messages.some(m => m.role === 'tool') ? { text: 'The file is missing.' } : { calls: [{ name: 'read_file', args: { name: 'missing.csv' } }] });
  t.after(() => server.close());
  const run = createPiHarness().start({ threadId: 't', turnId: 'u', text: 'Read missing.csv', history: [], attachments: [], effort: 1, resumed: false }, {
    route: { kind: 'endpoint', provider: 'openai-compatible', baseUrl: server.url, model: server.model, label: 'Scripted', credential: null }, credential: async () => '',
    tools: { list: async () => [], read: async () => null, write: async () => ({ outcome: 'REFUSED', detail: 'not used' }) },
  });
  const events = []; for await (const event of run.events) events.push(event);
  const refused = events.find(e => e.type === 'tool' && e.phase === 'refused');
  assert.ok(refused?.type === 'tool');
  assert.equal(refused.detail, 'There is no file named missing.csv.');
});

test('a broken provider stream explains the unfinished answer and connection cause', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"North total: 8,"},"finish_reason":null}]}\n\n'));
      setTimeout(() => controller.error(Error('connection lost')), 20);
    },
  }), { headers: { 'content-type': 'text/event-stream' } }));
  const run = createPiHarness().start({ threadId: 't', turnId: 'u', text: 'Which region?', history: [], attachments: [], effort: 1, resumed: false }, {
    route: { kind: 'endpoint', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', model: 'm', label: 'Scripted broken stream', credential: null }, credential: async () => '',
    tools: { list: async () => [], read: async () => null, write: async () => ({ outcome: 'REFUSED', detail: 'not used' }) },
  });
  for await (const _ of run.events) { /* drain */ }
  const outcome = await run.outcome;
  assert.equal(outcome.status, 'failed'); assert.equal(outcome.finishReason, 'missing');
  assert.match(outcome.error!, /cut off.*connection/i); assert.equal(outcome.answer, 'North total: 8,');
});

for (const finish of ['stop', 'length'] as const) test(`tool calls with provider ${finish}: only a cut-off blocks execution`, async t => {
  let calls = 0, reads = 0;
  const s = await startScriptedModel('m', () => ++calls === 1 ? { calls: [{ name: 'read_file', args: { name: 'note.md' } }], finish } : { text: 'Read it.' }); t.after(() => s.close());
  const run = createPiHarness().start({ threadId: 't', turnId: 'u', text: 'Read note.md', history: [], attachments: [], effort: 1, resumed: false }, {
    route: { kind: 'endpoint', provider: 'openai-compatible', baseUrl: s.url, model: s.model, label: 'Scripted', credential: null }, credential: async () => '',
    tools: { list: async () => [], read: async () => { reads++; return { name: 'note.md', version: 1, by: 'person', class: 'original', mediaType: 'text/plain', text: 'A note' }; }, write: async () => ({ outcome: 'REFUSED', detail: 'not used' }) },
  });
  for await (const _ of run.events) { /* drain */ }
  const outcome = await run.outcome; assert.equal(reads, finish === 'stop' ? 1 : 0); assert.equal(outcome.status, finish === 'stop' ? 'done' : 'failed');
  assert.equal(calls, finish === 'stop' ? 2 : 1, 'a cut-off cannot start another request');
});

test('a rejected HTTP request is a failure, not a missing provider stream', async t => {
  const s = await startScriptedModel('m', undefined, { before: () => ({ status: 401, message: 'Invalid fake credential' }) }); t.after(() => s.close());
  const run = createPiHarness().start({ threadId: 't', turnId: 'u', text: 'Hello', history: [], attachments: [], effort: 1, resumed: false }, {
    route: { kind: 'endpoint', provider: 'openai-compatible', baseUrl: s.url, model: s.model, label: 'Scripted', credential: null }, credential: async () => '',
    tools: { list: async () => [], read: async () => null, write: async () => ({ outcome: 'REFUSED', detail: 'not used' }) },
  });
  for await (const _ of run.events) { /* drain */ }
  const outcome = await run.outcome; assert.equal(outcome.status, 'failed'); assert.equal(outcome.finishReason, 'error'); assert.match(outcome.error!, /401|Invalid fake credential/);
});
