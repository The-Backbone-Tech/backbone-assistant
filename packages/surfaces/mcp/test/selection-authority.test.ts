import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createDoorServer } from '../src/server.ts';

for (const name of ['review-client', 'x'.repeat(100), '']) test(`MCP selection caps permission and identifies client with ${name.length} name characters`, async () => {
  const seen: { settings: { permission: string }; caller?: { mcp: string | null } }[] = [];
  const server = createDoorServer({} as never, { open: async () => ({ call: (async (_method: unknown, args: any) => {
    seen.push(args); return { ok: true, value: { started: null, detail: 'No runnable route', selection: {} } };
  }) as never, close() {} }) });
  const client = new Client({ name, version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    const args = { projectId: 'p', text: 'Write a brief', task: { needs: ['model'], network: false, spend: 'none' }, settings: { permission: 'ask', model: 'none', effort: 3, runsOn: 'this-computer', mode: 'chat' }, clientKey: 'client' };
    for (const permission of ['full', 'auto-review']) {
      const refused = await client.callTool({ name: 'solutions_run', arguments: { ...args, settings: { ...args.settings, permission } } });
      assert.equal(refused.isError, true);
      assert.equal(seen.length, 0);
    }
    await client.callTool({ name: 'solutions_run', arguments: args });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].settings.permission, 'ask');
    assert.equal(seen[0].caller?.mcp, name.slice(0, 60) || null);
  } finally { await client.close(); await server.close(); }
});
