import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HOST_TOOLS, WorkspaceRefusal, type HarnessEvent } from '@backbone-next/platform/ports';
import { directoryIdentity, assertDirectory } from '../src/directories.ts';
import { toolBridge, type ToolTurn } from '../src/mcp.ts';

test('ACP exposes the shared offline workspace only when granted and forwards through the Host bridge', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acp-workspace-tool-')), identity = directoryIdentity(root), calls: unknown[] = [];
  const events: HarnessEvent[] = [];
  let reply: string | Error = '{"code":0,"stdout":"23","stderr":""}';
  const turn: ToolTurn = { push: event => { events.push(event); }, stopped: false, writeClosed: false, signal: new AbortController().signal, request: { threadId: 'thread', turnId: 'turn', text: '', history: [], attachments: [], effort: 3, resumed: false }, context: { tools: { list: async () => [], read: async () => null, write: async () => ({ outcome: 'REFUSED', detail: 'ungranted' }), runWorkspace: async (request, signal) => { calls.push(request); assert.equal(signal, turn.signal); if (reply instanceof Error) throw reply; return reply; } }, route: { kind: 'agent', provider: 'acp:fake', model: 'chosen-by-agent', baseUrl: '', credential: null, label: 'fake' }, credential: async () => { throw new Error('No credential'); } } };
  const bridge = await toolBridge(() => turn, () => {}, () => {}, identity, () => assertDirectory(identity));
  try {
    const cap = JSON.parse(await readFile(bridge.spec.args!.at(-1)!, 'utf8'));
    const send = async (method: string, params = {}) => (await fetch(cap.url, { method: 'POST', headers: { authorization: `Bearer ${cap.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
    const catalog = await send('tools/list');
    assert.deepEqual(catalog.result.tools.find((tool: { name: string }) => tool.name === 'workspace_run'), { name: 'workspace_run', description: HOST_TOOLS.workspace_run.description, inputSchema: HOST_TOOLS.workspace_run.inputSchema });
    const result = await send('tools/call', { name: 'workspace_run', arguments: { command: 'sqlite3 data.db "select 23"', attachment: 'sales.csv' } });
    assert.equal(result.result.isError, undefined); assert.deepEqual(calls, [{ command: 'sqlite3 data.db "select 23"', attachment: 'sales.csv' }]);
    const bad = await send('tools/call', { name: 'workspace_run', arguments: { command: 42 } }); assert.equal(bad.result.isError, true); assert.equal(calls.length, 1);
    for (const [text, phase] of [
      [WorkspaceRefusal.beforeCommand(new WorkspaceRefusal('private output: policy refused')), 'refused'],
      [new WorkspaceRefusal('private output: post-dispatch invalidation'), 'unknown'],
      [new Error('A workspace source is no longer granted.'), 'unknown'],
      [JSON.stringify({ code: null, stdout: '', stderr: '', refused: 'policy' }), 'refused'],
      [JSON.stringify({ code: 1, stdout: 'private output', stderr: 'Operation not permitted' }), 'failed'],
      [JSON.stringify({ code: 0, stdout: 'private output', stderr: '', reason: 'cleanup unconfirmed' }), 'unknown'],
      ['Host plain text: private output', 'unknown'],
    ] as const) {
      reply = text!;
      const failed = await send('tools/call', { name: 'workspace_run', arguments: { command: 'owned failure' } });
      assert.equal(failed.result.isError, true);
      if (reply instanceof Error) assert.doesNotMatch(JSON.stringify(failed.result.content), /private output|no longer granted/);
      else assert.equal(JSON.parse(failed.result.content[0].text), reply);
      const end = events.at(-1);
      assert.equal(end?.type === 'tool' && end.phase, phase);
      assert.doesNotMatch(JSON.stringify(end), /private output|Operation not permitted/);
      assert.equal(turn.stopped, false); assert.equal(turn.unknown, undefined);
    }
    turn.request.readOnly = true; assert.equal((await send('tools/list')).result.tools.some((tool: { name: string }) => tool.name === 'workspace_run'), false);
    turn.request.readOnly = false; delete turn.context.tools.runWorkspace; assert.equal((await send('tools/list')).result.tools.some((tool: { name: string }) => tool.name === 'workspace_run'), false);
  } finally { await bridge.close(); await rm(root, { recursive: true, force: true }); }
});
