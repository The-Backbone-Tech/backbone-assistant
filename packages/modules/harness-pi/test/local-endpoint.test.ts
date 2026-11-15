import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createPiHarness } from '../src/index.ts';
import { startScriptedModel } from '@backbone-next/platform/testing';

test('a stopped local model fails clearly without asking for a key or trying another route', async () => {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  const run = createPiHarness().start({ threadId: 't', turnId: 'u', text: 'Hello', history: [], attachments: [], effort: 1, resumed: false }, {
    route: { kind: 'endpoint', provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'owned-local', label: 'Ollama', credential: null },
    credential: async () => { assert.fail('a local route must not resolve a credential'); },
    tools: { list: async () => [], read: async () => null, write: async () => { assert.fail('no tools run'); } },
  });
  for await (const _ of run.events) { /* drain */ }
  const outcome = await run.outcome;
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error!, /local model.*owned-local.*unavailable/i);
  assert.match(outcome.error!, new RegExp(`http://127\\.0\\.0\\.1:${port}/v1`), 'the address that was tried is named');
  assert.match(outcome.error!, /address path/i); assert.match(outcome.error!, /server is running/i); assert.match(outcome.error!, /model is loaded/i);
  assert.match(outcome.error!, /no other route/i);
  // A turn shows only the first 200 characters of an engine error; what was not done must be inside them.
  assert.ok(outcome.error!.indexOf('No other route was tried.') >= 0 && outcome.error!.indexOf('No other route was tried.') + 25 <= 160, outcome.error ?? 'no error text');
});

test('a running local server keeps its context-limit diagnostic instead of suggesting a restart', async t => {
  const server = await startScriptedModel('small', undefined, { before: () => ({ status: 400, message: 'The requested context exceeds this model limit' }) });
  t.after(() => server.close());
  const run = createPiHarness().start({ threadId: 't', turnId: 'u', text: 'Hello', history: [], attachments: [], effort: 1, resumed: false }, {
    route: { kind: 'endpoint', provider: 'openai-compatible', baseUrl: server.url, model: server.model, label: 'Small model', credential: null },
    credential: async () => { assert.fail('a local route must not resolve a credential'); },
    tools: { list: async () => [], read: async () => null, write: async () => { assert.fail('no tool was offered'); } },
  });
  for await (const _ of run.events) { /* drain */ }
  const outcome = await run.outcome;
  assert.equal(outcome.status, 'failed'); assert.match(outcome.error!, /context.*limit/i);
  assert.doesNotMatch(outcome.error!, /start.*server/i);
});

test('a local 503 keeps the leading HTTP status used by task-board backoff', async t => {
  const server = await startScriptedModel('busy-local', undefined, { before: () => ({ status: 503, message: 'Service Unavailable' }) });
  t.after(() => server.close());
  const run = createPiHarness().start({ threadId: 't', turnId: 'u', text: 'Hello', history: [], attachments: [], effort: 1, resumed: false }, {
    route: { kind: 'endpoint', provider: 'openai-compatible', baseUrl: server.url, model: server.model, label: 'Busy local model', credential: null },
    credential: async () => { assert.fail('a local route must not resolve a credential'); },
    tools: { list: async () => [], read: async () => null, write: async () => { assert.fail('no tool was offered'); } },
  });
  for await (const _ of run.events) { /* drain */ }
  const outcome = await run.outcome;
  assert.equal(outcome.status, 'failed'); assert.match(outcome.error!, /^503\b/);
  assert.match(outcome.error!, /local model.*unavailable/i); assert.match(outcome.error!, /no other route/i);
});
