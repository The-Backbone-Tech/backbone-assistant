import { waitFor } from '../../../scripts/lib/test-hang.ts';
// Connecting AI tools when things go wrong around it: two apps on one data home, a crash between
// the core's grant and its file, an expiry carried across a restart, a Codex file with a multiline
// string, and an update that changes the door. Fake tools in a throwaway home, as in tools.test.ts.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from '@decimalturn/toml-patch';
import { pieceDigest, pieceFiles } from '../src/pieces/digest.ts';
import type { AiToolId } from '../src/api.ts';
import { CoreLink } from '../src/composition/core.ts';
import { grantDoor, revokeDoor } from '../src/composition/gateway.ts';
import { withHomeLock } from '../src/composition/home-lock.ts';
import { PIECES } from '../src/composition/pieces.ts';
import { toolWorld, type ToolWorld } from '../src/testing/tools.ts';
import { parseJsonc } from '../src/tools/jsonc.ts';
import { createToolConnections, type DoorStart, type ToolDoors } from '../src/tools/service.ts';
import { Conflict, readRecord, writeRecord } from '../src/tools/store.ts';
import { freshHome, open, value } from './helpers.ts';

const DOOR = join(PIECES.mcp.dir, 'src/main.ts');
const NAME = 'backbone-door';
const worlds: ToolWorld[] = [];
const temps: string[] = [];
after(() => {
  worlds.forEach((w) => w.remove());
  temps.forEach((d) => rmSync(d, { recursive: true, force: true }));
});
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A tool world and a host; the helpers close every host and remove every home when the file ends. */
function setup(options: { doors?: ToolDoors; door?: DoorStart; home?: string; world?: ToolWorld } = {}) {
  const world = options.world ?? toolWorld();
  if (!options.world) worlds.push(world);
  const { home, host } = open(options.home, { tools: { label: 'Assistant', env: world.toolEnv, doors: options.doors, door: options.door } });
  return { world, home, host };
}
type Host = ReturnType<typeof setup>['host'];
const tool = async (host: Host, id: AiToolId) => (await host.call('tools.list', {})).tools.find((x) => x.id === id)!;
const doors = (home: string) => (existsSync(join(home, 'doors')) ? readdirSync(join(home, 'doors')).sort() : []);
/** Whether each mandate the core holds for an intent still stands: the core's own answer. */
async function byIntent(home: string, intent: string) {
  const link = await CoreLink.open({ home });
  try {
    const { rows } = await link.read<{ standing: boolean }>(link.person(), "SELECT revoked_at IS NULL AS standing FROM app.mandates WHERE intent->>'connection' = $1", [intent]);
    return rows.map((r) => r.standing);
  } finally {
    await link.release();
  }
}
/** The core's own answer: the mandates granted for a door name, and whether each still stands. */
async function mandates(home: string, door: string) {
  const link = await CoreLink.open({ home });
  try {
    const { rows } = await link.read<{ standing: boolean; expires_at: Date }>(link.person(), "SELECT revoked_at IS NULL AS standing, expires_at FROM app.mandates WHERE intent->>'door' = $1", [door]);
    return rows;
  } finally {
    await link.release();
  }
}

test('a stale save of a tool’s record is refused, never written over a newer one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'backbone-store-'));
  temps.push(dir);
  assert.equal(writeRecord(dir, 'cursor', { v: 1 }, 0), 1);
  assert.equal(writeRecord(dir, 'cursor', { v: 2 }, 1), 2);
  assert.throws(() => writeRecord(dir, 'cursor', { v: 3 }, 1), Conflict);
  assert.throws(() => writeRecord(dir, 'cursor', null, 1), Conflict);
  assert.deepEqual(readRecord(dir, 'cursor'), { rev: 2, value: { v: 2 } });
  assert.equal(writeRecord(dir, 'codex', { v: 1 }, 0), 1, 'another tool’s record is its own');
  assert.equal(writeRecord(dir, 'cursor', null, 2), 0);
  assert.equal(readRecord(dir, 'cursor'), null);
});

test('two apps on one data home: a lock serializes their changes, and neither loses the other’s record', async (t) => {
  const world = toolWorld();
  worlds.push(world);
  const home = freshHome();
  const link = CoreLink.open({ home });
  t.after(async () => (await link).release());
  const order: string[] = [];
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const a = createToolConnections({ home, env: world.toolEnv, core: {}, link: () => link, doors: { grant: async (o) => (order.push(`a ${o.name}`), await gate, grantDoor(o)), revoke: revokeDoor } });
  const b = createToolConnections({ home, env: world.toolEnv, core: {}, link: () => link, doors: { grant: async (o) => (order.push(`b ${o.name}`), grantDoor(o)), revoke: revokeDoor } });
  const first = a.connect({ tool: 'cursor' });
  await delay(300);
  const second = b.connect({ tool: 'claude-code' });
  await delay(500);
  assert.deepEqual(order, ['a cursor-1'], 'the second waits while the first holds the data home');
  open();
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  assert.deepEqual(order, ['a cursor-1', 'b claude-code-1']);
  for (const s of [a, b]) assert.deepEqual((await s.list()).tools.filter((x) => x.state === 'connected').map((x) => x.id).sort(), ['claude-code', 'cursor']);
});

test('the door’s own grant command waits for the lock the app holds on its data home', async () => {
  const home = freshHome();
  let child: ReturnType<typeof spawn> | undefined;
  await withHomeLock(home, async () => {
    child = spawn(process.execPath, [DOOR, 'grant', '--name', 'cli-1'], { env: { ...process.env, BACKBONE_HOME: home, BACKBONE_KEYS: 'plaintext' }, stdio: 'ignore' });
    const exited = await Promise.race([once(child, 'exit').then(() => true), delay(1_500).then(() => false)]);
    assert.equal(exited, false, 'the command waits while the lock is held');
  });
  const [code] = await once(child!, 'exit');
  assert.equal(code, 0);
  assert.ok(existsSync(join(home, 'doors/cli-1.json')));
});

test('a grant the core committed but whose file never appeared is found by its intent and revoked', async () => {
  const crash: ToolDoors = {
    grant: async (o) => {
      await grantDoor(o);
      // The app stops after the core's commit and before the grant's file is published.
      rmSync(join(o.home, 'doors', `${o.name}.json`));
      throw new Error('the app stopped');
    },
    revoke: revokeDoor,
  };
  const { world, home, host } = setup({ doors: crash });
  const before = world.snapshot();
  const r = await host.connectTool({ tool: 'cursor' });
  assert.equal(r.ok, false);
  assert.deepEqual(world.snapshot(), before);
  // A missing file is not taken for a revoke: the core is asked by the intent recorded first, and confirms.
  assert.deepEqual((await mandates(home, 'cursor-1')).map((m) => m.standing), [false]);
  assert.equal((await tool(host, 'cursor')).state, 'disconnected');
});

test('a connect that is retried after the core committed reuses that grant rather than making a second', async () => {
  let calls = 0;
  const retried: ToolDoors = {
    grant: async (o) => {
      calls++;
      const g = await grantDoor(o);
      if (calls === 1) {
        rmSync(join(o.home, 'doors', `${o.name}.json`));
        return grantDoor(o);
      }
      return g;
    },
    revoke: revokeDoor,
  };
  const { home, host } = setup({ doors: retried });
  value(await host.connectTool({ tool: 'cursor' }));
  assert.equal((await mandates(home, 'cursor-1')).length, 1, 'one mandate for the one intent');
  assert.ok(existsSync(join(home, 'doors/cursor-1.json')), 'its file published again');
});

test('the expiry the person approved reaches the core unchanged, and an intent past it is never granted', async () => {
  const seen: (Date | undefined)[] = [];
  const watching: ToolDoors = { grant: async (o) => (seen.push(o.expiresAt), grantDoor(o)), revoke: revokeDoor };
  const { world, home, host } = setup({ doors: watching });
  const r = value(await host.connectTool({ tool: 'cursor', days: 7 }));
  assert.equal(seen[0]?.toISOString(), r.permission?.expiresAt);
  assert.equal((await mandates(home, 'cursor-1'))[0].expires_at.toISOString(), r.permission?.expiresAt);
  value(await host.call('tools.disconnect', { tool: 'cursor' }));
  // The app stopped with a connect recorded but not granted, and starts again after its expiry.
  const dir = join(home, 'tools', 'connections');
  writeRecord(dir, 'claude-code', {
    id: 'stale-intent',
    want: 'connected',
    grant: 'claude-code-1',
    name: NAME,
    permission: { operations: ['outbox.write'], ceiling: 3, expiresAt: new Date(Date.now() - 60_000).toISOString(), askEachCall: false },
    finalizers: [],
    skills: [],
    first: true,
    problem: null,
    connectedAt: new Date(Date.now() - 120_000).toISOString(),
    savepoint: join(home, 'tools', 'savepoints', 'none'),
  }, readRecord(dir, 'claude-code')?.rev ?? 0);
  host.close();
  const again = setup({ doors: watching, home, world });
  await waitFor(()=>!readRecord(dir,'claude-code'),'expired tool grant cleanup after Host reopen');
  assert.equal(readRecord(dir, 'claude-code'), null, 'taken back at start');
  assert.equal(seen.length, 1, 'never granted');
  assert.equal(JSON.parse(readFileSync(world.files.claude, 'utf8')).mcpServers[NAME], undefined);
  assert.equal((await tool(again.host, 'claude-code')).state, 'disconnected');
});

test('Codex’s approval mode is set with a TOML-aware edit, even past a multiline string that holds a table header', async () => {
  const { world, host } = setup();
  const tricky = `${readFileSync(world.files.codex, 'utf8')}developer_instructions = """\nDo not edit:\n[mcp_servers.${NAME}]\ncommand = "not this one"\n"""\n`;
  writeFileSync(world.files.codex, tricky);
  value(await host.connectTool({ tool: 'codex' }));
  const now = parseToml(readFileSync(world.files.codex, 'utf8')) as { developer_instructions: string; mcp_servers: Record<string, Record<string, unknown>> };
  assert.equal(now.developer_instructions, (parseToml(tricky) as { developer_instructions: string }).developer_instructions);
  assert.equal(now.mcp_servers[NAME].default_tools_approval_mode, 'approve');
  assert.equal(now.mcp_servers[NAME].command, DOOR);
  value(await host.call('tools.disconnect', { tool: 'codex' }));
  assert.equal(readFileSync(world.files.codex, 'utf8'), tricky);
});

test('after an update changes the door, the tool needs one approval again, and nothing is re-granted without it', async () => {
  const copy = mkdtempSync(join(tmpdir(), 'backbone-door-copy-'));
  temps.push(copy);
  for (const f of pieceFiles(PIECES.mcp.dir)) {
    mkdirSync(dirname(join(copy, f)), { recursive: true });
    cpSync(join(PIECES.mcp.dir, f), join(copy, f));
  }
  const door = { command: DOOR, piece: copy };
  const { world, home, host } = setup({ door });
  value(await host.connectTool({ tool: 'cursor' }));
  // The update: a file of the door changes, and its manifest says so.
  writeFileSync(join(copy, 'README.md'), `${readFileSync(join(copy, 'README.md'), 'utf8')}\nA new version.\n`);
  const manifest = JSON.parse(readFileSync(join(copy, 'backbone.module.json'), 'utf8'));
  writeFileSync(join(copy, 'backbone.module.json'), `${JSON.stringify({ ...manifest, digest: pieceDigest(copy) }, null, 2)}\n`);
  const stale = await tool(host, 'cursor');
  assert.equal(stale.state, 'needs-attention');
  assert.equal(stale.update, true);
  assert.match(stale.note ?? '', /approve again/i);
  // A restart converges everything else but grants nothing new.
  host.close();
  const again = setup({ door, home, world });
  await delay(1_000);
  assert.deepEqual(doors(home), ['cursor-1.json']);
  assert.equal((await tool(again.host, 'cursor')).update, true);
  // One approval: the old grant is taken back, a new one bound to the new door, the entry rewritten.
  const r = value(await again.host.connectTool({ tool: 'cursor' }));
  assert.equal(r.state, 'connected');
  assert.equal(r.update, false);
  assert.deepEqual((await mandates(home, 'cursor-1')).map((m) => m.standing), [false]);
  assert.deepEqual((await mandates(home, 'cursor-2')).map((m) => m.standing), [true]);
  const entry = (parseJsonc(readFileSync(world.files.cursor, 'utf8')) as { mcpServers: Record<string, { args: string[] }> }).mcpServers[NAME];
  assert.deepEqual(entry.args, ['serve', '--grant', 'cursor-2']);
});

test('a grant killed between issuing its mandate and queueing its run is still found, and revoked at start', async () => {
  const world = toolWorld();
  worlds.push(world);
  const home = freshHome();
  const intent = randomUUID();
  const dir = join(home, 'tools', 'connections');
  // The app recorded the connect, its intent and the revoke it owes before asking the core (the outbox).
  writeRecord(dir, 'cursor', {
    id: intent,
    want: 'connected',
    grant: 'cursor-1',
    name: NAME,
    permission: { operations: ['outbox.write'], ceiling: 3, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), askEachCall: false },
    finalizers: ['revoke'],
    skills: [],
    first: true,
    problem: null,
    connectedAt: new Date().toISOString(),
    savepoint: join(home, 'tools', 'savepoints', 'none'),
  }, 0);
  // Then the grant is killed after the core committed the mandate, before its run and its file.
  const crash = fileURLToPath(new URL('./crash-grant.ts', import.meta.url));
  const child = spawn(process.execPath, [crash, home, 'cursor-1', intent], { env: { ...process.env, BACKBONE_CRASH_AT: 'grant.issued' }, stdio: 'ignore' });
  const [, signal] = await once(child, 'exit');
  assert.equal(signal, 'SIGKILL');
  assert.deepEqual(await byIntent(home, intent), [true], 'a mandate stands, with no run and no file');
  assert.ok(!existsSync(join(home, 'doors/cursor-1.json')));
  // The app starts again: the connect never converged, so it is taken back, revoke first.
  setup({ home, world });
  await waitFor(()=>!readRecord(dir,'cursor'),'crashed grant cleanup after Host reopen');
  assert.equal(readRecord(dir, 'cursor'), null);
  assert.deepEqual(await byIntent(home, intent), [false], 'revoked, as the core confirms');
});
