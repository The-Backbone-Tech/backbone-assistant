import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { TurnContext, TurnRequest } from '@backbone-next/platform/ports';
import { createAcpHarness } from '../src/index.ts';
const fixture = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));
const request: TurnRequest = { threadId: 'incarnation', turnId: 'one', text: 'first', history: [], attachments: [], effort: 3, resumed: false };
const context: TurnContext = { tools: { list: async () => [], read: async () => null, write: async () => ({ outcome: 'REFUSED', detail: 'no grant' }) }, route: { kind: 'agent', provider: 'acp:fake', baseUrl: '', model: 'chosen-by-agent', label: 'fake', credential: null }, credential: async () => { throw new Error('No credential'); } };

test('a detached descendant survives Stop but cannot read or write the next incarnation', { timeout: 10_000 }, async () => {
  if (process.platform !== 'darwin') return;
  const storageDir = await mkdtemp(join(tmpdir(), 'acp-incarnation-'));
  let ready!: (value: { pid: number; work: string; state: string }) => void, result!: (value: { read: string; write: string }) => void, exiting!: () => void;
  const registered = new Promise<{ pid: number; work: string; state: string }>(resolve => { ready = resolve; });
  const observed = new Promise<{ read: string; write: string }>(resolve => { result = resolve; });
  const exited = new Promise<void>(resolve => { exiting = resolve; });
  let instruction: object = {}, pid: number | undefined;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    if (req.url === '/ready') ready(JSON.parse(body));
    if (req.url === '/result') result(JSON.parse(body));
    if (req.url === '/exiting') exiting();
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(req.url === '/instruction' ? instruction : {}));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const h = createAcpHarness({ acceptsProcessVisibility: true, command: process.execPath, args: [fixture], storageDir, env: { ACP_FAKE_MODE: 'detached', ACP_FAKE_CONTROL: `http://127.0.0.1:${address.port}` } });
  let next: ReturnType<typeof h.start> | undefined;
  try {
    const first = h.start(request, context), old = await registered; pid = old.pid;
    first.stop(); assert.equal((await first.outcome).status, 'interrupted');
    process.kill(pid, 0); // It really survived the process-group stop.
    next = h.start({ ...request, turnId: 'two', text: 'next' }, context);
    for await (const event of next.events) { if (event.type === 'text' && event.delta === 'rea') break; }
    const [anchor] = await readdir(storageDir), parent = join(storageDir, anchor);
    const current = JSON.parse(await readFile(join(parent, 'current.json'), 'utf8'));
    const work = join(parent, current, 'work'), state = join(parent, current, 'agent');
    assert.notEqual(work, old.work); assert.notEqual(state, old.state);
    await assert.rejects(access(old.work)); await assert.rejects(access(old.state));
    const capability = (await readdir(state)).find(name => name.startsWith('bridge-')); assert.ok(capability);
    instruction = { work, capability: join(state, capability) };
    assert.deepEqual(await observed, { read: 'EPERM', write: 'EPERM' });
    await assert.rejects(access(join(work, 'intrusion')));
    instruction = { exit: true }; await exited; pid = undefined;
    next.stop(); assert.equal((await next.outcome).status, 'interrupted');
  } finally {
    next?.stop(); instruction = { exit: true }; if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await h.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(storageDir, { recursive: true, force: true });
  }
});

test('reconnecting a retained session changes its paths and copies state without reusing file inodes', async () => {
  const { Session } = await import('../src/session.ts');
  const { writeFile, stat } = await import('node:fs/promises');
  const storageDir = await mkdtemp(join(tmpdir(), 'acp-reconnect-paths-'));
  const options = { acceptsProcessVisibility: true, command: process.execPath, args: [fixture], environment: 'person-rights' as const, storageDir, env: { ACP_FAKE_MODE: 'load' } };
  const session = await Session.create(options, request.threadId);
  try {
    await session.connect(options);
    const created = await session.agent!.connection.agent.request('session/new', { cwd: session.work, mcpServers: [session.bridge!.spec] }); session.sessionId = created.sessionId;
    await session.remember([]);
    const oldState = session.state, oldWork = session.work;
    await writeFile(join(oldState, 'native-state'), 'retained context'); const inode = (await stat(join(oldState, 'native-state'))).ino;
    await session.agent!.close();
    await session.connect(options);
    assert.notEqual(session.state, oldState); assert.notEqual(session.work, oldWork);
    assert.equal(await readFile(join(session.state, 'native-state'), 'utf8'), 'retained context');
    assert.notEqual((await stat(join(session.state, 'native-state'))).ino, inode);
    await assert.rejects(access(oldState)); await assert.rejects(access(oldWork));
  } finally { await session.close(true); await rm(storageDir, { recursive: true, force: true }); }
});
