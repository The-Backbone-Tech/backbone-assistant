import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { TurnContext, TurnRequest } from '@backbone-next/platform/ports';
import { createAcpHarness } from '../src/index.ts';
import { Session } from '../src/session.ts';
import { AgentProcess } from '../src/transport.ts';
const fixture = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));
const request: TurnRequest = { threadId: 'reconnect', turnId: 'one', text: 'ready', history: [], attachments: [], effort: 3, resumed: false };
const context: TurnContext = { tools: { list: async () => [], read: async () => null, write: async () => ({ outcome: 'REFUSED', detail: 'no grant' }) }, route: { kind: 'agent', provider: 'acp:fake', baseUrl: '', model: 'chosen-by-agent', label: 'fake', credential: null }, credential: async () => { throw new Error('No credential'); } };
async function until(condition: () => boolean) { for (let i = 0; i < 300; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Lifecycle condition was not reached.'); }

for (const [phase, action] of [['copy', 'stop'], ['copy', 'timeout'], ['copy', 'close'], ['initialize', 'stop']] as const) test(`${action} during held reconnect ${phase} joins it, removes resources/state and starts the next turn fresh`, { timeout: 10_000 }, async () => {
  const storageDir = await mkdtemp(join(tmpdir(), 'acp-reconnect-life-'));
  const options = { acceptsProcessVisibility: true, command: process.execPath, args: [fixture], environment: process.platform === 'darwin' ? 'restricted-writes' as const : 'person-rights' as const, storageDir, requestTimeoutMs: 1000, stopTimeoutMs: 10, env: { ACP_FAKE_MODE: 'load-state' } };
  const originalCopy = fs.copyFile, originalConnect = Session.prototype.connect, originalInitialize = AgentProcess.prototype.initialize;
  let reconnect: Promise<void> | undefined;
  let session!: Session, release!: () => void, entered!: () => void, armed = false;
  const gate = new Promise<void>(resolve => { release = resolve; }), held = new Promise<void>(resolve => { entered = resolve; });
  const agents: AgentProcess[] = [];
  Session.prototype.connect = function (options) { session = this; const pending = originalConnect.call(this, options); if (armed) reconnect = pending; return pending; };
  fs.copyFile = async (...args) => { if (armed && phase === 'copy') { entered(); await gate; } return originalCopy(...args); }; syncBuiltinESMExports();
  AgentProcess.prototype.initialize = async function () { agents.push(this); const result = await originalInitialize.call(this); if (armed && phase === 'initialize') { entered(); await gate; } return result; };
  const h = createAcpHarness(options); let closing: Promise<void> | undefined, nextHarness: ReturnType<typeof createAcpHarness> | undefined;
  try {
    const first = await h.start(request, context).outcome; assert.equal(first.status, 'done'); assert.equal(first.answer, 'fresh');
    const capability = JSON.parse(await readFile(session.bridge!.spec.args!.at(-1)!, 'utf8'));
    session.idle(1); await until(() => agents[0].process.exitCode !== null || agents[0].process.signalCode !== null);
    assert.equal(session.agent, undefined);
    armed = true; options.requestTimeoutMs = action === 'timeout' ? 10 : 1000;
    const turn = h.start({ ...request, turnId: 'two', history: [{ role: 'user', text: request.text }, { role: 'assistant', text: first.answer }] }, context);
    const stream = (async () => { for await (const _ of turn.events) { /* The stream must close. */ } })();
    await held;
    let settled = false; void turn.outcome.then(() => { settled = true; }, () => { settled = true; });
    if (action === 'stop') turn.stop(); else if (action === 'close') closing = h.close();
    await until(() => session.active === undefined);
    assert.equal(settled, false, 'the outcome must join the abandoned connect before resolving');
    armed = false; release();
    const outcome = await turn.outcome; await stream; await closing; await reconnect?.catch(() => {});
    assert.equal(outcome.status, action === 'timeout' ? 'failed' : 'interrupted');
    assert.equal(session.agent, undefined); assert.equal(session.bridge, undefined); assert.equal(session.saved, undefined);
    assert.deepEqual(await readdir(session.state), []); assert.deepEqual(await readdir(session.work), []);
    const anchor = join(storageDir, (await readdir(storageDir))[0]);
    assert.deepEqual((await readdir(anchor)).filter(name => name !== 'current.json'), [basename(session.root)], 'exactly one empty session tree remains, with no stray copy or retired tree');
    assert.deepEqual((await readdir(session.root)).sort(), ['agent', 'work']);
    for (const agent of agents) assert.ok(agent.process.exitCode !== null || agent.process.signalCode !== null, 'no abandoned agent survives');
    assert.equal(agents.length, phase === 'copy' ? 1 : 2, 'a cancelled copy cannot later spawn an agent');
    await assert.rejects(fetch(capability.url, { method: 'POST', headers: { authorization: `Bearer ${capability.token}` }, body: '{}' }));
    options.requestTimeoutMs = 1000;
    nextHarness = action === 'close' ? createAcpHarness(options) : h;
    const next = await nextHarness.start({ ...request, turnId: 'three', history: [] }, context).outcome;
    assert.equal(next.status, 'done'); assert.equal(next.answer, 'fresh');
  } finally {
    armed = false; release(); await h.close(); if (nextHarness && nextHarness !== h) await nextHarness.close();
    fs.copyFile = originalCopy; syncBuiltinESMExports(); Session.prototype.connect = originalConnect; AgentProcess.prototype.initialize = originalInitialize;
    await rm(storageDir, { recursive: true, force: true });
  }
});

test('Session.close itself joins a reconnect held inside the retained-tree copy before deleting its tree', { timeout: 10_000 }, async () => {
  const storageDir = await mkdtemp(join(tmpdir(), 'acp-close-copy-'));
  const options = { acceptsProcessVisibility: true, command: process.execPath, args: [fixture], environment: 'person-rights' as const, storageDir, env: { ACP_FAKE_MODE: 'load-state' } };
  const harness = createAcpHarness(options), originalCopy = fs.copyFile;
  let release!: () => void, entered!: () => void, session: Session | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; }), held = new Promise<void>(resolve => { entered = resolve; });
  let connecting: Promise<void> | undefined, closing: Promise<void> | undefined;
  try {
    assert.equal((await harness.start(request, context).outcome).status, 'done'); await harness.close();
    session = await Session.create(options, request.threadId);
    fs.copyFile = async (...args) => { entered(); await gate; return originalCopy(...args); }; syncBuiltinESMExports();
    connecting = session.connect(options); void connecting.catch(() => {}); await held;
    closing = session.close(true);
    release(); await closing; await connecting.catch(() => {});
    const anchor = join(storageDir, (await readdir(storageDir))[0]);
    assert.deepEqual(await readdir(anchor), ['current.json'], 'close must leave no copied session or retired native state');
    assert.equal(session.agent, undefined); assert.equal(session.bridge, undefined);
  } finally { release(); await connecting?.catch(() => {}); await closing; fs.copyFile = originalCopy; syncBuiltinESMExports(); await session?.close(true); await harness.close(); await rm(storageDir, { recursive: true, force: true }); }
});
