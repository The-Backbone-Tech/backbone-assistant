import { hangDetector } from '../../../scripts/lib/test-hang.ts';
// The api line: the named part of the `api` a host serves to another process of the person's user.
// Any such process can reach the socket, so the adverse cases are the point: every method off the
// list, a send nobody allowed, a No, a dialog nobody answers, a caller gone before the answer, a key
// on the wire, a line lost mid-call. A stand-in `call` records what reached the host.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {auditScratchParent} from '../src/audit-scratch.ts';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { METHODS, type Args, type Method, type Receipt } from '../src/api.ts';
import {auditTemporaryRoot} from '../src/composition/audit-temporary.ts';
import { askWords, serveApiLine, type LineAsk } from '../src/composition/api-line.ts';
import { API_LINE_ASKED, API_LINE_METHODS, apiSocket, attachApi, MAX_ASKED } from '../src/doors/api-line.ts';
import { doorSocket } from '../src/doors/protocol.ts';
import { pollUntil, freshHome, open, value  } from './helpers.ts';

const closers: (() => Promise<void> | void)[] = [];
const folders: string[] = [];
after(async () => {
  for (const c of closers) await c();
  for (const f of folders) rmSync(f, { recursive: true, force: true });
});
function home() {
  const h = mkdtempSync(join(tmpdir(), 'bb-line-'));
  folders.push(h);
  return h;
}

const settings = { permission: 'ask', model: 'm', effort: 3, runsOn: 'this-computer', mode: 'chat' } as const;
const send = (over: Record<string, unknown> = {}) => ({ projectId: 'p', text: 'hello', attachments: [], settings, clientKey: 'k', ...over }) as unknown as Args<'turns.send'>;

const GOAL = 'Ship the harbour report\nwith the tide tables';
/** A chat as the host holds it: its latest turn ran at effort 4, and it may be a child pinned to a model. */
const goalThread = (text: string | null = GOAL, over: Record<string, unknown> = {}) => ({ ok: true, value: { summary: { id: 't', projectId: 'p', title: 'Harbour' }, turns: [{ user: { text: 'Start', attachments: [], settings: { ...settings, effort: 4 }, at: 'a' } }], goal: { current: text === null ? null : { text, by: 'person', at: 'a' }, version: 2, proposals: [], history: [] }, ...over } });
const PARSED = { ok: true, value: { rule: { kind: 'rrule', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' }, summary: 'every day at 09:00', nextAt: '2026-11-05T09:00:00.000Z', anchor: '2026-11-04T20:00:00.000Z' } };
/** What the line reads of the host to resolve a write: its projects, a chat, and how it reads a time. */
const HOST_READS: Partial<Record<Method, unknown>> = { 'projects.list': [{ id: 'p', name: 'Harbour', kind: 'folder' }], 'threads.get': goalThread(), 'schedules.parse': PARSED };
/** The writes that reached the host, without the line's own reads. */
const writesIn = (calls: { method: Method; args: unknown }[]) => calls.filter((c) => !(c.method in HOST_READS));

test('goal guards unsupported by the line are refused rather than silently dropped', async () => {
  const { calls, call } = stand();
  const h = home();
  await serve(h, call, async () => true);
  const line = await attach(h);
  for (const guard of [{ tokenBudget: 100 }, { rubric: ['Has owners'] }]) {
    const result = await line.call('goals.run', { threadId: 't', budget: 5, ...guard });
    assert.equal(result.ok, false);
  }
  assert.deepEqual(calls, [], 'the guarded command never reaches the host without its guard');
});

test('the API line refuses wake-gate creation and never returns a gate program or arguments', async () => {
  const view = { schedules: [{ id: 's', wakeGate: { command: '/usr/bin/private-program', args: ['fake-canary-secret'] } }], heartbeat: null, runs: [], brief: {}, interruptions: {} };
  const { calls, call } = stand({ 'schedules.get': view });
  const h = home(); await serve(h, call, async () => true); const line = await attach(h);
  // JSON has no undefined value: test both representable mutations, including removal.
  for (const gate of [{ command: '/usr/bin/program', args: [] }, null]) {
    const result = await line.call('schedules.create', { projectId: 'p', text: 'Inspect', when: 'every hour', settings, clientKey: 'gate', wakeGate: gate } as never);
    assert.equal(result.ok, false);
  }
  const update = await line.call('schedules.update' as never, {} as never) as unknown as { ok: boolean };
  assert.equal(update.ok, false, 'updates remain outside this transport');
  assert.deepEqual(calls, [], 'there is no confirmation or Host call for a program from this transport');
  const result = await line.call('schedules.get', {});
  assert.equal(result.schedules[0].hasWakeGate, true);
  assert.ok(!JSON.stringify(result).includes('private-program') && !JSON.stringify(result).includes('fake-canary-secret'));
  assert.equal(view.schedules[0].wakeGate.args[0], 'fake-canary-secret');
});

/** A host stand-in: each method answers `answers[method]`, and every call that reached it is kept. */
function stand(answers: Partial<Record<Method, unknown>> = {}) {
  const calls: { method: Method; args: unknown }[] = [];
  const call = (async (method: Method, args: unknown) => {
    calls.push({ method, args });
    const answer = answers[method] ?? HOST_READS[method] ?? { ok: true, value: { threadId: 't', turnId: 'u' } };
    if (answer instanceof Error) throw answer;
    return answer;
  }) as never;
  return { calls, call };
}

async function serve(h: string, call: never, confirm?: (ask: LineAsk, signal: AbortSignal) => Promise<boolean>, confirmWaitMs?: number) {
  const line = await serveApiLine({ home: h, call, confirm, confirmWaitMs });
  closers.push(() => line.close());
  return line;
}
async function attach(h: string) {
  const line = await attachApi(h);
  assert.ok(line, 'attached');
  closers.push(() => line.close());
  return line;
}

/** Lines written raw, and what came back until `want` lines arrived or the host closed it. */
async function raw(h: string, lines: string[], want = lines.length): Promise<{ lines: string[]; closed: boolean; bytes: string }> {
  const socket = createConnection(apiSocket(h));
  let got = '';
  try {
    return await hangDetector(new Promise(resolve => {
      const done = (closed: boolean) => resolve({ lines: got.split('\n').filter(Boolean), closed, bytes: got });
      socket.on('connect', () => socket.write(lines.map(l => `${l}\n`).join('')));
      socket.on('data', d => { got += String(d); if (got.split('\n').filter(Boolean).length >= want) done(false); });
      socket.on('error', () => done(true));
      socket.on('close', () => done(true));
    }), 'raw API line replies or closes', { diagnostic: () => JSON.stringify({ want, received: got, destroyed: socket.destroyed }) });
  } finally { socket.destroy(); }
}

test('the line names its methods: the reads, the asked writes and stop, and nothing else', () => {
  assert.deepEqual([...API_LINE_METHODS].sort(), ['audit.export', 'changes.get', 'core.signatureStatus', 'files.list', 'goals.run', 'goals.runs', 'goals.set', 'material.read', 'memory.search', 'models.list', 'projects.list', 'queue.add', 'schedules.create', 'schedules.get', 'settings.model.get', 'settings.policy.get', 'solutions.options', 'solutions.run', 'solutions.verify', 'threads.get', 'threads.list', 'threads.search', 'turns.send', 'turns.stop', 'work.now']);
  assert.deepEqual([...API_LINE_ASKED].sort(), ['goals.run', 'goals.set', 'queue.add', 'schedules.create', 'solutions.run', 'turns.send']);
  for (const m of API_LINE_METHODS) assert.ok(METHODS.includes(m));
});

test('every other api method is refused and never reaches the host', async () => {
  const h = home();
  const { calls, call } = stand();
  await serve(h, call, async () => true);
  const off = METHODS.filter((m) => !(API_LINE_METHODS as readonly string[]).includes(m));
  const unknown = ['connectTool', 'signCapability', '__proto__', 'constructor'];
  const names = [...off, ...unknown];
  const { lines } = await raw(h, ['{"api":1}', ...names.map((method, i) => JSON.stringify({ id: i + 1, method, args: {} }))]);
  assert.equal(lines.length, names.length + 1);
  for (const line of lines.slice(1)) {
    const { result } = JSON.parse(line) as { result: { ok: boolean; outcome: string } };
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'REFUSED');
  }
  assert.deepEqual(calls, []);
});

test('the socket is the user\'s alone, beside the door\'s, and closing it leaves the door\'s', async () => {
  const h = home();
  assert.notEqual(apiSocket(h), doorSocket(h));
  assert.equal(dirname(apiSocket(h)), dirname(doorSocket(h)));
  const line = await serveApiLine({ home: h, call: stand().call });
  assert.equal(lstatSync(apiSocket(h)).mode & 0o777, 0o600);
  assert.equal(lstatSync(dirname(apiSocket(h))).mode & 0o777, 0o700);
  writeFileSync(doorSocket(h), 'stand-in for the door');
  await line.close();
  assert.equal(existsSync(apiSocket(h)), false);
  assert.equal(existsSync(doorSocket(h)), true);
});

test('a home path too long for a socket uses the door\'s fallback folder, and they agree', async () => {
  const deep = join(home(), 'x'.repeat(100));
  mkdirSync(deep);
  assert.equal(dirname(apiSocket(deep)), dirname(doorSocket(deep)));
  assert.ok(Buffer.byteLength(apiSocket(deep)) <= 103);
  assert.notEqual(apiSocket(deep), doorSocket(deep));
});

test('reads need no click; a send with no confirmer is refused and never reaches the host', async () => {
  const h = home();
  const { calls, call } = stand({ 'threads.list': [] });
  await serve(h, call);
  const line = await attach(h);
  assert.deepEqual(await line.call('threads.list', {}), []);
  assert.equal(line.send, 'closed');
  const r = await line.call('turns.send', send());
  assert.equal(r.ok, false);
  assert.deepEqual(calls.map((c) => c.method), ['threads.list']);
});

test('every send asks the person, one question at a time, and no click stands for the next', async () => {
  const h = home();
  const { calls, call } = stand();
  const asked: LineAsk[] = [];
  let showing = 0;
  let most = 0;
  await serve(h, call, async (ask) => {
    most = Math.max(most, ++showing);
    asked.push(ask);
    await new Promise((r) => setTimeout(r, 5));
    showing--;
    return true;
  });
  const line = await attach(h);
  assert.equal(line.send, 'ask');
  const [a, b] = await Promise.all([line.call('turns.send', send({ clientKey: 'a', text: 'first' })), line.call('turns.send', send({ clientKey: 'b', text: 'second' }))]);
  assert.ok(a.ok && b.ok);
  assert.deepEqual(asked.map((q) => (q as { text: string }).text).sort(), ['first', 'second']);
  assert.equal(most, 1);
  assert.equal(writesIn(calls).length, 2);
  assert.equal((await attach(h)).send, 'ask');
  await line.call('turns.send', send({ clientKey: 'c', settings: { ...settings, permission: 'full' } }));
  assert.equal((asked.at(-1) as { permission: string }).permission, 'full');
  assert.equal(writesIn(calls).length, 3);
});

test('a No closes sends for the life of the host, and the person is not asked again', async () => {
  const h = home();
  const { calls, call } = stand();
  let asked = 0;
  await serve(h, call, async () => (asked++, false));
  const line = await attach(h);
  const first = await line.call('turns.send', send());
  assert.equal(first.ok, false);
  if (!first.ok) assert.equal(first.outcome, 'REFUSED');
  assert.equal((await line.call('turns.send', send())).ok, false);
  assert.equal(asked, 1);
  assert.deepEqual(writesIn(calls), []);
  assert.equal((await attach(h)).send, 'closed');
});

test('stop needs no click: it only ends work', async () => {
  const h = home();
  const { calls, call } = stand({ 'turns.stop': { ok: true, value: { stopped: true } } });
  await serve(h, call);
  const line = await attach(h);
  assert.deepEqual(await line.call('turns.stop', { threadId: 't' }), { ok: true, value: { stopped: true } });
  assert.deepEqual(calls, [{ method: 'turns.stop', args: { threadId: 't' } }]);
});

test('what the person is asked about is the whole send: every field, and nothing the dialog could not show', async () => {
  const h = home();
  const { calls, call } = stand();
  const asked: LineAsk[] = [];
  await serve(h, call, async (ask) => (asked.push(ask), true));
  const line = await attach(h);
  const words = 'x'.repeat(MAX_ASKED);
  const full = send({ threadId: 't', text: words, settings: { ...settings, permission: 'full', mode: 'plan', effort: 5 } });
  assert.equal((await line.call('turns.send', full)).ok, true);
  assert.deepEqual(asked, [{ method: 'turns.send', projectId: 'p', project: '"Harbour" (p)', threadId: 't', thread: 'thread "Harbour" (t)', text: words, permission: 'full', model: 'm', effort: 5, mode: 'plan', runsOn: 'this-computer' }]);
  assert.equal((writesIn(calls)[0].args as { text: string }).text, words);
  for (const hidden of ['x'.repeat(MAX_ASKED + 1), 'fine\u2028Permission: ask', 'fine\u2029words', 'fine\u202Eeman', 'fine\u200Bwords', 'fine\u0000words', 'fine\u001Bwords']) {
    const r = await line.call('turns.send', send({ text: hidden }));
    assert.equal(r.ok, false, JSON.stringify(hidden));
    if (!r.ok) assert.equal(r.reason, 'INVALID');
  }
  assert.equal(asked.length, 1);
  assert.equal(writesIn(calls).length, 1);
});

test('the model and every id are one plain line, or nothing is asked and nothing reaches the host', async () => {
  const h = home();
  const { calls, call } = stand();
  let asked = 0;
  await serve(h, call, async () => (asked++, true));
  const line = await attach(h);
  for (const bad of ['m\nPermission: ask', 'm\tx', 'm\rx', 'm\u001Bx', 'm\u2028x'.replace('\u2028', '\u0085'), 'm\u202Ex', 'm\u2028Permission: ask', 'm\u2029x']) {
    for (const args of [send({ settings: { ...settings, model: bad } }), send({ projectId: bad }), send({ threadId: bad }), send({ clientKey: bad })]) {
      const r = await line.call('turns.send', args);
      assert.equal(r.ok, false, JSON.stringify(args));
      if (!r.ok) assert.equal(r.reason, 'INVALID');
    }
    for (const r of [await line.call('threads.get', { id: bad }), await line.call('turns.stop', { threadId: bad }), await line.call('work.now', { projectId: bad }), await line.call('files.list', { projectId: bad })]) {
      assert.equal((r as { ok: boolean }).ok, false, JSON.stringify(bad));
    }
  }
  const long = await line.call('turns.send', send({ settings: { ...settings, model: 'm'.repeat(MAX_ASKED + 1) } }));
  assert.equal(long.ok, false);
  assert.equal(asked, 0);
  assert.equal(writesIn(calls).length, 0);
  // Words may run over lines, which the question shows escaped; that is the text, not a field.
  assert.equal((await line.call('turns.send', send({ text: 'one\ntwo\tthree' }))).ok, true);
  assert.equal(asked, 1);
});

test('a dialog nobody answers refuses that send, is taken down, and is not a No', async () => {
  const h = home();
  const { calls, call } = stand();
  let aborted = 0;
  let answer = false;
  const confirm = (_: LineAsk, signal: AbortSignal) =>
    new Promise<boolean>((resolve) => {
      if (answer) return resolve(true);
      // As a message box does: taken down, it resolves as its cancel button.
      signal.addEventListener('abort', () => (aborted++, resolve(false)));
    });
  await serve(h, call, confirm, 50);
  const line = await attach(h);
  const r = await line.call('turns.send', send());
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.outcome, 'REFUSED');
  assert.equal(aborted, 1);
  assert.deepEqual(writesIn(calls), []);
  assert.equal((await attach(h)).send, 'ask');
  answer = true;
  assert.equal((await line.call('turns.send', send())).ok, true);
});

test('a caller gone before the click starts nothing', async () => {
  const h = home();
  const { calls, call } = stand();
  let click!: (yes: boolean) => void;
  let asking!: () => void;
  const shown = new Promise<void>((r) => (asking = r));
  await serve(h, call, () => (asking(), new Promise<boolean>((r) => (click = r))));
  const line = await attach(h);
  void line.call('turns.send', send()).catch(() => {});
  await shown;
  await line.close();
  await new Promise((r) => setTimeout(r, 50));
  click(true);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(writesIn(calls), []);
});

test('a send is checked before it is asked about, and only its named fields go on', async () => {
  const h = home();
  const { calls, call } = stand();
  let asked = 0;
  await serve(h, call, async () => (asked++, true));
  const line = await attach(h);
  const bad = [
    send({ attachments: ['m1'] }),
    send({ clientKey: '' }),
    send({ clientKey: undefined }),
    send({ text: 7 }),
    send({ projectId: undefined }),
    send({ threadId: 7 }),
    send({ settings: { ...settings, runsOn: 'cloud' } }),
    send({ settings: { ...settings, permission: 'root' } }),
    send({ settings: { ...settings, mode: 'other' } }),
    send({ settings: { ...settings, effort: 9 } }),
    send({ settings: null }),
  ];
  for (const args of bad) {
    const r = await line.call('turns.send', args);
    assert.equal(r.ok, false, JSON.stringify(args));
    if (!r.ok) assert.equal(r.reason, 'INVALID');
  }
  assert.equal(asked, 0);
  assert.equal(calls.length, 0);
  await line.call('turns.send', { ...send(), extra: 'dropped', settings: { ...settings, extra: 'dropped' } } as never);
  // A new chat continues no chosen route, and the host is told it was shown none.
  assert.deepEqual(writesIn(calls)[0].args, { threadId: undefined, ...send(), continues: null });
});

test('a read\'s arguments are checked, and only its named fields go on', async () => {
  const h = home();
  const { calls, call } = stand({ 'threads.get': { ok: true, value: {} }, 'threads.list': [] });
  await serve(h, call);
  const line = await attach(h);
  const r = await line.call('threads.get', { id: 7 } as never);
  assert.equal((r as { ok: boolean }).ok, false);
  await line.call('threads.get', { id: 't', extra: 1 } as never);
  await line.call('threads.list', { extra: 1 } as never);
  assert.deepEqual(calls.map((c) => c.args), [{ id: 't' }, {}]);
});

test('nothing secret crosses: the route shows no address, and a thrown error\'s words stay home', async () => {
  const h = home();
  const SECRET = 'sk-test-canary';
  const { call } = stand({
    'settings.model.get': { own: { provider: 'openai-compatible', model: 'm', keySet: true, baseUrl: `https://x.example/v1?key=${SECRET}` }, gateway: null, active: { kind: 'own', label: 'l' }, hint: null, harness: 'h', shared: { own: { provider: 'openai-compatible', model: 'shared', keySet: true, baseUrl: `https://shared.example/v1?key=${SECRET}` }, gateway: null, active: null, hint: null, harness: 'Pi' } },
    'threads.list': new Error(`postgres://backbone:${SECRET}@127.0.0.1/db refused`),
  });
  await serve(h, call);
  const { bytes } = await raw(h, ['{"api":1}', '{"id":1,"method":"settings.model.get","args":{}}', '{"id":2,"method":"threads.list","args":{}}']);
  assert.doesNotMatch(bytes, new RegExp(SECRET));
  assert.doesNotMatch(bytes, /baseUrl/);
  assert.match(bytes, /keySet/);
  const line = await attach(h);
  await assert.rejects(line.call('threads.list', {}), (e: Error) => !e.message.includes(SECRET));
});

test('on a real host with a key set, no read carries it, whatever the line is asked', async () => {
  const h = freshHome();
  const CANARY = 'sk-test-line-canary';
  const { host } = open(h);
  const put = await host.call('settings.model.put', { change: { route: 'own', provider: 'openai-compatible', model: 'm', key: CANARY, baseUrl: `https://x.example/v1?token=${CANARY}` } });
  assert.ok(put.ok, JSON.stringify(put));
  const project = await host.call('projects.create', { name: 'One', kind: 'folder' });
  assert.ok(project.ok);
  await serve(h, ((m: Method, a: never) => host.call(m, a)) as never);
  const reads = [['projects.list', {}], ['threads.list', {}], ['models.list', {}], ['settings.model.get', {}], ['work.now', { projectId: project.value.id }], ['files.list', { projectId: project.value.id }], ['settings.model.put', { change: {} }], ['terminal.run', { projectId: project.value.id, command: 'env' }]];
  const { bytes, lines } = await raw(h, ['{"api":1}', ...reads.map(([method, args], i) => JSON.stringify({ id: i + 1, method, args }))]);
  assert.equal(lines.length, reads.length + 1, bytes);
  assert.doesNotMatch(bytes, /canary/);
  assert.match(bytes, /keySet/);
});

test('a line lost mid-call rejects, and the call is not sent again', async () => {
  const h = home();
  let reached = 0;
  const hold = new Promise(() => {});
  const server = await serve(h, ((async () => (reached++, hold)) as never), async () => true);
  const line = await attach(h);
  const pending = line.call('turns.send', send());
  await pollUntil(async active => { while (active() && (!reached)) await new Promise((r) => setTimeout(r, 5)); }, "packages/platform/test/api-line.test.ts:358 polling state");
  await server.close();
  await assert.rejects(pending);
  assert.equal(reached, 1);
  await assert.rejects(line.call('threads.list', {}));
  assert.equal(reached, 1);
});

test('a line that does not start with hello, a bad version, a malformed or an oversized line is closed', async () => {
  const h = home();
  const { calls, call } = stand();
  await serve(h, call);
  for (const first of ['{"id":1,"method":"threads.list","args":{}}', '{"api":2}', 'not json', '[]', 'null']) {
    const r = await raw(h, [first], 2);
    assert.ok(r.closed, first);
    assert.doesNotMatch(r.bytes, /"ready"/, first);
  }
  const big = await raw(h, ['{"api":1}', `{"id":1,"method":"threads.list","args":{"a":"${'x'.repeat(1 << 21)}"}}`], 2);
  assert.ok(big.closed);
  assert.deepEqual(calls, []);
});

test('a call whose id is not a number ends the line and reaches nothing', async () => {
  const h = home();
  const { calls, call } = stand();
  await serve(h, call);
  const r = await raw(h, ['{"api":1}', '{"id":"1","method":"threads.list","args":{}}'], 2);
  assert.ok(r.closed);
  assert.deepEqual(calls, []);
});

test('with nothing serving, attaching says so: no socket, a dead one, or a folder not the user\'s alone', async () => {
  const h = home();
  assert.equal(await attachApi(h), null);
  const { call } = stand();
  mkdirSync(dirname(apiSocket(h)), { recursive: true, mode: 0o700 });
  // What a killed process leaves: a path that nothing answers on.
  writeFileSync(apiSocket(h), '');
  assert.equal(await attachApi(h), null);
  // Serving replaces a dead socket; a folder others may enter is then refused on both sides.
  const line = await serve(h, call);
  chmodSync(dirname(apiSocket(h)), 0o755);
  assert.equal(await attachApi(h), null);
  chmodSync(dirname(apiSocket(h)), 0o700);
  assert.ok(await attachApi(h));
  await line.close();
});

test('a second server on a live line is refused, and a served folder others may enter is not used', async () => {
  const h = home();
  await serve(h, stand().call);
  await assert.rejects(serveApiLine({ home: h, call: stand().call }), /already/);
  const other = home();
  mkdirSync(dirname(apiSocket(other)), { recursive: true, mode: 0o700 });
  // A link where the folder should be cannot be chmodded into being the user's own.
  rmSync(dirname(apiSocket(other)), { recursive: true });
  const elsewhere = home();
  (await import('node:fs')).symlinkSync(elsewhere, dirname(apiSocket(other)));
  await assert.rejects(serveApiLine({ home: other, call: stand().call }), /alone/);
});

test('a send too long for the line is refused here, before anything leaves', async () => {
  const h = home();
  const { calls, call } = stand();
  await serve(h, call, async () => true);
  const line = await attach(h);
  const r = await line.call('turns.send', send({ text: 'x'.repeat(1 << 21) }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.outcome, 'REFUSED');
  assert.deepEqual(calls, []);
  assert.deepEqual(await line.call('models.list', {}).then(() => 'still open'), 'still open');
});

test('the reads an MCP door uses need no click, and carry only their named fields; a search that is not one plain line reaches nothing', async () => {
  const h = home();
  const { calls, call } = stand({ 'threads.search': [], 'goals.runs': [], 'schedules.get': { schedules: [], heartbeat: null, runs: [] } });
  await serve(h, call);
  const line = await attach(h);
  assert.equal(line.send, 'closed');
  assert.deepEqual(await line.call('threads.search', { query: 'harbour plan', extra: 1 } as never), []);
  assert.deepEqual(await line.call('goals.runs', { extra: 1 } as never), []);
  assert.deepEqual(await line.call('schedules.get', { extra: 1 } as never), { schedules: [], heartbeat: null, runs: [] });
  for (const query of ['', 'two\nlines', 'hidden\u202Eword', 7, 'x'.repeat(MAX_ASKED + 1)]) {
    const r = await line.call('threads.search', { query } as never);
    assert.equal((r as unknown as { ok: boolean }).ok, false, JSON.stringify(query));
  }
  assert.deepEqual(calls.map((c) => [c.method, c.args]), [['threads.search', { query: 'harbour plan' }], ['goals.runs', {}], ['schedules.get', {}]]);
});

test('on a real host, the reads an MCP door uses answer from the home and change none of its files', async () => {
  const h = freshHome();
  const { host } = open(h);
  const project = await host.call('projects.create', { name: 'Harbour', kind: 'folder' });
  assert.ok(project.ok);
  const made = await host.call('schedules.create', { projectId: project.value.id, text: 'Check the tides', when: 'every day at 9:00', settings: { permission: 'ask', model: 'stub', effort: 3, runsOn: 'this-computer', mode: 'chat' }, clientKey: 'tides' });
  assert.ok(made.ok, JSON.stringify(made));
  await serve(h, ((m: Method, a: never) => host.call(m, a)) as never);
  const files = ['projects.json', 'proactivity.json', 'goal-runs.json', 'threads', 'memory'];
  const snapshot = () => files.map((f) => {
    const p = join(h, f);
    if (!existsSync(p)) return [f, null];
    const st = lstatSync(p);
    return st.isDirectory() ? [f, readdirSync(p, { recursive: true }).map(String).sort().map((n) => { const q = join(p, n); return lstatSync(q).isDirectory() ? n : `${n}:${readFileSync(q, 'utf8')}`; })] : [f, readFileSync(p, 'utf8')];
  });
  const before = snapshot();
  const line = await attach(h);
  const view = await line.call('schedules.get', {});
  assert.deepEqual(view.schedules.map((s) => s.text), ['Check the tides']);
  assert.deepEqual(await line.call('goals.runs', {}), []);
  assert.deepEqual(await line.call('threads.search', { query: 'tides' }), []);
  assert.deepEqual(snapshot(), before);
});

test('memory search over the line is a pure read: it finds a line the person wrote by hand and writes nothing', async () => {
  const h = freshHome();
  const { host } = open(h);
  value(await host.call('memory.put', { topic: 'travel', text: 'Prefers the harbour ferry over the bridge' }));
  const topic = join(h, 'memory', 'topics', 'travel.md');
  writeFileSync(topic, `${readFileSync(topic, 'utf8')}- Ferry tickets live in the blue folder\n`);
  await serve(h, ((m: Method, a: never) => host.call(m, a)) as never);
  const memory = () => readdirSync(join(h, 'memory'), { recursive: true }).map(String).sort().map((n) => { const q = join(h, 'memory', n); return lstatSync(q).isDirectory() ? n : `${n}:${readFileSync(q, 'utf8')}`; });
  const before = memory();
  const line = await attach(h);
  const found = await line.call('memory.search', { query: 'ferry' });
  assert.deepEqual(found.map((e) => e.text).sort(), ['Ferry tickets live in the blue folder', 'Prefers the harbour ferry over the bridge']);
  assert.deepEqual(memory(), before, 'not a byte of memory changed');
  line.close();
});

// ---- The asked writes beyond a send: queue.add, goals.set, goals.run, schedules.create ----------------

/** A valid call of each asked write beyond a send, as a command line makes it. */
const writes = {
  'queue.add': { threadId: 't', text: 'And then the tides', attachments: [], settings, clientKey: 'q1' },
  'goals.set': { threadId: 't', text: GOAL, baseVersion: 2 },
  'goals.run': { threadId: 't', budget: 7 },
  'schedules.create': { projectId: 'p', text: 'Check the tides', when: 'every day at 9:00', settings, clientKey: 's1' },
} as const;
type Write = keyof typeof writes;
const WRITES = Object.keys(writes) as Write[];
const answers = () => ({});
const reached = (calls: { method: Method; args: unknown }[], m: Method) => calls.filter((c) => c.method === m);

test('each asked write is refused on a host with no one to ask, and never reaches it', async () => {
  const h = home();
  const { calls, call } = stand(answers());
  await serve(h, call);
  const line = await attach(h);
  assert.equal(line.send, 'closed');
  for (const m of WRITES) {
    const r = (await line.call(m, writes[m] as never)) as { ok: boolean; outcome: string };
    assert.equal(r.ok, false, m);
    assert.equal(r.outcome, 'REFUSED', m);
  }
  assert.deepEqual(calls, []);
});

test('a headless, read-only host refuses all four, even with a confirmer, and asks nobody', async () => {
  const h = home();
  const { calls, call } = stand(answers());
  let asked = 0;
  const line = await serveApiLine({ home: h, call, confirm: async () => (asked++, true), readOnly: true });
  closers.push(() => line.close());
  const client = await attach(h);
  for (const m of [...WRITES, 'turns.send', 'turns.stop'] as const) {
    const r = (await client.call(m, (m === 'turns.send' ? send() : m === 'turns.stop' ? { threadId: 't' } : writes[m]) as never)) as { ok: boolean; detail: string };
    assert.equal(r.ok, false, m);
    assert.match(r.detail, /does not start or stop work/, m);
  }
  assert.equal(asked, 0);
  assert.deepEqual(calls, []);
});

test('each asked write works once the person allows it, and only its named fields go on', async () => {
  for (const m of WRITES) {
    const h = home();
    const { calls, call } = stand(answers());
    const asked: LineAsk[] = [];
    await serve(h, call, async (ask) => (asked.push(ask), true));
    const line = await attach(h);
    assert.equal(line.send, 'ask');
    const r = (await line.call(m, { ...writes[m], extra: 'dropped' } as never)) as { ok: boolean };
    assert.equal(r.ok, true, m);
    assert.equal(asked.length, 1, m);
    assert.equal(asked[0].method, m);
    const done = reached(calls, m);
    assert.equal(done.length, 1, m);
    const pinned = { rule: PARSED.value.rule, anchor: PARSED.value.anchor, firstAt: PARSED.value.nextAt };
    // A turn of the chat (a queued message, a goal run's turns) is pinned to the chosen route it was shown: here none.
    const want = m === 'schedules.create' ? { threadId: undefined, ...writes[m], pinned } : m === 'goals.run' ? { ...writes[m], settings: { ...settings, effort: 4 }, goal: GOAL, continues: null } : m === 'queue.add' ? { ...writes[m], continues: null } : writes[m];
    assert.deepEqual(done[0].args, want, m);
  }
});

test('a No to any asked write refuses it, reaches nothing, and closes the line\'s writes', async () => {
  for (const m of WRITES) {
    const h = home();
    const { calls, call } = stand(answers());
    let asked = 0;
    await serve(h, call, async () => (asked++, false));
    const line = await attach(h);
    const r = (await line.call(m, writes[m] as never)) as { ok: boolean; outcome: string };
    assert.equal(r.ok, false, m);
    assert.equal(r.outcome, 'REFUSED', m);
    assert.deepEqual(reached(calls, m), [], m);
    assert.equal((await line.call('turns.send', send())).ok, false);
    assert.equal(asked, 1, m);
    assert.deepEqual(reached(calls, 'turns.send'), []);
  }
});

test('what the person is asked is the whole write: the exact words, the thread or project, the budget and the recurrence', async () => {
  const h = home();
  const { call } = stand(answers());
  const asked: LineAsk[] = [];
  await serve(h, call, async (ask) => (asked.push(ask), true));
  const line = await attach(h);
  for (const m of WRITES) assert.equal(((await line.call(m, writes[m] as never)) as { ok: boolean }).ok, true, m);
  const runs = { permission: 'ask', model: 'm', effort: 3, mode: 'chat', runsOn: 'this-computer' };
  const thread = 'thread "Harbour" (t)';
  assert.deepEqual(asked, [
    { method: 'queue.add', threadId: 't', thread, text: 'And then the tides', ...runs },
    { method: 'goals.set', threadId: 't', thread, text: GOAL },
    { method: 'goals.run', threadId: 't', thread, budget: 7, goal: GOAL, ...runs, effort: 4 },
    { method: 'schedules.create', projectId: 'p', project: '"Harbour" (p)', thread: 'a chat of its own', text: 'Check the tides', when: 'every day at 9:00', summary: 'every day at 09:00', firstRun: '2026-11-05T09:00:00.000Z', ...runs },
  ]);
  const shown = asked.map((a) => askWords(a, 'Backbone'));
  for (const words of shown) {
    assert.match(words.detail, /running as you/);
    assert.match(words.detail, /Allow covers this one/);
  }
  assert.ok(shown[0].detail.includes(JSON.stringify('And then the tides')));
  assert.ok(shown[0].detail.includes('thread "Harbour" (t)'));
  assert.ok(shown[1].detail.includes(JSON.stringify(GOAL)), 'the goal, quoted whole, its line escaped');
  assert.ok(shown[2].detail.includes(JSON.stringify(GOAL)));
  assert.match(shown[2].detail, /up to 7 turns of work/);
  assert.match(shown[2].detail, /Model: m, effort 4/);
  assert.match(shown[2].message, /run this chat's goal/);
  assert.ok(shown[3].detail.includes(JSON.stringify('Check the tides')));
  assert.ok(shown[3].detail.includes(JSON.stringify('every day at 9:00')));
  assert.match(shown[3].detail, /every day at 09:00/);
  assert.match(shown[3].detail, /2026-11-05T09:00:00.000Z/);
  assert.match(shown[3].detail, /until you pause or delete it/);
  assert.ok(shown[3].detail.includes('"Harbour" (p)'));
  assert.match(askWords({ method: 'turns.send', projectId: 'p', project: '"Harbour" (p)', thread: 'a new thread', text: 'hi', permission: 'ask', model: 'm', effort: 3, mode: 'chat', runsOn: 'this-computer' }, 'Backbone').message, /start this turn/);
});

test('a schedule on a chat\'s goal shows that goal, and words the host cannot read as a time ask nothing', async () => {
  const h = home();
  const { calls, call } = stand({ ...answers(), 'schedules.parse': { ok: false, reason: 'INVALID', detail: 'Say when.', outcome: 'REFUSED' } });
  const asked: LineAsk[] = [];
  await serve(h, call, async (ask) => (asked.push(ask), true));
  const line = await attach(h);
  const r = await line.call('schedules.create', { ...writes['schedules.create'], when: 'whenever' } as never);
  assert.equal((r as { ok: boolean }).ok, false);
  assert.equal(asked.length, 0);
  assert.deepEqual(reached(calls, 'schedules.create'), []);
  const h2 = home();
  const second = stand(answers());
  await serve(h2, second.call, async (ask) => (asked.push(ask), true));
  const line2 = await attach(h2);
  assert.equal(((await line2.call('schedules.create', { ...writes['schedules.create'], threadId: 't', text: '' } as never)) as { ok: boolean }).ok, true);
  assert.equal((asked[0] as { goal?: string }).goal, GOAL);
  assert.match(askWords(asked[0], 'Backbone').detail, new RegExp(JSON.stringify(GOAL).replace(/[\\.*+?^${}()|[\]]/g, '\\$&')));
});

test('a goal run whose goal changed while the person was asked starts nothing; a chat with no goal asks nothing', async () => {
  const h = home();
  let goal: string | null = GOAL;
  const { calls, call } = stand();
  const wrapped = (async (m: Method, a: unknown) => (m === 'threads.get' ? (calls.push({ method: m, args: a }), goalThread(goal)) : (call as unknown as (m: Method, a: unknown) => Promise<unknown>)(m, a))) as never;
  let asked = 0;
  await serve(h, wrapped, async () => (asked++, (goal = 'Something else entirely'), true));
  const line = await attach(h);
  const r = await line.call('goals.run', writes['goals.run']);
  assert.equal((r as { ok: boolean }).ok, false);
  assert.equal(asked, 1);
  assert.deepEqual(reached(calls, 'goals.run'), []);
  goal = null;
  const none = await line.call('goals.run', writes['goals.run']);
  assert.equal((none as { ok: boolean }).ok, false);
  assert.equal(asked, 1);
  assert.deepEqual(reached(calls, 'goals.run'), []);
});

test('each asked write is checked before it is asked about: nothing hidden, no attachment, this computer, a budget the host takes', async () => {
  const h = home();
  const { calls, call } = stand(answers());
  let asked = 0;
  await serve(h, call, async () => (asked++, true));
  const line = await attach(h);
  const bad: [Write, Record<string, unknown>][] = [
    ['queue.add', { threadId: undefined }],
    ['queue.add', { attachments: ['m1'] }],
    ['queue.add', { text: 'x'.repeat(MAX_ASKED + 1) }],
    ['queue.add', { text: 'fine‮eman' }],
    ['queue.add', { settings: { ...settings, runsOn: 'cloud' } }],
    ['queue.add', { clientKey: '' }],
    ['goals.set', { text: 'fine Budget: 1' }],
    ['goals.set', { text: '' }],
    ['goals.set', { baseVersion: -1 }],
    ['goals.set', { baseVersion: '2' }],
    ['goals.set', { threadId: 't\nx' }],
    ['goals.run', { budget: 0 }],
    ['goals.run', { budget: 51 }],
    ['goals.run', { budget: 1.5 }],
    ['goals.run', { budget: '7' }],
    ['schedules.create', { when: 'every day\nat 9' }],
    ['schedules.create', { when: '' }],
    ['schedules.create', { text: 'fine\u0000words' }],
    ['schedules.create', { settings: { ...settings, permission: 'root' } }],
    ['schedules.create', { projectId: undefined }],
    ['schedules.create', { threadId: 7 }],
  ];
  for (const [m, over] of bad) {
    const r = (await line.call(m, { ...writes[m], ...over } as never)) as { ok: boolean; reason: string };
    assert.equal(r.ok, false, `${m} ${JSON.stringify(over)}`);
    assert.equal(r.reason, 'INVALID', `${m} ${JSON.stringify(over)}`);
  }
  assert.equal(asked, 0);
  assert.deepEqual(calls, []);
});

test('what only the person may do in the app is refused on the line, even with someone ready to click', async () => {
  const h = home();
  const { calls, call } = stand(answers());
  let asked = 0;
  await serve(h, call, async () => (asked++, true));
  // Releasing a held connector call, opening an egress door, signing a capability, connecting a tool,
  // picking an export folder and deciding a held write: the app's main-process channels by name, and
  // every api method behind them, plus the other changes the line does not carry.
  const personOnly = [
    'connector-release', 'connector-open', 'connector-read', 'triage-sign', 'tools-connect', 'choose-export-folder', 'document-export',
    'connectTool', 'signCapability', 'releaseConnectorCall', 'openEgress',
    'connectors.decide', 'connectors.set', 'connectors.refresh', 'triage.connect', 'triage.decide', 'triage.undo', 'triage.run',
    'tools.disconnect', 'backup.export', 'settings.model.put', 'terminal.run', 'terminal.start', 'terminal.list', 'terminal.stop', 'terminal.clear', 'memory.proposal.decide', 'skills.decide', 'goals.decide',
    'goals.clear', 'goals.resume', 'queue.send', 'queue.edit', 'turns.steer', 'schedules.run', 'schedules.update', 'schedules.delete',
    'heartbeat.put', 'triggers.create', 'children.start', 'projects.create', 'threads.update', 'threads.delete', 'material.attach', 'memory.put',
  ];
  for (const method of ['terminal.run', 'terminal.start', 'terminal.list', 'terminal.stop', 'terminal.clear'] as const) assert.ok(METHODS.includes(method), `${method} is a registered method, not a misspelling`);
  for (const m of personOnly) assert.ok(!(API_LINE_METHODS as readonly string[]).includes(m), m);
  const { lines } = await raw(h, ['{"api":1}', ...personOnly.map((method, i) => JSON.stringify({ id: i + 1, method, args: { threadId: 't', effect: 'e', tool: 'codex', to: '/tmp/x', change: {} } }))]);
  assert.equal(lines.length, personOnly.length + 1);
  for (const line of lines.slice(1)) {
    const { result } = JSON.parse(line) as { result: { ok: boolean; outcome: string; reason: string } };
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'REFUSED');
    assert.equal(result.reason, 'NOT_AVAILABLE');
  }
  assert.equal(asked, 0);
  assert.deepEqual(calls, []);
});

test('on a real host, a queued message, a goal set and run, and a schedule land once the person allows each', async () => {
  const h = freshHome();
  const { host } = open(h);
  const project = value(await host.call('projects.create', { name: 'Harbour', kind: 'folder' }));
  const real = { ...settings, model: 'stub' };
  const first = value(await host.call('turns.send', { projectId: project.id, text: 'Start', attachments: [], settings: real, clientKey: 'start' }));
  await pollUntil(async active => { for (let i = 0; (active() && (value(await host.call('threads.get', { id: first.threadId })).summary.running)); i++) await new Promise((r) => setTimeout(r, 25)); }, "packages/platform/test/api-line.test.ts:717 polling state");
  const asked: LineAsk[] = [];
  await serve(h, ((m: Method, a: never) => host.call(m, a)) as never, async (ask) => (asked.push(ask), true));
  const line = await attach(h);
  const goalText = 'Write the harbour brief';
  const set = await line.call('goals.set', { threadId: first.threadId, text: goalText, baseVersion: 0 });
  assert.ok(set.ok, JSON.stringify(set));
  const made = await line.call('schedules.create', { projectId: project.id, threadId: first.threadId, text: 'Check the tides', when: 'every day at 9:00', settings: real, clientKey: 'tides' });
  assert.ok(made.ok, JSON.stringify(made));
  assert.deepEqual((await line.call('schedules.get', {})).schedules.map((s) => s.text), ['Check the tides']);
  const queued = await line.call('queue.add', { threadId: first.threadId, text: 'And the tides', attachments: [], settings: real, clientKey: 'q' });
  assert.ok(queued.ok, JSON.stringify(queued));
  const ran = await line.call('goals.run', { threadId: first.threadId, budget: 2 });
  assert.ok(ran.ok, JSON.stringify(ran));
  assert.deepEqual(asked.map((a) => a.method), ['goals.set', 'schedules.create', 'queue.add', 'goals.run']);
  assert.equal((asked[1] as { summary: string }).summary.length > 0, true);
  assert.equal((asked[3] as { goal: string }).goal, goalText);
  await host.call('goals.pause', { threadId: first.threadId });
  await host.call('turns.stop', { threadId: first.threadId });
  line.close();
});

// ---- What was shown at the click is exactly what runs, pinned (the review of 0a8e221, scenarios 1 to 7) ----

/** A stand-in whose answers can change while a question is up: `now()` is read on every call. */
function live(now: () => Partial<Record<Method, unknown>>) {
  const calls: { method: Method; args: unknown }[] = [];
  const call = (async (method: Method, args: unknown) => {
    calls.push({ method, args });
    return now()[method] ?? HOST_READS[method] ?? { ok: true, value: { threadId: 't', turnId: 'u' } };
  }) as never;
  return { calls, call };
}
const MOVED = /What you were shown changed before it could run/;

test('1: a schedule whose words are only spaces is a goal schedule: the question shows the goal, and the goal it showed is pinned', async () => {
  const h = home();
  const { calls, call } = stand();
  const asked: LineAsk[] = [];
  await serve(h, call, async (ask) => (asked.push(ask), true));
  const line = await attach(h);
  const r = await line.call('schedules.create', { ...writes['schedules.create'], threadId: 't', text: '   ', when: 'every minute' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const ask = asked[0] as Extract<LineAsk, { method: 'schedules.create' }>;
  assert.equal(ask.text, '');
  assert.equal(ask.goal, GOAL);
  const words = askWords(ask, 'Backbone').detail;
  assert.match(words, /Each run works toward the chat's goal, in full/);
  assert.doesNotMatch(words, /Each run says, in full: " +"/);
  const made = writesIn(calls)[0].args as Args<'schedules.create'>;
  assert.equal(made.text, '');
  assert.equal(made.pinned?.goal, GOAL);
});

test('2: a goal schedule whose goal changes behind another question is refused; on a real host a later goal change pauses it and says so', async () => {
  const h = home();
  let goal = GOAL;
  const { calls, call } = live(() => ({ 'threads.get': goalThread(goal) }));
  // The schedule's question is shown; meanwhile the goal moves, as an approved goals.set ahead of it would.
  await serve(h, call, async () => ((goal = 'Something else entirely'), true));
  const line = await attach(h);
  const r = await line.call('schedules.create', { ...writes['schedules.create'], threadId: 't', text: '' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.detail, MOVED);
  assert.deepEqual(writesIn(calls), []);

  const real = freshHome();
  const { host } = open(real);
  const project = value(await host.call('projects.create', { name: 'Harbour', kind: 'folder' }));
  const first = value(await host.call('turns.send', { projectId: project.id, text: 'Start', attachments: [], settings: { ...settings, model: 'stub' }, clientKey: 'start' }));
  await pollUntil(async active => { while (active() && (value(await host.call('threads.get', { id: first.threadId })).summary.running)) await new Promise((r) => setTimeout(r, 25)); }, "packages/platform/test/api-line.test.ts:787 polling state");
  value(await host.call('goals.set', { threadId: first.threadId, text: 'Write the brief', baseVersion: 0 }));
  await serve(real, ((m: Method, a: never) => host.call(m, a)) as never, async () => true);
  const client = await attach(real);
  const made = await client.call('schedules.create', { projectId: project.id, threadId: first.threadId, text: '', when: 'every day at 9:00', settings: { ...settings, model: 'stub' }, clientKey: 'goal-schedule' });
  assert.ok(made.ok, JSON.stringify(made));
  assert.equal(made.value.goal, 'Write the brief');
  const version = value(await host.call('threads.get', { id: first.threadId })).goal!.version;
  value(await host.call('goals.set', { threadId: first.threadId, text: 'Write a different brief', baseVersion: version }));
  await host.call('schedules.run', { id: made.value.id, clientKey: 'now' });
  const after = (await host.call('schedules.get', {})).schedules.find((s) => s.id === made.value.id)!;
  assert.equal(after.paused, true);
  assert.match(after.pausedBecause ?? '', /goal changed since this schedule was allowed/);
  assert.equal(after.goal, 'Write the brief');
  client.close();
});

test('3: a goal run shows the settings it will run with, pins them, and is refused if they moved before the click; the host runs every turn so', async () => {
  const h = home();
  let effort = 4;
  const { calls, call } = live(() => ({ 'threads.get': { ok: true, value: { ...goalThread().value, turns: [{ user: { text: 'x', attachments: [], settings: { ...settings, model: 'pricey', permission: 'full', effort }, at: 'a' } }] } } }));
  const asked: LineAsk[] = [];
  await serve(h, call, async (ask) => (asked.push(ask), true));
  const line = await attach(h);
  assert.equal((await line.call('goals.run', writes['goals.run'])).ok, true);
  const ask = asked[0] as Extract<LineAsk, { method: 'goals.run' }>;
  assert.deepEqual([ask.model, ask.permission, ask.effort, ask.mode, ask.runsOn], ['pricey', 'full', 4, 'chat', 'this-computer']);
  assert.match(askWords(ask, 'Backbone').detail, /Model: pricey, effort 4\nPermission: full, mode chat, on this computer/);
  assert.deepEqual((writesIn(calls)[0].args as Args<'goals.run'>).settings, { ...settings, model: 'pricey', permission: 'full', effort: 4 });
  // A turn in between changes the chat's latest settings while the question is up: nothing runs.
  const h2 = home();
  const second = live(() => ({ 'threads.get': { ok: true, value: { ...goalThread().value, turns: [{ user: { text: 'x', attachments: [], settings: { ...settings, effort }, at: 'a' } }] } } }));
  await serve(h2, second.call, async () => ((effort = 5), true));
  const r = await (await attach(h2)).call('goals.run', writes['goals.run']);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.detail, MOVED);
  assert.deepEqual(writesIn(second.calls), []);

  const real = freshHome();
  const { host } = open(real);
  const project = value(await host.call('projects.create', { name: 'Harbour', kind: 'folder' }));
  const first = value(await host.call('turns.send', { projectId: project.id, text: 'Start', attachments: [], settings: { ...settings, model: 'stub', effort: 2 }, clientKey: 'start' }));
  await pollUntil(async active => { while (active() && (value(await host.call('threads.get', { id: first.threadId })).summary.running)) await new Promise((r) => setTimeout(r, 25)); }, "packages/platform/test/api-line.test.ts:829 polling state");
  value(await host.call('goals.set', { threadId: first.threadId, text: 'Write the brief', baseVersion: 0 }));
  const pinned = { ...settings, model: 'stub', effort: 5 } as const;
  const run = await host.call('goals.run', { threadId: first.threadId, budget: 2, settings: pinned, goal: 'Write the brief' });
  assert.ok(run.ok, JSON.stringify(run));
  assert.deepEqual(run.value.settings, pinned);
  const turns = value(await host.call('threads.get', { id: first.threadId })).turns;
  assert.deepEqual(turns.at(-1)!.user.settings, pinned, 'the run\'s first turn ran on the pinned settings, not the chat\'s latest');
  assert.equal((await host.call('goals.run', { threadId: first.threadId, budget: 2, goal: 'Another goal' })).ok, false);
  await host.call('goals.pause', { threadId: first.threadId });
  await host.call('turns.stop', { threadId: first.threadId });
});

test('4: on a child, the question shows the model it is pinned to, that model runs, and a pin that moves before the click runs nothing', async () => {
  let pin = 'pricey';
  const child = () => ({ 'threads.get': goalThread(GOAL, { child: { parentThreadId: 'parent', role: 'worker', startedBy: 'person', settings: { ...settings, model: pin } } }) });
  for (const m of ['queue.add', 'schedules.create'] as const) {
    const h = home();
    const { calls, call } = live(child);
    const asked: LineAsk[] = [];
    await serve(h, call, async (ask) => (asked.push(ask), true));
    const line = await attach(h);
    const args = m === 'queue.add' ? writes['queue.add'] : { ...writes['schedules.create'], threadId: 't' };
    assert.equal(((await line.call(m, args as never)) as { ok: boolean }).ok, true, m);
    assert.equal((asked[0] as { model: string }).model, 'pricey', m);
    assert.match(askWords(asked[0], 'Backbone').detail, /Model: pricey/, m);
    assert.equal((writesIn(calls)[0].args as { settings: { model: string } }).settings.model, 'pricey', m);
  }
  const h = home();
  const { calls, call } = live(child);
  await serve(h, call, async () => ((pin = 'dearer'), true));
  const r = await (await attach(h)).call('queue.add', writes['queue.add'] as never) as Receipt<unknown>;
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.detail, MOVED);
  assert.deepEqual(writesIn(calls), []);
});

test('5: a goal run\'s question says each turn of work may be followed by a check, so a budget of N is up to 2N model turns', () => {
  const words = askWords({ method: 'goals.run', threadId: 't', thread: 'thread "Harbour" (t)', budget: 7, goal: GOAL, ...settings }, 'Backbone').detail;
  assert.match(words, /each followed by a check turn on the same route: up to 14 model turns in all/);
  assert.match(words, /Budget: up to 7 turns of work and 7 checks \(14 model turns\)/);
});

test('6: a schedule runs on the rule and anchor it was shown, not `when` read again; a first run that moved is refused; a bare daily rule shows the time it runs', async () => {
  const h = home();
  let parsed = PARSED;
  const { calls, call } = live(() => ({ 'schedules.parse': parsed }));
  const asked: LineAsk[] = [];
  await serve(h, call, async (ask) => (asked.push(ask), true));
  const line = await attach(h);
  assert.equal((await line.call('schedules.create', writes['schedules.create'])).ok, true);
  const made = writesIn(calls)[0].args as Args<'schedules.create'>;
  assert.deepEqual(made.pinned, { rule: PARSED.value.rule, anchor: PARSED.value.anchor, firstAt: PARSED.value.nextAt });
  assert.equal((asked[0] as { firstRun: string }).firstRun, PARSED.value.nextAt);
  // "tomorrow at 9" read before midnight and again after it is another day: nothing is scheduled.
  const h2 = home();
  const second = live(() => ({ 'schedules.parse': parsed }));
  await serve(h2, second.call, async () => ((parsed = { ok: true, value: { ...PARSED.value, rule: { kind: 'once', at: '2026-11-06T09:00:00.000Z' } as never } }), true));
  const r = await (await attach(h2)).call('schedules.create', writes['schedules.create']);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.detail, MOVED);
  assert.deepEqual(writesIn(second.calls), []);

  const { describeRule } = await import('../src/schedules/rules.ts');
  const anchor = new Date(2026, 10, 4, 14, 37).getTime();
  assert.equal(describeRule({ kind: 'rrule', rrule: 'FREQ=DAILY' }, anchor), 'Every day at 14:37');
  const real = freshHome();
  const { host } = open(real);
  const project = value(await host.call('projects.create', { name: 'Harbour', kind: 'folder' }));
  const base = { projectId: project.id, text: 'Check the tides', when: 'daily', settings: { ...settings, model: 'stub' } } as const;
  const pinnedAt = new Date(Date.now() - 3_600_000);
  pinnedAt.setSeconds(0, 0);
  const next = new Date(pinnedAt.getTime() + 86_400_000).toISOString();
  const kept = await host.call('schedules.create', { ...base, clientKey: 'pinned', pinned: { rule: { kind: 'rrule', rrule: 'FREQ=DAILY' }, anchor: pinnedAt.toISOString(), firstAt: next } });
  assert.ok(kept.ok, JSON.stringify(kept));
  assert.equal(kept.value.nextAt, next, 'it runs at the anchor\'s time of day, as shown');
  assert.equal(kept.value.anchor, pinnedAt.toISOString());
  const moved = await host.call('schedules.create', { ...base, clientKey: 'moved', pinned: { rule: { kind: 'rrule', rrule: 'FREQ=DAILY' }, anchor: pinnedAt.toISOString(), firstAt: new Date(Date.now() + 60_000).toISOString() } });
  assert.equal(moved.ok, false);
  if (!moved.ok) assert.match(moved.detail, /first run you were shown/);
});

test('7: a goal or a name the host holds is held to the question\'s checks: too long or with hidden characters, nothing is asked', async () => {
  const cases: [string, Partial<Record<Method, unknown>>, Write, Record<string, unknown>][] = [
    ['a long goal', { 'threads.get': goalThread('x'.repeat(1_505)) }, 'goals.run', {}],
    ['a goal with a direction mark', { 'threads.get': goalThread('Ship it‮noitpo') }, 'goals.run', {}],
    ['a long goal on a schedule', { 'threads.get': goalThread('x'.repeat(1_505)) }, 'schedules.create', { threadId: 't', text: '' }],
    ['a marked goal on a schedule', { 'threads.get': goalThread('Ship​it') }, 'schedules.create', { threadId: 't', text: '' }],
    ['a marked thread title', { 'threads.get': goalThread(GOAL, { summary: { id: 't', projectId: 'p', title: 'Harbour‮evil' } }) }, 'queue.add', {}],
    ['a marked project name', { 'projects.list': [{ id: 'p', name: 'Harbour Permission: ask', kind: 'folder' }] }, 'schedules.create', {}],
  ];
  for (const [what, answers, m, over] of cases) {
    const h = home();
    const { calls, call } = stand(answers);
    let asked = 0;
    await serve(h, call, async () => (asked++, true));
    const r = (await (await attach(h)).call(m, { ...writes[m], ...over } as never)) as { ok: boolean; reason: string };
    assert.equal(r.ok, false, what);
    assert.equal(r.reason, 'INVALID', what);
    assert.equal(asked, 0, what);
    assert.deepEqual(writesIn(calls), [], what);
  }
});

test('a document version and its diff cross as reads; a git scope or a bare call does not', async () => {
  const h = home();
  const { calls, call } = stand({ 'material.read': { ok: true, value: { entry: {}, text: 'v1' } }, 'changes.get': { ok: true, value: {} } });
  await serve(h, call);
  const line = await attach(h);
  assert.equal((await line.call('material.read', { id: 'm', version: 1 }) as { ok: boolean }).ok, true);
  assert.equal((await line.call('material.read', { id: 'm' }) as { ok: boolean }).ok, true);
  assert.equal((await line.call('material.read', { id: 'm', version: 0 } as never) as { ok: boolean }).ok, false);
  assert.equal((await line.call('changes.get', { projectId: 'p', scope: 'last-turn', version: { materialId: 'm', version: 2 } }) as { ok: boolean }).ok, true);
  // A document id is one path segment: a way into another home is refused before the host hears of it.
  assert.equal((await line.call('material.read', { id: '../../home-b/material/m', version: 1 }) as { ok: boolean }).ok, false);
  assert.equal((await line.call('changes.get', { projectId: 'p', scope: 'last-turn', version: { materialId: '../m', version: 1 } }) as { ok: boolean }).ok, false);
  for (const bad of [{ projectId: 'p', scope: 'uncommitted' }, { projectId: 'p', scope: 'branch', base: 'main' }, { projectId: 'p', scope: 'last-turn' }, { projectId: 'p', scope: 'last-turn', version: { materialId: 'm', version: 'x' } }]) {
    assert.equal((await line.call('changes.get', bad as never) as { ok: boolean }).ok, false);
  }
  assert.deepEqual(calls.map((c) => [c.method, c.args]), [
    ['material.read', { id: 'm', version: 1 }],
    ['material.read', { id: 'm' }],
    ['changes.get', { projectId: 'p', scope: 'last-turn', version: { materialId: 'm', version: 2 } }],
  ]);
});

// ---- A chat whose task was chosen a route (solution selection) ---------------------------------------

/** A chat whose latest selected turn chose `pinned` for a task that may not reach the network. */
const selectedThread = (pinned: { kind: string; provider: string; baseUrl: string; model: string; label: string }, over: Record<string, unknown> = {}) => {
  const chat = goalThread();
  const task = { needs: ['model'], network: false, spend: 'none' };
  // The chosen turn's options and receipt are its own: what the line shows and pins is only its task and route.
  chat.value.turns.push({ user: { text: 'Chosen', attachments: [], settings, at: 'b' }, selection: { task, routeId: 'local:ollama:qwen', reasons: ['stays here'], pinned, ran: pinned, options: { choice: null } } } as never);
  return { ...chat, value: { ...chat.value, ...over } };
};
const QWEN = { kind: 'endpoint', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen', label: 'Ollama · qwen · on this computer, no charge' };

test('a selected chat\'s route is shown with its limits and model as it will run, and pinned on the write', async () => {
  for (const m of ['turns.send', 'queue.add', 'goals.run'] as const) {
    const h = home();
    const { calls, call } = stand({ 'threads.get': selectedThread(QWEN) });
    const asked: LineAsk[] = [];
    await serve(h, call, async (ask) => (asked.push(ask), true));
    const line = await attach(h);
    const r = (await line.call(m, (m === 'turns.send' ? send({ threadId: 't' }) : writes[m]) as never)) as { ok: boolean };
    assert.equal(r.ok, true, m);
    // The model shown is the route's, not the settings' "m": that is where the turn goes.
    assert.equal((asked[0] as { model: string }).model, 'qwen', m);
    const words = askWords(asked[0], 'Backbone').detail;
    assert.match(words, /Route: Ollama · qwen · on this computer, no charge, chosen for this chat's task, which may not reach the network, may spend nothing/, m);
    assert.match(words, /Model: qwen/, m);
    const done = reached(calls, m)[0].args as { continues: unknown };
    assert.deepEqual(done.continues, { task: { needs: ['model'], network: false, spend: 'none' }, routeId: 'local:ollama:qwen', pinned: QWEN }, m);
  }
});

test('a chosen route that moves while the question is up runs nothing; a native model named explicitly is kept, shown and pinned', async () => {
  const h = home();
  let reads = 0;
  const OTHER = { ...QWEN, model: 'llama', label: 'Ollama · llama · on this computer, no charge' };
  const calls: { method: Method; args: unknown }[] = [];
  // The first read is what the person is shown; by the recheck after the click the chat chose another route.
  const call = (async (method: Method, args: unknown) => {
    calls.push({ method, args });
    if (method === 'threads.get') return selectedThread(reads++ === 0 ? QWEN : OTHER);
    return HOST_READS[method] ?? { ok: true, value: { threadId: 't', turnId: 'u' } };
  }) as never;
  await serve(h, call, async () => true);
  const line = await attach(h);
  const moved = await line.call('turns.send', send({ threadId: 't' }));
  assert.equal(moved.ok, false);
  if (!moved.ok) assert.match(moved.detail, /changed before it could run/);
  assert.deepEqual(writesIn(calls), [], 'nothing reached the host');

  // On a native engine the turn's model is the person's: the chosen engine runs it, and that is what is shown.
  const h2 = home();
  const CODEX = { kind: 'native', provider: 'codex', baseUrl: '', model: 'gpt-a', label: 'Codex · gpt-a' };
  const native = selectedThread(CODEX);
  (native.value.turns.at(-1) as unknown as { selection: { task: unknown; routeId: string } }).selection.task = { needs: ['model'], network: true, spend: 'plan' };
  (native.value.turns.at(-1) as unknown as { selection: { task: unknown; routeId: string } }).selection.routeId = 'native:codex';
  const s2 = stand({ 'threads.get': native });
  const asked: LineAsk[] = [];
  await serve(h2, s2.call, async (ask) => (asked.push(ask), true));
  const line2 = await attach(h2);
  assert.equal((await line2.call('turns.send', send({ threadId: 't', settings: { ...settings, model: 'gpt-b' } }))).ok, true);
  assert.equal((asked[0] as { model: string }).model, 'gpt-b');
  assert.match(askWords(asked[0], 'Backbone').detail, /Route: Codex · gpt-b, chosen for this chat's task/);
  assert.equal((reached(s2.calls, 'turns.send')[0].args as { continues: { pinned: { model: string } } }).continues.pinned.model, 'gpt-b');
});

test('a child admitted on its own model, in a chat whose route cannot run it, is refused before anything is asked', async () => {
  const h = home();
  const { calls, call } = stand({ 'threads.get': selectedThread(QWEN, { child: { parentThreadId: 'parent', role: 'worker', settings: { ...settings, model: 'big' }, model: 'big' } }) });
  let asked = 0;
  await serve(h, call, async () => (asked++, true));
  const line = await attach(h);
  const r = await line.call('turns.send', send({ threadId: 't' }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.detail, /cannot run big/);
  assert.equal(asked, 0);
  assert.deepEqual(writesIn(calls), []);
});


for(const readOnly of [true,false]) test(`audit content is refused for every API-line caller (readOnly=${readOnly}) before the host or confirmer`, async()=>{
  const h=home(), host=stand(); let asked=0;
  const server=await serveApiLine({home:h,call:host.call,readOnly,confirm:async()=>{asked++;return true;}});closers.push(()=>server.close());
  const line=await attach(h);
  const result=await line.call('audit.export',{since:'2000-01-01T00:00:00Z',until:'2100-01-01T00:00:00Z',includeContent:true});
  assert.equal(result.ok,false);assert.match(result.ok?'':result.detail,/Content can be exported only by a command/);
  assert.equal(host.calls.length,0);assert.equal(asked,0);
});

test('API-line startup sweeps a stale standalone copy once, never on an audit call',async()=>{
  const stale=()=>{const folder=mkdtempSync(join(auditTemporaryRoot(),'backbone-audit-v1-2147483647-'));writeFileSync(join(folder,'owner.json'),JSON.stringify({format:'backbone.audit.temp.v1',owner:2147483647,uid:process.getuid?.(),server:null}));folders.push(folder);return folder;};
  const before=stale(),h=home();await serve(h,stand().call);assert.equal(existsSync(before),false);
  const later=stale(),line=await attach(h);await line.call('audit.export',{since:'2000-01-01T00:00:00Z',until:'2100-01-01T00:00:00Z'});
  assert.equal(existsSync(later),true,'line calls do not sweep');
});

for(const kind of ['link','file','permissive-folder'])test(`an unusable audit parent (${kind}) never prevents ordinary API reads`,async()=>{
  const fixture=home(),parent=join(fixture,'scratch'),h=home(),host=stand({'projects.list':[{id:'p',name:'Ordinary read',kind:'folder'}]});
  if(kind==='link')fs.symlinkSync(fixture,parent);else if(kind==='file')writeFileSync(parent,'not a directory');else mkdirSync(parent,{mode:0o755});
  const originalMkdir=fs.mkdirSync,originalLstat=fs.lstatSync,originalWrite=process.stderr.write;
  let diagnostic='';let server:Awaited<ReturnType<typeof serveApiLine>>|undefined;
  try{
    // Replace only the default parent's filesystem boundary. Other files/processes retain
    // their actual scratch parent, so this adverse fixture never renames a live export.
    fs.mkdirSync=((path:fs.PathLike,...args:unknown[])=>Reflect.apply(originalMkdir,fs,[path===auditScratchParent()?parent:path,...args])) as typeof originalMkdir;
    fs.lstatSync=((path:fs.PathLike,...args:unknown[])=>Reflect.apply(originalLstat,fs,[path===auditScratchParent()?parent:path,...args])) as typeof originalLstat;
    process.stderr.write=((text:unknown)=>{diagnostic+=String(text);return true;}) as typeof originalWrite;
    syncBuiltinESMExports();server=await serveApiLine({home:h,call:host.call});closers.push(()=>server!.close());
  }finally{fs.mkdirSync=originalMkdir;fs.lstatSync=originalLstat;process.stderr.write=originalWrite;syncBuiltinESMExports();}
  const line=await attach(h);assert.deepEqual(await line.call('projects.list',{}),[{id:'p',name:'Ordinary read',kind:'folder'}]);
  const audit=await line.call('audit.export',{since:'2000-01-01T00:00:00Z',until:'2100-01-01T00:00:00Z'});
  assert.equal(audit.ok,false);if(!audit.ok)assert.match(audit.detail,/scratch.*0700/);
  assert.equal(diagnostic.split('\n').filter(Boolean).length,1);assert.match(diagnostic,/scratch.*API line remains available/);assert.equal(diagnostic.includes(fixture),false);
  assert.equal(host.calls.filter(call=>call.method==='audit.export').length,0);
});
