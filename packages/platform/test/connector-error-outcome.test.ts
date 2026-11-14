import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpSession } from '../src/connectors/client.ts';
import { CONNECTION_UNKNOWN } from '../src/connectors/service.ts';
import { pauseFixture } from './connector-pause-service-fixture.ts';

for (const error of [
  'Execution context was destroyed, most likely because of a navigation.',
  'Target page, context or browser has been closed',
  'net::ERR_CONNECTION_RESET',
  'frame was detached',
  '429 too many requests',
  'Not allowed: the folder is read-only.',
]) test(`an invoked effect returning ${error} is UNKNOWN and pauses only its tool and connection`, async t => {
  const f = await pauseFixture(t);
  const original = McpSession.prototype.call;
  t.mock.method(McpSession.prototype, 'call', async function (this: McpSession, ...args: Parameters<McpSession['call']>) {
    const answer = await original.apply(this, args);
    // The destination wrote the draft before its error reply; no phrase can undo that write.
    return args[0] === 'draft_note' && args[1].text === 'delivered' ? { observed: true, status: 'failed' as const, text: error } : answer;
  });
  const result = await f.call('draft_note', { text: 'delivered' });
  assert.equal(result.outcome === 'SENT' && result.state, 'unknown');
  assert.equal(f.calls().filter(call => call.tool === 'draft_note').length, 1);
  const again = await f.call('draft_note', { text: 'retry in other words' });
  assert.equal(again.outcome, 'HELD');
  assert.equal(again.detail, CONNECTION_UNKNOWN);
  assert.equal(f.held()[0].state, 'waiting');
  assert.equal(f.held()[0].standing, undefined);
  assert.equal(f.calls().filter(call => call.tool === 'draft_note').length, 1);
  assert.equal((await f.call('search', { q: 'independent read' })).outcome, 'READ');
  assert.equal((await f.call('plain', { x: 'another tool' })).outcome, 'SENT');
  assert.equal((await f.call('draft_note', { text: 'another connection' }, undefined, 'claude-code:other')).outcome, 'SENT');
});
