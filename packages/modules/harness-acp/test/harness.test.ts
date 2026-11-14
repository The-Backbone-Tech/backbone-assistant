import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { HarnessEvent, TurnContext, TurnRequest } from '@backbone-next/platform/ports';
import { createAcpHarness } from '../src/index.ts';
const fixture = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));
export const request = (extra: Partial<TurnRequest> = {}): TurnRequest => ({ threadId: 'thread', turnId: 'turn', text: 'Reply ready.', history: [], attachments: [], effort: 3, resumed: false, ...extra });
const context: TurnContext = { tools: { list: async () => [], read: async () => null, write: async () => ({ outcome: 'REFUSED', detail: 'not granted' }) }, route: { kind: 'agent', provider: 'acp:fake', baseUrl: '', model: 'chosen-by-agent', label: 'Fake ACP agent', credential: null }, credential: async () => { throw new Error('No credentials.'); } };
const harnesses: ReturnType<typeof createAcpHarness>[] = [];
afterEach(async () => { await Promise.all(harnesses.splice(0).map(h => h.close())); });
const harness = (mode = 'normal', storageDir?: string, env: Record<string, string> = {}) => { const h = createAcpHarness({ acceptsProcessVisibility: true, command: process.execPath, args: [fixture], env: { ACP_FAKE_MODE: mode, ...env }, environment: process.platform === 'darwin' ? 'restricted-writes' : 'person-rights', requestTimeoutMs: 1000, stopTimeoutMs: 80, turnTimeoutMs: 2000, storageDir }); harnesses.push(h); return h; };
async function collect(events: AsyncIterable<HarnessEvent>) { const out: HarnessEvent[] = []; for await (const event of events) out.push(event); return out; }
test('a prompt streams updates to a final answer through the Harness port', async () => {
  const turn = harness().start(request(), context);
  const [outcome, events] = await Promise.all([turn.outcome, collect(turn.events)]);
  assert.equal(outcome.status, 'done', outcome.error ?? ''); assert.equal(outcome.answer, 'ready');
  assert.deepEqual(events, [{ type: 'text', delta: 'rea' }, { type: 'text', delta: 'dy' }]);
});

for (const mode of ['wait', 'ignore-cancel']) test(`Stop cancels a ${mode} prompt and never succeeds`, async () => {
  const turn = harness(mode).start(request(), context);
  const events = (async () => { for await (const event of turn.events) if (event.type === 'text' && event.delta === 'rea') turn.stop(); })();
  const outcome = await turn.outcome; await events;
  assert.equal(outcome.status, 'interrupted');
  if (mode === 'wait') assert.match(outcome.answer, /cancel-observed/);
});
test('an agent that dies mid-turn fails instead of succeeding', async () => {
  const turn = harness('die').start(request(), context);
  assert.equal((await turn.outcome).status, 'failed');
});
test('a malformed frame does not crash the caller', async () => {
  const turn = harness('malformed').start(request(), context);
  const result = await turn.outcome;
  assert.ok(['done', 'failed'].includes(result.status));
  assert.equal((await harness().start(request(), context).outcome).status, 'done');
});

for (const mode of ['permission', 'permission-allow-only']) test(`${mode} is refused when the port grants no approval`, async () => {
  const turn = harness(mode).start(request(), context);
  const [outcome, events] = await Promise.all([turn.outcome, collect(turn.events)]);
  assert.equal(outcome.status, 'done');
  assert.match(outcome.answer, mode === 'permission' ? /permission:reject/ : /permission:cancelled/);
  assert.match(outcome.answer, /permission refused/);
  assert.ok(events.some(e => e.type === 'tool' && e.phase === 'refused'));
});

test('an ACP file write outside the working folder is refused and the agent is told why', async () => {
  const outcome = await harness('file-outside').start(request(), context).outcome;
  assert.equal(outcome.status, 'done'); assert.match(outcome.answer, /refused:Only regular scratch files/);
});
test('an ACP scratch write inside the working folder succeeds', async () => {
  const outcome = await harness('file-inside').start(request(), context).outcome;
  assert.equal(outcome.status, 'done'); assert.equal(outcome.answer, 'scratch:written');
});
test('client terminal execution is refused because the port grants no command', async () => {
  const outcome = await harness('terminal').start(request(), context).outcome;
  assert.equal(outcome.status, 'done'); assert.match(outcome.answer, /refused:.*no client terminal/);
});
test('the write-restriction profile limits direct filesystem writes by the fake ACP agent', async () => {
  const h = createAcpHarness({ acceptsProcessVisibility: true, command: process.execPath, args: [fixture], env: { ACP_FAKE_MODE: 'direct-write' }, environment: 'restricted-writes' }); harnesses.push(h);
  const outcome = await h.start(request(), context).outcome;
  if (process.platform !== 'darwin') { assert.equal(outcome.status, 'failed'); return; }
  assert.equal(outcome.status, 'done'); assert.equal(outcome.answer, 'inside:allowed;outside:denied');
});

test('a second prompt continues the same agent session without load support', async () => {
  const h = harness('continuity');
  const first = await h.start(request(), context).outcome;
  const second = await h.start(request({ turnId: 'second', history: [{ role: 'user', text: 'Reply ready.' }, { role: 'assistant', text: first.answer }] }), context).outcome;
  assert.equal(first.status, 'done'); assert.equal(second.status, 'done');
  assert.equal(second.answer, first.answer.replace('prompt-1', 'prompt-2'));
});
test('a new module instance resumes an agent that supports session/load', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'acp-resume-'));
  try {
    const firstHarness = harness('load', storage), first = await firstHarness.start(request(), context).outcome;
    await firstHarness.close();
    const second = await harness('load', storage).start(request({ turnId: 'second', history: [{ role: 'user', text: 'Reply ready.' }, { role: 'assistant', text: first.answer }] }), context).outcome;
    assert.equal(first.status, 'done'); assert.equal(second.status, 'done');
    assert.equal(second.answer, first.answer.replace('loaded-false', 'loaded-true'));
  } finally { await Promise.all(harnesses.map(h => h.close())); await rm(storage, { recursive: true, force: true }); }
});

test('Backbone canonical writes are offered over ACP MCP and use ToolHost decisions', async () => {
  const calls: string[] = [];
  const ctx: TurnContext = { ...context, tools: { ...context.tools, write: async (name, body) => { calls.push(`${name}:${body}`); return { outcome: 'REFUSED', detail: 'not granted' }; } } };
  const result = await harness('mcp-write').start(request(), ctx).outcome;
  assert.equal(result.status, 'done', result.error ?? '');
  assert.deepEqual(calls, ['brief.md:# ACP brief\n']); assert.match(result.answer, /REFUSED/);
});
test('memory search and connector tools cross only through the active ToolHost', async () => {
  const ctx: TurnContext = { ...context, tools: { ...context.tools, searchMemory: async q => `memory:${q}`, connectors: () => [{ name: 'mcp__notes__search', server: 'notes', tool: 'search', description: 'Search notes', inputSchema: { type: 'object' }, kind: 'read' }], callConnector: async (_name, args) => ({ outcome: 'READ', status: 'partial', text: String(args.q), detail: 'More remain.' }) } };
  const memory = await harness('mcp-memory').start(request(), ctx).outcome;
  assert.equal(memory.status, 'done'); assert.match(memory.answer, /memory:launch/);
  const connector = await harness('mcp-connector').start(request(), ctx).outcome;
  assert.equal(connector.status, 'done'); assert.match(connector.answer, /partial/); assert.match(connector.answer, /More remain/);
});

test('changed allowed history discards a prior native session', async () => {
  const h = harness('continuity');
  const first = await h.start(request(), context).outcome;
  const next = await h.start(request({ turnId: 'changed', history: [] }), context).outcome;
  assert.equal(next.status, 'done'); assert.notEqual(next.answer.split(':')[0], first.answer.split(':')[0]);
});
test('a withdrawn canonical source discards retained agent context before the next prompt', async () => {
  let withdrawn = false;
  const note = { name: 'note.md', materialId: 'm1', projectId: 'p1', version: 1, withdrawals: 0, by: 'person' as const, class: 'original' as const, mediaType: 'text/plain', text: 'permitted source' };
  const ctx: TurnContext = { ...context, tools: { ...context.tools, read: async () => withdrawn ? null : note, stillGranted: () => withdrawn ? 'withdrawn' : true } };
  const h = harness('mcp-read'), first = await h.start(request(), ctx).outcome;
  assert.equal(first.status, 'done'); assert.match(first.answer, /permitted source/);
  withdrawn = true;
  const next = await h.start(request({ turnId: 'withdrawn', history: [{ role: 'user', text: 'Reply ready.' }, { role: 'assistant', text: first.answer }] }), ctx).outcome;
  assert.equal(next.status, 'interrupted'); assert.equal(next.answer, '');
  assert.match(next.error ?? '', /retained ACP source changed/);
});
test('the send-time gate refuses inference and stopped turns are not replayed', async () => {
  assert.equal((await harness().start(request({ stillAllowed: () => 'source withdrawn' }), context).outcome).status, 'interrupted');
  assert.equal((await harness().start(request({ resumed: true }), context).outcome).status, 'failed');
});

test('an agent that exits while idle is loaded before the next prompt', async () => {
  const h = harness('idle-exit'), first = await h.start(request(), context).outcome;
  await new Promise(resolve => setTimeout(resolve, 40));
  const next = await h.start(request({ turnId: 'next', history: [{ role: 'user', text: 'Reply ready.' }, { role: 'assistant', text: first.answer }] }), context).outcome;
  assert.equal(next.status, 'done'); assert.equal(next.answer, first.answer.replace('loaded-false', 'loaded-true'));
});
test('closing during process setup joins and stops the active turn', async () => {
  const h = harness('wait'), turn = h.start(request(), context);
  await h.close(); assert.equal((await turn.outcome).status, 'interrupted');
});

test('optional memory, goal, card and child tools are offered only when supplied by ToolHost', async () => {
  const calls: string[] = [];
  const ctx: TurnContext = { ...context, tools: { ...context.tools,
    proposeMemory: async p => { calls.push(`memory:${p.text}`); return 'held'; },
    proposeGoal: async text => { calls.push(`goal:${text}`); },
    addCard: async p => { calls.push(`card:${p.brief}`); return { outcome: 'ADDED', cardId: 'c1', status: 'open' }; },
    messageCard: async p => { calls.push(`message:${p.card}`); return { outcome: 'SENT', state: 'running' }; },
    startChild: async p => { calls.push(`child:${p.role}`); return { outcome: 'STARTED', threadId: 'child' }; },
    awaitChild: async id => { calls.push(`await:${id}`); return null; },
  } };
  for (const [tool, args] of [['propose_memory', { text: 'remember' }], ['propose_goal', { text: 'goal' }], ['add_card', { brief: 'card' }], ['message_card', { card: 'c1', text: 'peer data' }], ['start_child', { brief: 'work', role: 'worker' }], ['await_child', { threadId: 'child' }]] as const) {
    const result = await harness('mcp-tool', undefined, { ACP_FAKE_TOOL: tool, ACP_FAKE_ARGS: JSON.stringify(args) }).start(request(), ctx).outcome;
    assert.equal(result.status, 'done'); assert.doesNotMatch(result.answer, /isError/);
  }
  assert.deepEqual(calls, ['memory:remember', 'goal:goal', 'card:card', 'message:c1', 'child:worker', 'await:child']);
  const absent = await harness('mcp-tool', undefined, { ACP_FAKE_TOOL: 'propose_goal', ACP_FAKE_ARGS: '{"text":"no grant"}' }).start(request(), context).outcome;
  assert.match(absent.answer, /isError/);
});
test('UNKNOWN closes canonical writes so another write cannot be resent', async () => {
  let calls = 0;
  const ctx: TurnContext = { ...context, tools: { ...context.tools, write: async () => { calls++; return { outcome: 'UNKNOWN', detail: 'receipt lost' }; } } };
  const result = await harness('mcp-twice').start(request(), ctx).outcome;
  assert.equal(result.status, 'interrupted'); assert.match(result.error ?? '', /receipt lost/); assert.equal(calls, 1); assert.match(result.answer, /UNKNOWN/); assert.match(result.answer, /isError/);
});

test('a connector UNKNOWN stops the ACP turn instead of allowing model continuation or success', async () => {
  let calls = 0, writes = 0;
  const ctx: TurnContext = { ...context, tools: { ...context.tools,
    connectors: () => [{ name: 'mcp__notes__search', server: 'notes', tool: 'search', kind: 'read', description: 'Owned fake', inputSchema: { type: 'object' } }],
    callConnector: async () => { calls++; return { outcome: 'UNKNOWN', detail: 'Original observation is unresolved; do not redispatch.' }; },
    write: async () => { writes++; return { outcome: 'DONE', name: 'unexpected', version: 1 }; },
  } };
  const turn = harness('mcp-connector-then-write').start(request(), ctx), outcome = await turn.outcome;
  assert.equal(outcome.status, 'interrupted'); assert.match(outcome.error ?? '', /Original observation is unresolved/);
  assert.equal(calls, 1); assert.equal(writes, 0);
});

test('a signed connector call sent with no answer stops the ACP turn like any unknown outcome', async () => {
  let calls = 0, writes = 0;
  const ctx: TurnContext = { ...context, tools: { ...context.tools,
    connectors: () => [{ name: 'mcp__notes__search', server: 'notes', tool: 'search', kind: 'effect', description: 'Owned fake: the tool name is the one the scripted agent calls', inputSchema: { type: 'object' } }],
    callConnector: async () => { calls++; return { outcome: 'SENT', state: 'unknown', detail: 'notes gave no answer, so whether it happened is UNKNOWN. It is never sent again; check it there.' }; },
    write: async () => { writes++; return { outcome: 'DONE', name: 'unexpected', version: 1 }; },
  } };
  const turn = harness('mcp-connector-then-write').start(request(), ctx), outcome = await turn.outcome;
  assert.equal(outcome.status, 'interrupted'); assert.match(outcome.error ?? '', /whether it happened is UNKNOWN/);
  assert.equal(calls, 1); assert.equal(writes, 0);
});

test('a signed connector call that the server did carries on as an ordinary result', async () => {
  let writes = 0;
  const ctx: TurnContext = { ...context, tools: { ...context.tools,
    connectors: () => [{ name: 'mcp__notes__search', server: 'notes', tool: 'search', kind: 'effect', description: 'Owned fake: the tool name is the one the scripted agent calls', inputSchema: { type: 'object' } }],
    callConnector: async () => ({ outcome: 'SENT', state: 'sent', detail: 'Sent to notes.' }),
    write: async () => { writes++; return { outcome: 'DONE', name: 'after', version: 1 }; },
  } };
  const outcome = await harness('mcp-connector-then-write').start(request(), ctx).outcome;
  assert.equal(outcome.status, 'done'); assert.equal(writes, 1);
});

test('a thrown connector call is UNKNOWN and stops ACP before any further tool or success', async () => {
  let calls = 0, writes = 0;
  const ctx: TurnContext = { ...context, tools: { ...context.tools,
    connectors: () => [{ name: 'mcp__notes__search', server: 'notes', tool: 'search', kind: 'read', description: 'Owned fake', inputSchema: { type: 'object' } }],
    callConnector: async () => { calls++; throw new Error('untrusted diagnostic sentinel'); },
    write: async () => { writes++; return { outcome: 'DONE', name: 'unexpected', version: 1 }; },
  } };
  const outcome = await harness('mcp-connector-then-write').start(request(), ctx).outcome;
  assert.equal(outcome.status, 'interrupted'); assert.match(outcome.error ?? '', /outcome is UNKNOWN.*must not be retried/);
  assert.doesNotMatch(JSON.stringify(outcome), /untrusted diagnostic sentinel/); assert.equal(calls, 1); assert.equal(writes, 0);
});

test('a signed connector server refusal is an error result and permits the turn to continue', async () => {
  let writes = 0;
  const ctx: TurnContext = { ...context, tools: { ...context.tools,
    connectors: () => [{ name: 'mcp__notes__search', server: 'notes', tool: 'search', kind: 'effect', description: 'Owned fake effect', inputSchema: { type: 'object' } }],
    callConnector: async () => ({ outcome: 'SENT', state: 'failed', detail: 'The server refused the call.' }),
    write: async () => { writes++; return { outcome: 'DONE', name: 'after', version: 1 }; },
  } };
  const outcome = await harness('mcp-connector-then-write').start(request(), ctx).outcome;
  assert.equal(outcome.status, 'done'); assert.equal(writes, 1);
  const [connector] = JSON.parse(outcome.answer); assert.equal(connector.isError, true);
  assert.deepEqual(JSON.parse(connector.content[0].text), { outcome: 'SENT', state: 'failed', detail: 'The server refused the call.' });
});

test('stop on a settled turn cannot cancel the next turn reusing the same thread session', { timeout: 5000 }, async () => {
  const h = harness('late-stop'), first = h.start(request(), context), firstOutcome = await first.outcome;
  assert.equal(firstOutcome.status, 'done');
  const next = h.start(request({ turnId: 'next', history: [{ role: 'user', text: 'Reply ready.' }, { role: 'assistant', text: firstOutcome.answer }] }), context);
  let entered!: () => void, settled = false;
  const running = new Promise<void>(resolve => { entered = resolve; });
  const stream = (async () => { for await (const event of next.events) if (event.type === 'text' && event.delta === 'rea') entered(); })();
  void next.outcome.then(() => { settled = true; });
  try {
    await running; first.stop();
    // Longer than the old turn's bounded Stop timer: neither cancel nor its deferred kill may affect this turn.
    await new Promise(resolve => setTimeout(resolve, 160));
    assert.equal(settled, false, 'a stale Stop must have no effect on the currently running turn');
    next.stop(); const outcome = await next.outcome; await stream;
    assert.equal(outcome.status, 'interrupted'); assert.equal(outcome.answer, 'rea:cancel-observed');
  } finally { next.stop(); await next.outcome; await stream; }
});

for (const reason of ['max_tokens', 'max_turn_requests'] as const) test(`ACP preserves ${reason} as an unfinished answer`, async () => {
  const outcome = await harness(`finish-${reason}`).start(request(), context).outcome;
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.finishReason, reason);
  assert.match(outcome.error!, /cut off.*context|cut off.*limit/);
});

test('ACP refuses a shared-project containment request before connecting to its agent',async()=>{
 const turn=harness('normal').start(request({nativeAccountTools:false}),context);
 const result=await turn.outcome;
 assert.equal(result.status,'failed');
 assert.equal(result.error,'This engine uses your own accounts and cannot run in a shared project. Choose another engine for this project.');
 assert.deepEqual(await collect(turn.events),[]);
});
