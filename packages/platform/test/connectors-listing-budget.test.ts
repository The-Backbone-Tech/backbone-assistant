// Real stdio MCP sessions: discovery is independent of the deadline for an invoked tool.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { TEST_HANG_MS, hangDetector } from '../../../scripts/lib/test-hang.ts';
import { McpSession } from '../src/connectors/client.ts';
import { ConnectorService } from '../src/connectors/service.ts';
import { CoreLink } from '../src/composition/core.ts';
import { defaultToolEnv } from '../src/tools/places.ts';
import { pauseFixture } from './connector-pause-service-fixture.ts';
import { freshDir, freshHome, value } from './helpers.ts';

test('listing and live definition checks keep their own budget while an unanswered call becomes UNKNOWN', { timeout: TEST_HANG_MS * 2 }, async t => {
  const budgets: (number | undefined)[] = [], calls: (number | undefined)[] = [];
  const tools = McpSession.prototype.tools, call = McpSession.prototype.call;
  t.mock.method(McpSession.prototype, 'tools', function(this: McpSession, ms?: number) {
    budgets.push(ms);
    // Keep the real stdio listing; assert the hand-off rather than racing two timers.
    return tools.call(this, ms);
  });
  t.mock.method(McpSession.prototype, 'call', function(this: McpSession, ...args: Parameters<typeof call>) {
    calls.push(args[3]); return call.apply(this, args);
  });
  const f = await pauseFixture(t);
  assert.ok(budgets.length >= 2);
  assert.ok(budgets.every(ms => ms === undefined), `listing received execution budgets: ${JSON.stringify(budgets)}`);
  const beforeValidation = budgets.length;
  const result = await hangDetector(f.call('lost_note'), 'unanswered real MCP call settles', { diagnostic: () => JSON.stringify({ budgets, calls, held: f.held(), dispatched: f.calls() }) });
  assert.ok(budgets.length > beforeValidation, 'invocation must actually recheck the live definition');
  assert.equal(result.outcome, 'SENT');
  assert.equal(result.outcome === 'SENT' && result.state, 'unknown');
  assert.deepEqual(calls, [250], 'the invocation still gets its short product deadline');
  assert.equal(f.calls().filter(c => c.tool === 'lost_note').length, 1);
  assert.equal((await f.call('lost_note', {}, 'later')).outcome, 'REFUSED');
  assert.equal(f.calls().filter(c => c.tool === 'lost_note').length, 1, 'an unanswered invocation is never resent');
  assert.ok(budgets.every(ms => ms === undefined), 'live validation also uses the listing budget');
});

test('a slow real MCP listing can be enabled with a shorter tool-call deadline', { timeout: TEST_HANG_MS * 2 }, async t => {
  const home = freshHome(), person = freshDir('connector-list-budget-'), control = join(person, 'tools.json');
  writeFileSync(control, JSON.stringify([{ name: 'draft_note', description: 'Local test action.', inputSchema: { type: 'object' } }]));
  writeFileSync(join(person, '.claude.json'), JSON.stringify({ mcpServers: { slow: { command: process.execPath,
    args: [join(import.meta.dirname, 'fake-mcp-kind-server.ts')], env: { FAKE_KIND_CONTROL: control, FAKE_KIND_LOG: join(person, 'calls.jsonl'), FAKE_KIND_LIST_DELAY_MS: '500' } } } }));
  const link = await CoreLink.open({ home }); t.after(() => link.close());
  const service = new ConnectorService({ home, env: () => defaultToolEnv({ HOME: person, PATH: process.env.PATH }), link: async () => link, callTimeoutMs: 250 });
  t.after(() => service.close());
  let listed: unknown;
  const shown = value(await hangDetector(service.refresh('claude-code:slow').then(result => { listed = result; return result; }), 'slow real MCP listing', { diagnostic: () => JSON.stringify({ listed, catalogue: service.list() }) }));
  assert.equal(shown.problem, undefined);
  assert.deepEqual(shown.tools.map(tool => tool.name), ['draft_note']);
  value(await service.set('claude-code:slow', { enabled: true }));
  assert.equal(service.list().servers.find(server => server.id === 'claude-code:slow')?.enabled, true);
});
