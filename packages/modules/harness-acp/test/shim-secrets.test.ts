import { directoryIdentity, assertDirectory } from '../src/directories.ts';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { test } from 'node:test';
import { toolBridge, type ToolTurn } from '../src/mcp.ts';
import { candidateWriteRestrictionCommand } from '../src/write-restrictions.ts';
const fixture = fileURLToPath(new URL('./shim-inspector.mjs', import.meta.url));
const source = fileURLToPath(new URL('./procargs.c', import.meta.url));

test('restricted-writes agents find no bridge address or token in own or sibling shim argv/environment', { timeout: 30_000 }, async () => {
  if (process.platform !== 'darwin') return;
  const root = await realpath(await mkdtemp(join(tmpdir(), 'acp-shim-secrets-'))), storage = join(root, 'storage'), helper = join(root, 'procargs');
  const compiled = spawnSync('/usr/bin/clang', [source, '-o', helper], { encoding: 'utf8' }); assert.equal(compiled.status, 0, compiled.stderr);
  const turn: ToolTurn = { stopped: false, writeClosed: false, signal: new AbortController().signal, request: { threadId: 't', turnId: 'u', text: '', history: [], attachments: [], effort: 3, resumed: false }, context: { tools: { list: async () => [], read: async () => null, write: async () => ({ outcome: 'REFUSED', detail: 'no grant' }) }, route: { kind: 'agent', provider: 'acp:fake', model: 'chosen-by-agent', label: 'fake', baseUrl: '', credential: null }, credential: async () => { throw new Error('No credential'); } } };
  const agents: ReturnType<typeof spawn>[] = [], bridges: Awaited<ReturnType<typeof toolBridge>>[] = [];
  try {
    const sessions = [];
    for (const name of ['one', 'two']) {
      const work = join(storage, name, 'work'), state = join(storage, name, 'agent');
      await mkdir(work, { recursive: true }); await mkdir(state);
      const identity = directoryIdentity(state);
      const bridge = await toolBridge(() => turn, () => {}, () => {}, identity, () => assertDirectory(identity)); bridges.push(bridge);
      const capabilityPath = bridge.spec.args!.at(-1)!, capability = JSON.parse(await readFile(capabilityPath, 'utf8'));
      assert.equal((await stat(capabilityPath)).mode & 0o777, 0o600);
      assert.ok(!JSON.stringify(bridge.spec).includes(capability.token)); assert.ok(!JSON.stringify(bridge.spec).includes(capability.url));
      const specPath = join(state, 'spec.json'); await writeFile(specPath, JSON.stringify(bridge.spec));
      const argv = candidateWriteRestrictionCommand({ command: process.execPath, args: [fixture, specPath, helper], work, state, storage });
      const agent = spawn(argv[0], argv.slice(1), { cwd: work, env: { PATH: '/usr/bin:/bin', HOME: state, TMPDIR: work }, stdio: ['pipe', 'pipe', 'pipe'] }); agents.push(agent);
      let errors = ''; agent.stderr!.on('data', b => { errors += b; });
      const lines = createInterface({ input: agent.stdout! })[Symbol.asyncIterator]();
      const ready = await lines.next(); assert.equal(ready.done, false, errors);
      const { pid, ping } = JSON.parse(ready.value!); assert.deepEqual(ping, {});
      sessions.push({ agent, lines, pid, capabilityPath, capability });
    }
    for (const own of sessions) {
      const sibling = sessions.find(s => s !== own)!;
      own.agent.stdin!.write(JSON.stringify({ pids: sessions.map(s => s.pid), otherFile: sibling.capabilityPath, otherUrl: sibling.capability.url }) + '\n');
      const reply = await own.lines.next(); assert.equal(reply.done, false);
      const result = JSON.parse(reply.value!); assert.equal(result.file, 'EPERM'); assert.ok(result.statuses.length > 0); assert.ok(result.statuses.every((status: number) => status === 403));
      for (const raw of result.inspected) {
        const contents = Buffer.from(raw, 'base64').toString();
        for (const session of sessions) { assert.ok(!contents.includes(session.capability.token)); assert.ok(!contents.includes(session.capability.url)); }
        assert.ok(!contents.includes('BACKBONE_TURN_TOKEN=')); assert.ok(!contents.includes('BACKBONE_TURN_URL='));
      }
    }
  } finally {
    for (const agent of agents) { if (agent.exitCode === null && agent.signalCode === null) { const exited = once(agent, 'exit'); agent.stdin!.end(); await exited; } }
    for (const bridge of bridges) await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});
