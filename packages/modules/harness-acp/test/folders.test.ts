import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rename, symlink, unlink, readFile, writeFile, readdir, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { TurnContext, TurnRequest } from '@backbone-next/platform/ports';
import { createAcpHarness } from '../src/index.ts';
import { Session, type ActiveTurn } from '../src/session.ts';
import { AgentProcess } from '../src/transport.ts';
import { toolBridge } from '../src/mcp.ts';
const fixture = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));
const request: TurnRequest = { threadId: 'folders', turnId: 'one', text: 'probe', history: [], attachments: [], effort: 3, resumed: false };
const context: TurnContext = { tools: { list: async () => [], read: async () => null, write: async () => ({ outcome: 'REFUSED', detail: 'no grant' }) }, route: { kind: 'agent', provider: 'acp:fake', baseUrl: '', model: 'chosen-by-agent', label: 'fake', credential: null }, credential: async () => { throw new Error('No credential'); } };

test('the real restricted-writes harness cannot rename, replace or chmod either granted folder node', async () => {
  if (process.platform !== 'darwin') return;
  const target = await realpath(await mkdtemp(join(tmpdir(), 'acp-swap-target-')));
  const h = createAcpHarness({ acceptsProcessVisibility: true, command: process.execPath, args: [fixture], env: { ACP_FAKE_MODE: 'swap-folders', ACP_FAKE_TARGET: target }, extraDenies: [target] });
  try {
    const outcome = await h.start(request, context).outcome; assert.equal(outcome.status, 'done', outcome.error ?? '');
    const results = JSON.parse(outcome.answer); assert.equal(results.length, 2);
    for (const result of results) {
      assert.equal(result.rename, 'EPERM'); assert.ok(['EPERM', 'ENOTEMPTY'].includes(result.remove));
      assert.equal(result.symlink, 'EPERM'); assert.equal(result.chmod, 'EPERM'); assert.equal(result.write, 'allowed');
    }
    assert.deepEqual(await readdir(target), []);
  } finally { await h.close(); await rm(target, { recursive: true, force: true }); }
});

for (const folder of ['work', 'state'] as const) for (const replacement of ['symlink', 'directory']) test(`Host refuses client reads/writes, bridge creation and spawn after external ${folder} ${replacement} swap`, { timeout: 5000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'acp-host-swap-'))), storageDir = join(root, 'storage'), outside = join(root, 'host');
  await mkdir(outside); await writeFile(join(outside, 'settings.json'), 'unchanged');
  const options = { acceptsProcessVisibility: true, command: process.execPath, args: [fixture], environment: 'person-rights' as const, storageDir, env: { ACP_FAKE_MODE: 'file-probe' } };
  const session = await Session.create(options, request.threadId), original = session[folder], moved = original + '-original';
  let chunk!: () => void;
  const active: ActiveTurn = { request, context, stopped: false, writeClosed: false, signal: new AbortController().signal, answer: '', push() { chunk?.(); } };
  session.active = active;
  try {
    await session.connect(options);
    const created = await session.agent!.connection.agent.request('session/new', { cwd: session.work, mcpServers: [session.bridge!.spec] }); session.sessionId = created.sessionId; session.streaming = true;
    await rename(original, moved);
    if (replacement === 'symlink') await symlink(outside, original); else await mkdir(original, { mode: 0o700 });
    for (const body of [undefined, 'overwrite']) {
      active.answer = ''; const streamed = new Promise<void>(resolve => { chunk = resolve; });
      await session.agent!.connection.agent.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: JSON.stringify({ path: join(session.work, 'settings.json'), ...(body === undefined ? {} : { body }) }) }] });
      await streamed;
      assert.match(active.answer, /refused:ACP session folder was replaced or changed/);
    }
    assert.equal(await readFile(join(outside, 'settings.json'), 'utf8'), 'unchanged');
    await session.agent!.close(); session.agent = undefined; await session.bridge!.close(); session.bridge = undefined;
    await assert.rejects(session.connect(options), /folder was replaced or changed/);
    assert.equal(session.bridge, undefined); assert.equal(session.agent, undefined);
    await assert.rejects(toolBridge(() => active, () => {}, () => {}, session.folders.state, () => session.assertFolders()), /folder was replaced or changed/);
    assert.throws(() => new AgentProcess(options, session.folders.work, session.folders.state), /folder was replaced or changed/);
    assert.deepEqual(await readdir(outside), ['settings.json']);
  } finally {
    if (replacement === 'symlink') await unlink(original).catch(() => {}); else await rm(original, { recursive: true, force: true });
    await rename(moved, original).catch(() => {});
    await session.close(true); await rm(root, { recursive: true, force: true });
  }
});
