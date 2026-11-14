import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { TurnContext, TurnRequest } from '@backbone-next/platform/ports';
import { createAcpHarness } from '../src/index.ts';
const fixture = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));
const request: TurnRequest = { threadId: 'invalid-tools', turnId: 'one', text: 'ready', history: [], attachments: [], effort: 3, resumed: false };
for (const [tool, args] of [['write_file', { name: 5, body: 'x' }], ['write_file', { name: 'x', body: 5 }], ['connector_mcp__notes__search', 5], ['connector_mcp__notes__search', []], ['read_file', { name: 5 }], ['search_memory', { query: 5 }], ['propose_memory', { text: 'x', topic: 5 }], ['propose_goal', { text: 5 }], ['add_card', { brief: 'x', dependsOn: [5] }], ['message_card', { card: 'x', text: 5 }], ['start_child', { brief: 5, role: 'worker' }], ['await_child', { threadId: 5 }]] as const) test(`invalid ${tool} arguments ${JSON.stringify(args)} are ordinary errors with no Host call or invented UNKNOWN`, async () => {
  let calls = 0;
  const reached = async (): Promise<never> => { calls++; throw new Error('Invalid arguments must not reach Host'); };
  const context: TurnContext = { tools: { list: reached, read: reached, write: reached, searchMemory: reached, proposeMemory: reached, proposeGoal: reached, addCard: reached, messageCard: reached, startChild: reached, awaitChild: reached,
    connectors: () => [{ name: 'mcp__notes__search', server: 'notes', tool: 'search', kind: 'effect', description: 'Owned fake connector', inputSchema: { type: 'object' } }], callConnector: reached }, route: { kind: 'agent', provider: 'acp:fake', baseUrl: '', model: 'chosen-by-agent', label: 'fake', credential: null }, credential: reached };
  const h = createAcpHarness({ acceptsProcessVisibility: true, command: process.execPath, args: [fixture], environment: process.platform === 'darwin' ? 'restricted-writes' : 'person-rights', env: { ACP_FAKE_MODE: 'mcp-tool', ACP_FAKE_TOOL: tool, ACP_FAKE_ARGS: JSON.stringify(args) } });
  try { const outcome = await h.start(request, context).outcome; assert.equal(outcome.status, 'done'); assert.equal(calls, 0); assert.equal(JSON.parse(outcome.answer).isError, true); assert.doesNotMatch(outcome.error ?? '', /unknown|definitive receipt/i); }
  finally { await h.close(); }
});
