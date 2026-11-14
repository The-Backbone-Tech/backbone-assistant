import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
// A destination can commit a write before its HTTP MCP response is lost. Observe that destination
// independently from the connector receipt: UNKNOWN must survive reopening, without another call.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { CoreLink } from '../src/composition/core.ts';
import { ConnectorService } from '../src/connectors/service.ts';
import { defaultToolEnv } from '../src/tools/places.ts';
import { freshDir, freshHome, value } from './helpers.ts';
import { MaterialStore } from '../src/stub/material.ts';
import { typedMaterialGateway } from './fixtures/typed-material-gateway.ts';

async function destination(resumable: boolean, outcome: 'lost' | 'replay' | 'input-required' | 'input-required-content' | 'input-required-text' | 'unknown-result' | 'request-state' | 'input-requests' | 'task-working' | 'task-completed' | 'redirect' = 'lost') {
  const writes: unknown[] = [];
  const calls: string[] = [];
  const resumptions: string[] = [];
  let pendingId: unknown;
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && outcome === 'replay' && request.headers['last-event-id'] === 'write-committed' && pendingId !== undefined) {
      resumptions.push(request.headers['last-event-id']);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(`event: message\nid: write-result\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: pendingId, result: { content: [{ type: 'text', text: 'Draft recorded.' }] } })}\n\n`);
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    calls.push(message.method);
    const reply = (result: unknown) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    };
    if (message.method === 'initialize') {
      reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'local-write-destination', version: '1.0.0' } });
    } else if (message.method === 'tools/list') {
      reply({ tools: [{ name: 'draft_note', description: 'Keep a local draft.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: false } }] });
    } else if (message.method === 'tools/call') {
      // This array stands for the destination's committed record, not the client's observation.
      writes.push(message.params.arguments);
      pendingId = message.id;
      if (outcome.startsWith('task-')) {
        reply({ task: { taskId: 'deferred-write', status: outcome === 'task-working' ? 'working' : 'completed', createdAt: '2026-11-05T00:00:00Z', lastUpdatedAt: '2026-11-05T00:00:00Z', ttl: 60_000 }, content: [{ type: 'text', text: 'A task record is not the tool result.' }] });
        return;
      }
      if (outcome === 'redirect') {
        if (request.url === '/mcp') response.writeHead(307, { Location: '/redirected-mcp' }).end();
        else reply({ content: [{ type: 'text', text: 'Draft recorded after redirect.' }] });
        return;
      }
      if (outcome.startsWith('input-required') || ['unknown-result', 'request-state', 'input-requests'].includes(outcome)) {
        // The response is untrusted. Even a request for another round cannot authorise another write.
        const content = outcome === 'input-required-text' ? [{ type: 'text', text: 'More input is needed.' }] : [];
        reply(outcome === 'unknown-result' ? { resultType: 'synthetic-unknown', content }
          : outcome === 'request-state' ? { requestState: 'synthetic-next-phase', content }
          : outcome === 'input-requests' ? { inputRequests: [], content }
          : { resultType: 'input_required', requestState: 'synthetic-next-phase', ...(outcome === 'input-required' ? {} : { content }) });
        return;
      }
      if (message.params.arguments.text === 'response-lost') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        // Start a real streamed JSON-RPC answer, then cut it before a complete event or result.
        const progress = resumable ? 'event: message\nid: write-committed\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":"write","progress":1}}\n\n' : '';
        const cut = `${progress}event: message\ndata: {"jsonrpc":"2.0","id":${JSON.stringify(message.id)},"result":`;
        // A graceful stream end makes the complete progress event observable before the absent result.
        // The original unrecoverable cases still cut the actual socket and reject every resume GET.
        if (outcome === 'replay') response.end(cut);
        else response.write(cut, () => response.destroy());
      } else {
        reply({ content: [{ type: 'text', text: 'Draft recorded.' }] });
      }
    } else {
      response.writeHead(202).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    writes, calls, resumptions, url: `http://127.0.0.1:${address.port}/mcp`,
    async close() {
      const stopped = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await stopped;
    },
  };
}

for (const resumable of [false, true]) test(`a committed HTTP MCP write with a cut response ${resumable ? 'after' : 'before'} an SSE event ID stays UNKNOWN without resend after reopening`, { timeout: TEST_HANG_MS * 2 }, async (t) => {
  const remote = await destination(resumable);
  t.after(() => remote.close());
  const home = freshHome();
  const personHome = freshDir('backbone-http-person-');
  writeFileSync(join(personHome, '.claude.json'), JSON.stringify({ mcpServers: { notes: { type: 'http', url: remote.url } } }));
  let link = await CoreLink.open({ home });
  const makeService = () => new ConnectorService({ home, env: () => defaultToolEnv({ HOME: personHome, PATH: process.env.PATH }), link: async () => link, callTimeoutMs: 1_000 });
  let service = makeService();
  t.after(async () => { await service.close(); await link.close(); });
  const id = 'claude-code:notes';
  const listed = value(await service.refresh(id));
  assert.deepEqual(listed.tools.map((tool) => tool.name), ['draft_note']);
  value(await service.set(id, { enabled: true }));
  value(await service.set(id, { tool: { name: 'draft_note', enabled: true } }));
  value(await service.set(id, { egress: true, seal: service.doorSeal(id)! }));
  const readHandle=await link.startRun(await link.createTask('HTTP effect read boundary'));
  const {gateway}=typedMaterialGateway({home,link,handle:readHandle,material:new MaterialStore(home,{},()=>{}),threadId:'http-thread',turnId:'http-turn'});
  const hold = async (text: string, seq: number) => {
    const tool = service.offered().find((tool) => tool.tool === 'draft_note');
    assert.ok(tool);
    const held = await service.call(tool, { text }, gateway.connector!, { threadId: 'http-thread', turnId: 'http-turn', seq,
      invocation:{engine:'codex',namespace:JSON.stringify(['http-native-thread','http-native-turn']),callId:`native-http-call-${seq}`} }, new AbortController().signal);
    assert.equal(held.outcome, 'HELD');
    const call = service.list().held.find((call) => call.state === 'waiting' && call.args.text === text);
    assert.ok(call);
    return call;
  };
  const status = async (effect: string) => (await link.read<{ status: string }>(link.system(), 'SELECT status FROM app.effects WHERE id = $1', [effect])).rows[0].status;

  // A working control proves the same HTTP route can complete a write through the actual service.
  const complete = await hold('complete-response', 1);
  assert.equal(remote.writes.length, 0, 'holding a write sends nothing');
  assert.equal(value(await service.decide(complete.effect, complete.argsHash, 'release')).state, 'sent');
  assert.equal(await status(complete.effect), 'succeeded');

  const lost = await hold('response-lost', 2);
  const unknown = value(await service.decide(lost.effect, lost.argsHash, 'release'));
  assert.equal(unknown.state, 'unknown');
  assert.match(unknown.detail, /UNKNOWN/);
  assert.equal(await status(lost.effect), 'unknown');
  assert.deepEqual(remote.writes, [{ text: 'complete-response' }, { text: 'response-lost' }], 'the lost response did not undo the destination write or cause a transport retry');
  assert.equal(value(await service.decide(lost.effect, lost.argsHash, 'release')).state, 'unknown');

  // Reopen the actual connector record and core, not an in-memory mock of either.
  await service.close();
  await link.close();
  link = await CoreLink.open({ home });
  service = makeService();
  assert.equal(service.list().held.find((call) => call.effect === lost.effect)?.state, 'unknown');
  assert.equal(value(await service.decide(lost.effect, lost.argsHash, 'release')).state, 'unknown');
  assert.equal(await status(lost.effect), 'unknown');
  assert.equal(remote.calls.filter((method) => method === 'tools/call').length, 2, 'one completed control plus one uncertain write, including repeated release and reopen');
  assert.equal(remote.writes.length, 2, 'no second application of the uncertain write');
});

for (const outcome of ['replay', 'input-required', 'input-required-content', 'input-required-text', 'unknown-result', 'request-state', 'input-requests', 'task-working', 'task-completed', 'redirect'] as const) test(`HTTP MCP ${outcome}: recover the result or retain uncertainty without another tool call`, { timeout: TEST_HANG_MS * 2 }, async (t) => {
  const remote = await destination(true, outcome);
  t.after(() => remote.close());
  const home = freshHome();
  const personHome = freshDir('backbone-http-replay-person-');
  writeFileSync(join(personHome, '.claude.json'), JSON.stringify({ mcpServers: { notes: { type: 'http', url: remote.url } } }));
  const link = await CoreLink.open({ home });
  const service = new ConnectorService({ home, env: () => defaultToolEnv({ HOME: personHome, PATH: process.env.PATH }), link: async () => link, callTimeoutMs: 5_000 });
  t.after(async () => { await service.close(); await link.close(); });
  const id = 'claude-code:notes';
  value(await service.refresh(id));
  value(await service.set(id, { enabled: true }));
  value(await service.set(id, { tool: { name: 'draft_note', enabled: true } }));
  value(await service.set(id, { egress: true, seal: service.doorSeal(id)! }));
  const readHandle=await link.startRun(await link.createTask('HTTP replay effect read boundary'));
  const {gateway}=typedMaterialGateway({home,link,handle:readHandle,material:new MaterialStore(home,{},()=>{}),threadId:'replay-thread',turnId:'replay-turn'});
  const tool = service.offered().find((tool) => tool.tool === 'draft_note');
  assert.ok(tool);
  assert.equal((await service.call(tool, { text: 'response-lost' }, gateway.connector!, { threadId: 'replay-thread', turnId: 'replay-turn', seq: 1,
    invocation:{engine:'codex',namespace:JSON.stringify(['replay-native-thread','replay-native-turn']),callId:'native-replay-call-1'} }, new AbortController().signal)).outcome, 'HELD');
  const held = service.list().held.find((call) => call.state === 'waiting');
  assert.ok(held);
  const result = value(await service.decide(held.effect, held.argsHash, 'release'));
  if (outcome === 'redirect') t.diagnostic(JSON.stringify({ destinationWrites: remote.writes.length, toolCalls: remote.calls.filter((method) => method === 'tools/call').length, receipt: result.state }));
  assert.equal(remote.calls.filter((method) => method === 'tools/call').length, 1, 'one released call is not reissued by the SDK');
  assert.deepEqual(remote.writes, [{ text: 'response-lost' }], 'the destination applies the write once');
  const status = (await link.read<{ status: string }>(link.system(), 'SELECT status FROM app.effects WHERE id = $1', [held.effect])).rows[0].status;
  if (outcome === 'replay') {
    assert.ok(remote.resumptions.includes('write-committed'), 'the real client resumes through a Last-Event-ID GET');
    assert.equal(result.state, 'sent', 'a recovered terminal result establishes completion');
    assert.equal(status, 'succeeded');
  } else {
    assert.equal(result.state, 'unknown', 'a nonterminal server response does not prove completion or authorise another call');
    assert.equal(status, 'unknown');
  }
  assert.ok(remote.calls.includes('initialize'), 'the supported compatibility configuration uses its pinned handshake');
  assert.equal(remote.calls.includes('server/discover'), false, 'no implicit modern negotiation enables a tools/call re-list retry');
  assert.equal(value(await service.decide(held.effect, held.argsHash, 'release')).state, result.state);
  assert.equal(remote.calls.filter((method) => method === 'tools/call').length, 1);
});
