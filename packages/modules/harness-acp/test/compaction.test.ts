import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { HarnessEvent, TurnContext, TurnRequest } from '@backbone-next/platform/ports';
import { createAcpHarness } from '../src/index.ts';
import { AcpCompactions } from '../src/compaction.ts';

for (const mode of ['compaction-count-limit', 'compaction-text-limit']) test(`ACP ${mode} fails the active turn cleanly instead of throwing from a notification`, async () => {
  const harness = createAcpHarness({ acceptsProcessVisibility: true, command: process.execPath, args: [fileURLToPath(new URL('./fake-agent.mjs', import.meta.url))], env: { ACP_FAKE_MODE: mode }, environment: process.platform === 'darwin' ? 'restricted-writes' : 'person-rights' });
  const context: TurnContext = { tools: { list: async () => [], read: async () => null, write: async () => { throw new Error('No effect after invalid compaction'); } }, route: { kind: 'agent', provider: 'acp:fake', baseUrl: '', model: 'chosen-by-agent', label: 'Local fake', credential: null }, credential: async () => '' };
  try {
    for (const turnId of ['first', 'fresh']) {
      const turn = harness.start({ threadId: mode, turnId, text: 'Continue', history: [], attachments: [], effort: 3, resumed: false }, context);
      const events: HarnessEvent[] = []; for await (const event of turn.events) events.push(event);
      const result = await turn.outcome;
      assert.equal(result.status, 'failed');
      assert.match(result.error ?? '', /compaction.*limit/i);
      assert.doesNotMatch(result.answer, /MUST-NOT-CONTINUE/);
      assert.ok(events.every(event => event.type !== 'text' && event.type !== 'tool'));
      assert.equal(events.filter(event => event.type === 'compaction').length, mode === 'compaction-count-limit' ? 128 : 0, 'a fresh session has fresh bounded projection state');
    }
  } finally { await harness.close(); }
});

test('an ACP agent compacts natively and continues the same session with a readable retained summary', async () => {
  const harness = createAcpHarness({ acceptsProcessVisibility: true, command: process.execPath, args: [fileURLToPath(new URL('./fake-agent.mjs', import.meta.url))], env: { ACP_FAKE_MODE: 'compaction' }, environment: process.platform === 'darwin' ? 'restricted-writes' : 'person-rights' });
  const context: TurnContext = { tools: { list: async () => [], read: async () => null, write: async () => ({ outcome: 'REFUSED', detail: 'No writes' }) }, route: { kind: 'agent', provider: 'acp:fake', baseUrl: '', model: 'chosen-by-agent', label: 'Local fake agent', credential: null }, credential: async () => '' };
  const request: TurnRequest = { threadId: 'thread', turnId: 'first', text: 'Continue ledger', history: [], attachments: [], effort: 3, resumed: false };
  try {
    const first = harness.start(request, context);
    const events: HarnessEvent[] = [];
    for await (const event of first.events) events.push(event);
    const result = await first.outcome;
    assert.equal(result.status, 'done', result.error ?? 'Agent must continue');
    const compacted = events.filter(event => event.type === 'compaction');
    assert.ok(compacted.at(-1)?.type === 'compaction');
    assert.equal(compacted.at(-1)!.compaction.summary, 'Retained amber decision');
    assert.equal(compacted.at(-1)!.compaction.status, 'completed');
    const next = harness.start({ ...request, turnId: 'next', history: [{ role: 'user', text: request.text }, { role: 'assistant', text: result.answer }] }, context);
    for await (const _ of next.events) { /* drain the stream */ }
    const second = await next.outcome;
    assert.equal(second.status, 'done');
    assert.match(second.answer, /prompt-2/);
    assert.equal(second.answer.split(':')[0], result.answer.split(':')[0]);
    const reset = harness.start({ ...request, turnId: 'reset', history: [] }, context);
    const resetEvents: HarnessEvent[] = []; for await (const event of reset.events) resetEvents.push(event);
    assert.equal((await reset.outcome).status, 'done');
    const fresh = resetEvents.filter(event => event.type === 'compaction').at(-1);
    assert.equal(fresh?.compaction.summary, 'Retained amber decision', 'an invalidated native session cannot patch a new summary onto discarded rendering state');
  } finally { await harness.close(); }
});

test('ACP compaction patches preserve omitted text, clear null and allow existing updates at the count bound', () => {
  const projection = new AcpCompactions();
  projection.receive('s', { sessionUpdate: 'compaction_summary_chunk', compactionId: 'first', content: { type: 'text', text: 'Earlier' } });
  assert.equal(projection.receive('s', { sessionUpdate: 'compaction_update', compactionId: 'first', status: 'completed' })?.summary, 'Earlier');
  assert.equal(projection.receive('s', { sessionUpdate: 'compaction_update', compactionId: 'first', status: 'completed', summary: null })?.summary, '');
  for (let i = 1; i < 128; i++) projection.receive('s', { sessionUpdate: 'compaction_update', compactionId: String(i), status: 'completed' });
  assert.equal(projection.receive('s', { sessionUpdate: 'compaction_update', compactionId: 'first', status: 'completed', summary: [{ type: 'text', text: 'Replaced' }] })?.summary, 'Replaced');
  assert.throws(() => projection.receive('s', { sessionUpdate: 'compaction_update', compactionId: 'too-many', status: 'completed' }), /limit/);
});
