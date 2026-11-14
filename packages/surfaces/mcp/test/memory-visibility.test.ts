import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { memoryReferenceText } from '@backbone-next/platform';
import type { Gateway } from '@backbone-next/platform/gateway';
import { createDoorServer, type ReadLine } from '../src/server.ts';

test('memory search exposes tag text visibly in both MCP representations after the Host read', async () => {
  const original = 'Friday lunch ' + String.fromCodePoint(0xE0049, 0xE0067, 0xE006E) + '\u202ehidden\u202c';
  const entry = { id: 'memory', text: original, topic: 'notes', trust: 'untrusted' };
  let closed = 0;
  const server = createDoorServer({} as Gateway, { async open() {
    return { call: (async () => [entry]) as ReadLine['call'], close() { closed++; } };
  } });
  const client = new Client({ name: 'memory-visibility', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    const result = await client.callTool({ name: 'search_memory', arguments: { query: 'Friday lunch' } });
    assert.equal(result.isError, false);
    const structured = result.structuredContent as { value: { text: string; trust: string }[] };
    assert.equal(structured.value[0].text, memoryReferenceText(original));
    assert.equal(structured.value[0].trust, 'untrusted');
    const content = result.content.find(c => c.type === 'text') as { text: string };
    assert.equal(JSON.parse(content.text.slice(content.text.indexOf('\n') + 1)).value[0].text, memoryReferenceText(original));
    assert.doesNotMatch(structured.value[0].text, /\p{Cf}/u);
    assert.equal(entry.text, original, 'the Host result and its credential-check input are not mutated');
    assert.equal(closed, 1);
  } finally { await client.close(); await server.close(); }
});
