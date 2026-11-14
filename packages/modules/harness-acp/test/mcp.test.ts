import { directoryIdentity, assertDirectory } from '../src/directories.ts';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
async function bridgeFor(current: () => ToolTurn) {
  const state = await mkdtemp(join(tmpdir(), 'acp-mcp-test-'));
  const identity = directoryIdentity(state);
  const bridge = await toolBridge(current, () => {}, () => {}, identity, () => assertDirectory(identity));
  const capability = JSON.parse(await readFile(bridge.spec.args!.at(-1)!, 'utf8'));
  return { ...bridge, capability, async close() { await bridge.close(); await rm(state, { recursive: true, force: true }); } };
}
import { toolBridge, type ToolTurn } from '../src/mcp.ts';

// A slow sender must not turn an old turn's request into a new turn's effect.
test('an MCP request admitted in one turn cannot execute through the next turn', { timeout: 2000 }, async () => {
  const writes: string[] = [];
  const turn = (id: string): ToolTurn => ({ request: { threadId: 'thread', turnId: id, text: '', history: [], attachments: [], effort: 3, resumed: false }, stopped: false, writeClosed: false, signal: new AbortController().signal, context: { tools: { list: async () => [], read: async () => null, write: async () => { writes.push(id); return { outcome: 'DONE', name: 'x', version: 1 }; } }, route: { kind: 'agent', provider: 'acp:fake', model: 'chosen-by-agent', label: 'fake', baseUrl: '', credential: null }, credential: async () => '' } });
  let current = turn('A');
  const bridge = await bridgeFor(() => current);
  const env = bridge.capability;
  try {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_file', arguments: { name: 'x', body: 'x' } } });
    let sendRest!: () => void, admitted!: () => void;
    const admission = new Promise<void>(resolve => { admitted = resolve; });
    const response = new Promise<number>(resolve => {
      const req = httpRequest(env.url, { method: 'POST', headers: { authorization: `Bearer ${env.token}`, 'content-length': Buffer.byteLength(body), expect: '100-continue' } }, res => { res.resume(); resolve(res.statusCode!); });
      req.on('continue', admitted); req.write(body.slice(0, 10)); sendRest = () => req.end(body.slice(10));
    });
    await admission;
    current.stopped = true; current = turn('B'); sendRest();
    assert.equal(await response, 403); assert.deepEqual(writes, []);
  } finally { await bridge.close(); }
});

test('wrong bearer tokens and a false per-call send gate dispatch no tool', async () => {
  let writes = 0, allowed = true;
  const turn: ToolTurn = { request: { threadId: 't', turnId: 'u', text: '', history: [], attachments: [], effort: 3, resumed: false, stillAllowed: () => allowed ? true : 'withdrawn' }, stopped: false, writeClosed: false, signal: new AbortController().signal, context: { tools: { list: async () => [], read: async () => null, write: async () => { writes++; return { outcome: 'DONE', name: 'x', version: 1 }; } }, route: { kind: 'agent', provider: 'acp:fake', model: 'chosen-by-agent', label: 'fake', baseUrl: '', credential: null }, credential: async () => '' } };
  const bridge = await bridgeFor(() => turn), env = bridge.capability;
  const call = (token: string) => fetch(env.url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_file', arguments: { name: 'x', body: 'x' } } }) });
  try {
    assert.equal((await call('wrong-token')).status, 403); assert.equal(writes, 0);
    allowed = false;
    assert.equal((await (await call(env.token)).json()).result.isError, true); assert.equal(writes, 0);
    allowed = true;
    assert.equal((await (await call(env.token)).json()).result.isError, undefined); assert.equal(writes, 1);
  } finally { await bridge.close(); }
});

test('parallel writes serialize and an UNKNOWN result closes the waiting write', async () => {
  let release!: () => void, begun!: () => void, writes = 0;
  const started = new Promise<void>(resolve => { begun = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const turn: ToolTurn = { request: { threadId: 't', turnId: 'u', text: '', history: [], attachments: [], effort: 3, resumed: false }, stopped: false, writeClosed: false, signal: new AbortController().signal, context: { tools: { list: async () => [], read: async () => null, write: async () => { writes++; begun(); await held; return { outcome: 'UNKNOWN', detail: 'uncertain' }; } }, route: { kind: 'agent', provider: 'acp:fake', model: 'chosen-by-agent', label: 'fake', baseUrl: '', credential: null }, credential: async () => '' } };
  const bridge = await bridgeFor(() => turn), env = bridge.capability;
  const call = (name: string) => fetch(env.url, { method: 'POST', headers: { authorization: `Bearer ${env.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: name, method: 'tools/call', params: { name: 'write_file', arguments: { name, body: name } } }) }).then(r => r.json());
  try {
    const one = call('one'); await started; const two = call('two');
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(writes, 1); release();
    const result = await Promise.all([one, two]); assert.equal(writes, 1); assert.equal(result[1].result.isError, true);
  } finally { release(); await bridge.close(); }
});

test('bounded tool settlement retains uncertainty when a Host call cannot finish', async () => {
  const { settleToolCalls } = await import('../src/mcp.ts');
  const turn = { inFlight: new Set([new Promise<void>(() => {})]), writeClosed: false, unknown: undefined as string | undefined } as ToolTurn;
  await settleToolCalls(turn, 1);
  assert.match(turn.unknown ?? '', /still in flight.*UNKNOWN/); assert.equal(turn.writeClosed, true);
});
