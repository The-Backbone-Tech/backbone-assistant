// harness-pi against the scripted model (an OpenAI-compatible server on the loopback): no network,
// no real key. The ToolHost here is a fake that records what the engine proposed. Canary
// credentials are random per run.
// Cites R-HARN-01, R-HARN-02, R-BASE-01, R-BASE-02, R-BASE-04, R-MODEL-02, R-GOV-SECRET-01.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import type { HarnessEvent, ModelRoute, ToolFile, ToolHost, TurnRequest, WriteOutcome } from '@backbone-next/platform/ports';
import { startScriptedModel, type ScriptedModel } from '@backbone-next/platform/testing';
import { createPiHarness } from '../src/index.ts';

const servers: ScriptedModel[] = [];
after(async () => {
  for (const s of servers) await s.close();
});

async function model(script?: Parameters<typeof startScriptedModel>[1]) {
  const s = await startScriptedModel('scripted-model', script);
  servers.push(s);
  return s;
}

const canary = () => `canary-${randomUUID()}`;
const routeTo = (s: ScriptedModel, credential: string | null = null): ModelRoute => ({ kind: 'endpoint', provider: 'openai-compatible', baseUrl: s.url, model: s.model, label: 'Scripted model', credential });

function fakeHost(files: (ToolFile & { text: string })[], onWrite?: (signal: AbortSignal) => Promise<WriteOutcome>) {
  const writes: { name: string; body: string }[] = [];
  const reads: string[] = [];
  const host: ToolHost = {
    list: async () => files.map(({ text: _t, ...f }) => f),
    read: async (name) => {
      reads.push(name);
      return files.find((f) => f.name === name) ?? null;
    },
    write: async (name, body, signal) => {
      writes.push({ name, body });
      return onWrite ? onWrite(signal) : { outcome: 'DONE', name, version: 1 };
    },
  };
  return { host, writes, reads };
}

const note = { name: 'note.md', version: 1, by: 'person' as const, class: 'original' as const, mediaType: 'text/markdown', text: '# Revenue\nUp 4%.' };
const request = (text: string, extra: Partial<TurnRequest> = {}): TurnRequest => ({ threadId: 't', turnId: 'u', text, history: [], attachments: [], effort: 3, resumed: false, ...extra });

async function drain(events: AsyncIterable<HarnessEvent>) {
  const all: HarnessEvent[] = [];
  for await (const e of events) all.push(e);
  return all;
}

test('R-BASE-01, R-HARN-02: Pi reads the attachments and proposes its one write to the ToolHost', async () => {
  const s = await model();
  const { host, writes, reads } = fakeHost([note]);
  const turn = createPiHarness().start(request('Write an editable brief from these', { attachments: ['note.md'] }), { tools: host, route: routeTo(s), credential: async () => '' });
  const [events, outcome] = await Promise.all([drain(turn.events), turn.outcome]);
  assert.equal(outcome.status, 'done');
  assert.deepEqual(reads, ['note.md']);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].name, 'brief.md');
  assert.match(writes[0].body, /note\.md: # Revenue Up 4%\./);
  assert.match(outcome.answer, /brief\.md v1/);
  assert.ok(events.some((e) => e.type === 'tool' && e.tool === 'write_file' && e.phase === 'done'));
  assert.ok(events.some((e) => e.type === 'text'));
  assert.ok(outcome.usage.input > 0);
});

test('history is read as the request is built: an answer withdrawn while the turn started is not sent', async () => {
  const s = await model();
  const { host } = fakeHost([note]);
  const stale = [{ role: 'user' as const, text: 'What does it say?' }, { role: 'assistant' as const, text: 'withdrawn-canary' }];
  let calls = 0;
  const turn = createPiHarness().start(request('Carry on', { history: stale, recall: () => (calls++, { history: stale.slice(0, 1) }) }), { tools: host, route: routeTo(s), credential: async () => '' });
  assert.equal((await turn.outcome).status, 'done');
  assert.equal(calls, 1, 'read once, as the request is built');
  assert.ok(s.requests.length > 0);
  assert.ok(s.requests.every((r) => !r.body.includes('withdrawn-canary')));
  assert.ok(s.requests[0].body.includes('What does it say?'), 'the rest of the history is sent');
});

test('history and the gate are read after the credential resolves, right before the request: a withdrawal meanwhile is not sent', async () => {
  const s = await model();
  const { host } = fakeHost([note]);
  const stale = [{ role: 'user' as const, text: 'What does it say?' }, { role: 'assistant' as const, text: 'withdrawn-canary' }];
  let withdrawn = false;
  // The source goes while the credential is being resolved.
  const credential = async () => { await new Promise((r) => setTimeout(r, 1)); withdrawn = true; return 'key'; };
  const turn = createPiHarness().start(request('Carry on', { history: stale, recall: () => ({ history: withdrawn ? stale.slice(0, 1) : stale }) }), { tools: host, route: routeTo(s, 'handle'), credential });
  assert.equal((await turn.outcome).status, 'done');
  assert.ok(s.requests.length > 0);
  assert.ok(s.requests.every((r) => !r.body.includes('withdrawn-canary')));
});

test('a request the send-time gate refuses is never sent: the turn ends interrupted with the reason', async () => {
  const s = await model();
  const { host } = fakeHost([note]);
  const reason = 'A source behind this request was withdrawn before it was sent; nothing was sent. Send it again.';
  let asked = 0;
  const outcome = await createPiHarness().start(request('Carry on', { stillAllowed: () => (asked++, reason) }), { tools: host, route: routeTo(s, 'handle'), credential: async () => 'key' }).outcome;
  assert.equal(s.requests.length, 0, 'nothing reached the model');
  assert.equal(asked, 1);
  assert.equal(outcome.status, 'interrupted');
  assert.equal(outcome.error, reason);
});

test('R-BASE-02: a question lists the files and reads the drafted one, naming its version and class', async () => {
  const s = await model();
  const brief = { name: 'brief.md', version: 2, by: 'person' as const, class: 'accepted' as const, mediaType: 'text/markdown', text: '# Brief\nWe ship on Friday.' };
  const { host, writes } = fakeHost([note, brief]);
  const turn = createPiHarness().start(request('What does the brief say now?'), { tools: host, route: routeTo(s), credential: async () => '' });
  const outcome = await turn.outcome;
  assert.equal(outcome.status, 'done');
  assert.equal(writes.length, 0);
  assert.match(outcome.answer, /brief\.md v2 \(recorded version\)/);
  assert.match(outcome.answer, /We ship on Friday/);
});

test('R-HARN-01: a tool the thread does not grant is refused by name, and nothing runs', async () => {
  let asked = false;
  const s = await model((messages) => {
    const tool = messages.findLast((m) => m.role === 'tool');
    if (!asked) {
      asked = true;
      return { calls: [{ name: 'bash', args: { command: 'rm -rf /' } }] };
    }
    return { text: `Told: ${typeof tool?.content === 'string' ? tool.content : ''}` };
  });
  const { host, writes } = fakeHost([note]);
  const turn = createPiHarness().start(request('Clean up'), { tools: host, route: routeTo(s), credential: async () => '' });
  const outcome = await turn.outcome;
  assert.equal(writes.length, 0);
  assert.match(outcome.answer, /bash/);
  assert.match(outcome.answer, /not (granted|found)/i);
});

test('R-BASE-04, J-01 A2: Stop during a write leaves it UNKNOWN; it is proposed once and not retried', async () => {
  const s = await model();
  let started!: () => void;
  const writing = new Promise<void>((r) => (started = r));
  const { host, writes } = fakeHost([], (signal) => {
    started();
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ outcome: 'UNKNOWN', detail: 'Stopped during the write of brief.md. Its outcome is UNKNOWN and it will not be resent.' }), { once: true }));
  });
  const turn = createPiHarness().start(request('Draft a brief'), { tools: host, route: routeTo(s), credential: async () => '' });
  await writing;
  turn.stop();
  const outcome = await turn.outcome;
  assert.equal(outcome.status, 'interrupted');
  assert.equal(writes.length, 1, 'never resent');
  const calls = s.requests.length;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(s.requests.length, calls, 'no further model call after Stop');
});

test('R-HARN-02: an UNKNOWN write ends the turn; the engine does not retry it', async () => {
  const s = await model();
  const { host, writes } = fakeHost([], async () => ({ outcome: 'UNKNOWN', detail: 'The outcome is UNKNOWN and it will not be resent.' }));
  const outcome = await createPiHarness().start(request('Draft a brief'), { tools: host, route: routeTo(s), credential: async () => '' }).outcome;
  assert.equal(writes.length, 1);
  assert.notEqual(outcome.status, 'failed');
});

test('R-GOV-SECRET-01, R-MODEL-02: the credential is resolved per request and reaches only the request header', async () => {
  const value = canary();
  const s = await model();
  const { host } = fakeHost([note]);
  const seen: string[] = [];
  const turn = createPiHarness().start(request('Write an editable brief from these', { attachments: ['note.md'] }), {
    tools: host,
    route: routeTo(s, 'handle-1'),
    credential: async (h) => (seen.push(h), value),
  });
  const [events, outcome] = await Promise.all([drain(turn.events), turn.outcome]);
  assert.ok(seen.length > 0 && seen.every((h) => h === 'handle-1'));
  assert.ok(s.requests.every((r) => r.headers.authorization === `Bearer ${value}`));
  assert.ok(s.requests.every((r) => !r.body.includes(value)), 'never in what the model is sent');
  assert.ok(!JSON.stringify({ events, outcome }).includes(value));
});

test('R-GOV-SECRET-01: a failed request is reported without the credential', async () => {
  const value = canary();
  const server = createServer((req, res) => res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: `bad key ${req.headers.authorization}` } })));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    const { host } = fakeHost([]);
    const route: ModelRoute = { kind: 'gateway', provider: 'vercel', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', label: 'Gateway', credential: 'h' };
    const outcome = await createPiHarness().start(request('Hello'), { tools: host, route, credential: async () => value }).outcome;
    assert.equal(outcome.status, 'failed');
    assert.ok(outcome.error);
    assert.ok(!JSON.stringify(outcome).includes(value));
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test('No ambient vendor settings: a key in the environment is never sent', async () => {
  const s = await model();
  const value = canary();
  const names = ['OPENAI_API_KEY', 'AI_GATEWAY_API_KEY', 'OPENROUTER_API_KEY'];
  for (const n of names) process.env[n] = value;
  try {
    const { host } = fakeHost([]);
    await createPiHarness().start(request('Hello there'), { tools: host, route: routeTo(s), credential: async () => '' }).outcome;
    assert.ok(s.requests.length > 0);
    assert.ok(s.requests.every((r) => !JSON.stringify(r).includes(value)));
  } finally {
    for (const n of names) delete process.env[n];
  }
});

test('R-GOV-SECRET-01: a credential a provider echoes back is scrubbed from streamed text, even split across deltas, and from writes', async () => {
  const value = canary();
  let calls = 0;
  const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      bodies.push(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (calls++ === 0) {
        const cut = Math.floor(value.length / 2);
        res.write(chunk({ role: 'assistant', content: `Your key is ${value.slice(0, cut)}` }));
        res.write(chunk({ content: `${value.slice(cut)}, saved.` }));
        res.write(chunk({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ name: `${value}.md`, content: `key ${value}` }) } }] }));
        res.write(chunk({}, 'tool_calls'));
      } else {
        res.write(chunk({ role: 'assistant', content: 'Done.' }));
        res.write(chunk({}, 'stop'));
      }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    const { host, writes } = fakeHost([]);
    const route: ModelRoute = { kind: 'gateway', provider: 'openrouter', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', label: 'Gateway', credential: 'h' };
    const turn = createPiHarness().start(request('Hello'), { tools: host, route, credential: async () => value });
    const [events, outcome] = await Promise.all([drain(turn.events), turn.outcome]);
    const text = events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('');
    assert.match(text, /Your key is \[credential\], saved\./, 'the streamed words arrive whole, the key replaced');
    assert.deepEqual(writes, [{ name: '[credential].md', body: 'key [credential]' }], 'no tool argument carries it');
    assert.equal(bodies.length, 2);
    assert.ok(!bodies[1].includes(value), 'the next request does not send it back');
    assert.ok(!JSON.stringify({ events, outcome, writes }).includes(value));
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test('start_child carries the child\'s own model, effort and fallback to the host, and only what was named', async () => {
  const s = await model((messages) => (messages.some((m) => m.role === 'tool')
    ? { text: 'Started.' }
    : { calls: [{ name: 'start_child', args: { brief: 'Check it', role: 'worker', model: 'small-model', effort: 2, fallback: ['other-model'] } }, { name: 'start_child', args: { brief: 'Plain', role: 'worker' } }] }));
  const asked: unknown[] = [];
  const { host } = fakeHost([]);
  host.startChild = async (r) => (asked.push(r), { outcome: 'STARTED', threadId: `c${asked.length}` });
  const outcome = await createPiHarness().start(request('Delegate'), { tools: host, route: routeTo(s), credential: async () => '' }).outcome;
  assert.equal(outcome.status, 'done');
  assert.deepEqual(asked, [{ brief: 'Check it', role: 'worker', model: 'small-model', effort: 2, fallback: ['other-model'] }, { brief: 'Plain', role: 'worker' }]);
  // The model is told it may name them, and none is required.
  const offered = (JSON.parse(s.requests[0].body) as { tools: { function: { name: string; parameters: { properties: Record<string, unknown>; required?: string[] } } }[] }).tools.find((t) => t.function.name === 'start_child')!.function.parameters;
  assert.ok(['model', 'effort', 'fallback'].every((k) => k in offered.properties && !offered.required?.includes(k)));
});

test('add_card carries a card to the host, is offered only where the host offers it, and says what was refused', async () => {
  const s = await model((messages) => (messages.some((m) => m.role === 'tool')
    ? { text: 'Planned.' }
    : { calls: [{ name: 'add_card', args: { brief: 'Draft it', title: 'Draft', effort: 2 } }, { name: 'add_card', args: { brief: 'Check it', dependsOn: ['k1'] } }] }));
  const asked: unknown[] = [];
  const { host } = fakeHost([]);
  host.addCard = async (r) => (asked.push(r), asked.length === 1 ? { outcome: 'ADDED', cardId: 'k1', status: 'ready' } : { outcome: 'REFUSED', reason: 'NOT_FOUND', detail: 'No such card.' });
  const outcome = await createPiHarness().start(request('Plan'), { tools: host, route: routeTo(s), credential: async () => '' }).outcome;
  assert.equal(outcome.status, 'done');
  assert.deepEqual(asked, [{ brief: 'Draft it', title: 'Draft', effort: 2 }, { brief: 'Check it', dependsOn: ['k1'] }]);
  const results = (JSON.parse(s.requests[1].body) as { messages: { role: string; content: unknown }[] }).messages.filter((m) => m.role === 'tool').map((m) => JSON.stringify(m.content));
  assert.match(results[0], /Added card k1 \(ready\)/);
  assert.match(results[1], /NOT_FOUND: No such card/);
  const names = (body: string) => (JSON.parse(body) as { tools?: { function: { name: string } }[] }).tools?.map((t) => t.function.name) ?? [];
  assert.ok(names(s.requests[0].body).includes('add_card'));
  // A ToolHost without it (a worker's, a reviewer's) offers no such tool.
  const bare = fakeHost([]).host;
  await createPiHarness().start(request('Plan'), { tools: bare, route: routeTo(s), credential: async () => '' }).outcome;
  assert.ok(!names(s.requests.at(-1)!.body).includes('add_card'));
});

test('R-GOV-SECRET-01, R-MODEL-02: what a route serves is read from its model list, with the credential only in the header', async () => {
  const value = canary();
  const s = await startScriptedModel('scripted-model', undefined, { served: ['scripted-model', 'small-model'] });
  servers.push(s);
  const listed = await createPiHarness().listModels!(routeTo(s, 'handle-1'), async (h) => (assert.equal(h, 'handle-1'), value));
  assert.deepEqual(listed.map((m) => m.id), ['scripted-model', 'small-model']);
  assert.deepEqual(s.requests.map((r) => [r.body, r.headers.authorization]), [['', `Bearer ${value}`]], 'one read, no model call');
  // A route that will not say is an error that names the route and never the key.
  const server = createServer((req, res) => res.writeHead(401).end(`bad key ${req.headers.authorization}`));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const route: ModelRoute = { kind: 'gateway', provider: 'vercel', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, model: 'm', label: 'Gateway', credential: 'h' };
    await assert.rejects(createPiHarness().listModels!(route, async () => value), (error: Error) => /Gateway answered 401/.test(error.message) && !error.message.includes(value));
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test('a bare turn (a judge\'s) is offered no tool at all, not even the reading ones', async () => {
  const s = await model(() => ({ text: '{"changes":[]}' }));
  const { host, reads } = fakeHost([note]);
  const turn = createPiHarness().start(request('Judge this.', { bare: true, readOnly: true, system: 'Answer with JSON.' }), { tools: host, route: routeTo(s), credential: async () => '' });
  const [, outcome] = await Promise.all([drain(turn.events), turn.outcome]);
  assert.equal(outcome.status, 'done');
  assert.equal(outcome.answer, '{"changes":[]}');
  const sent = s.requests.filter((r) => r.body.includes('Judge this.')).map((r) => JSON.parse(r.body) as { tools?: unknown[] });
  assert.ok(sent.length > 0);
  for (const body of sent) assert.ok(!body.tools || body.tools.length === 0, 'no tool offered');
  assert.deepEqual(reads, []);
});


test('N3 labels reflect source class without inventing authorship', async () => {
  let asked = false;
  const s = await model(() => {
    if (asked) return { text: 'Finished reading.' };
    asked = true;
    return { calls: [
      { name: 'list_files', args: {} },
      ...['person-original.md', 'agent-original.md', 'person-working.md', 'agent-working.md', 'accepted.md', 'agent-accepted.md'].map(name => ({ name: 'read_file', args: { name } })),
    ] };
  });
  const files = [
    { ...note, name: 'person-original.md' },
    { ...note, name: 'agent-original.md', by: 'agent' as const },
    { ...note, name: 'person-working.md', class: 'working' as const },
    { ...note, name: 'agent-working.md', class: 'working' as const, by: 'agent' as const },
    { ...note, name: 'accepted.md', class: 'accepted' as const },
    { ...note, name: 'agent-accepted.md', class: 'accepted' as const, by: 'agent' as const },
  ];
  const { host } = fakeHost(files);
  const outcome = await createPiHarness().start(request('Read the sources'), { tools: host, route: routeTo(s), credential: async () => '' }).outcome;
  assert.equal(outcome.status, 'done');
  const messages = s.requests.flatMap(r => (JSON.parse(r.body).messages ?? []) as {role: string; content: string}[]).filter(m => m.role === 'tool').map(m => String(m.content));
  const listing = messages.find(m => m.includes('person-original.md') && m.includes('agent-working.md'))!;
  assert.ok(listing);
  for (const [name, label] of [['person-original.md', 'original source'], ['agent-original.md', 'original source'], ['person-working.md', 'recorded version'], ['agent-working.md', 'recorded version'], ['accepted.md', 'recorded version'], ['agent-accepted.md', 'recorded version']]) {
    const marker = `${name} v1 (${label})`;
    assert.ok(listing.includes(marker), marker);
    assert.ok(messages.some(m => m.startsWith(marker + '\n\n')), `read: ${marker}`);
  }
  assert.ok(messages.every(m => !m.includes('saved by you') && !m.includes('written by the agent')));
});
