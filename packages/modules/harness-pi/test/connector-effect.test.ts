// The maintained Pi loop, scripted model and a ToolHost result at the connector boundary.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startScriptedModel } from '@backbone-next/platform/testing';
import type { HarnessEvent, ToolHost } from '@backbone-next/platform/ports';
import { createPiHarness } from '../src/index.ts';

for (const state of ['unknown', 'failed', 'sent'] as const) test(`Pi signed effect ${state}: stop only on uncertainty`, async () => {
  let continuations = 0;
  const model = await startScriptedModel('effect-fixture', (messages) => {
    if (messages.some(m => m.role === 'tool')) { continuations++; return { text: 'Read the results.' }; }
    // An ordinary result before the connector makes this a mixed batch. A terminate hint
    // alone must not allow either its next connector or another model request.
    return { calls: [{ name: 'list_files', args: {} }, { name: 'first', args: {} }, { name: 'second', args: { text: 'different' } }] };
  });
  const called: string[] = [];
  const detail = `Provider effect ${state}; ${state === 'unknown' ? 'never resend; check the provider.' : 'observed result.'}`;
  const tools: ToolHost = {
    list: async () => [], read: async () => null, write: async () => { throw new Error('No document write'); },
    connectors: () => ['first', 'second'].map(name => ({ name, server: 'fixture', tool: name, description: 'Signed effect', kind: 'effect', inputSchema: { type: 'object' } })),
    reserveConnectorBatch: async () => '11111111-1111-4111-8111-111111111111',
    callConnector: async name => { called.push(name); return { outcome: 'SENT', state, detail }; },
  };
  try {
    const turn = createPiHarness().start({ threadId: 'thread', turnId: 'turn', text: 'Call both.', history: [], attachments: [], effort: 1, resumed: false }, {
      tools, route: { kind: 'endpoint', provider: 'openai-compatible', model: model.model, baseUrl: model.url, credential: null, label: 'scripted' }, credential: async () => { throw new Error('No credential'); },
    });
    const events: HarnessEvent[] = [];
    const collected = (async () => { for await (const event of turn.events) events.push(event); })();
    const outcome = await turn.outcome;
    await collected;
    assert.deepEqual(called, state === 'unknown' ? ['first'] : ['first', 'second']);
    assert.equal(continuations, state === 'unknown' ? 0 : 1);
    assert.equal(outcome.status, state === 'unknown' ? 'interrupted' : 'done');
    if (state === 'unknown') {
      assert.equal(outcome.error, detail);
      assert.equal(outcome.answer, '');
      assert.ok(events.some(e => e.type === 'tool' && e.tool === 'first' && e.phase === 'unknown'));
    } else {
      const results = JSON.parse(model.requests.at(-1)!.body).messages.filter((m: { role: string }) => m.role === 'tool');
      assert.ok(results.some((m: { content: string }) => m.content.includes(detail)), 'the model receives the observed result');
      assert.ok(events.some(e => e.type === 'tool' && e.tool === 'first' && e.phase === (state === 'failed' ? 'refused' : 'done')));
    }
  } finally { await model.close(); }
});
