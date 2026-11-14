import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { Gateway } from '@backbone-next/platform/gateway';
import { createDoorServer, type ReadLine } from '../src/server.ts';

test('MCP list_schedules hides wake-gate configuration even if the read source supplied it', async () => {
  const view = { schedules: [{ id: 's', wakeGate: { command: '/usr/bin/private-program', args: ['fake-canary-secret'] } }], heartbeat: null, runs: [] };
  const server = createDoorServer({} as Gateway, { async open() { return { call: (async () => view) as ReadLine['call'], close() {} }; } });
  const client = new Client({ name: 'gate-privacy', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    const result = await client.callTool({ name: 'list_schedules', arguments: {} });
    assert.equal(result.isError, false);
    const text = JSON.stringify(result);
    assert.ok(!text.includes('private-program') && !text.includes('fake-canary-secret'));
    assert.equal((result.structuredContent as { value: { schedules: { hasWakeGate: boolean }[] } }).value.schedules[0].hasWakeGate, true);
    assert.equal(view.schedules[0].wakeGate.args[0], 'fake-canary-secret');
  } finally { await client.close(); await server.close(); }
});
