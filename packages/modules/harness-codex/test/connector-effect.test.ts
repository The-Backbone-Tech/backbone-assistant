// The native connector handoff with the same abort signal its owning native turn uses.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConnectorToolSpec, ToolHost } from '@backbone-next/platform/ports';
import { carryCodexConnector } from '../src/index.ts';

for (const state of ['unknown', 'failed', 'sent'] as const) test(`Codex signed effect ${state}: stop only on uncertainty`, async () => {
  const tool: ConnectorToolSpec = { name: 'first', server: 'fixture', tool: 'first', description: 'Signed effect', kind: 'effect', inputSchema: { type: 'object' } };
  const acknowledged = { threadId: 'native-thread', turnId: 'native-turn' };
  const abort = new AbortController();
  const called: string[] = [];
  let stops = 0;
  const detail = `Provider effect ${state}; check the provider when unknown.`;
  const tools: Pick<ToolHost, 'callConnector'> = { callConnector: async name => { called.push(name); return { outcome: 'SENT', state, detail }; } };
  const stop = () => { stops++; abort.abort(); };
  const result = await carryCodexConnector(tools, tool, { ...acknowledged, callId: 'first-call', arguments: {} }, acknowledged, abort.signal, stop);
  assert.equal(result?.success, state === 'sent');
  assert.deepEqual(result?.contentItems, [{ type: 'inputText', text: detail }]);
  const second = await carryCodexConnector(tools, { ...tool, name: 'second', tool: 'second' }, { ...acknowledged, callId: 'second-call', arguments: { text: 'different' } }, acknowledged, abort.signal, stop);
  assert.equal(stops, state === 'unknown' ? 1 : 0);
  assert.deepEqual(called, state === 'unknown' ? ['first'] : ['first', 'second']);
  if (state === 'unknown') assert.equal(second, null);
  else assert.equal(second?.success, state === 'sent');
});
