import { waitFor } from '../../../scripts/lib/test-hang.ts';
// Connecting AI tools to the MCP door from the app (tools.*), against fake `claude`, `codex` and
// `open` commands in a throwaway home: never this machine's real settings. The grant is the core's,
// through the platform; the tools' files change only by our one key, and go back byte for byte.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { parse as parseToml } from '@decimalturn/toml-patch';
import { type AiTool, type AiToolId, METHODS, type Receipt } from '../src/api.ts';
import { CoreLink } from '../src/composition/core.ts';
import { removeDataHome } from '../src/composition/host.ts';
import { grantDoor, openGateway, revokeDoor } from '../src/composition/gateway.ts';
import { PIECES } from '../src/composition/pieces.ts';
import { dataHomePasswords } from '../src/testing/data-home.ts';
import { mcp, SEEDS, toolWorld, type ToolWorld } from '../src/testing/tools.ts';
const SEEDS_CURSOR = () => SEEDS.cursor;
import { parseJsonc } from '../src/tools/jsonc.ts';
import { withoutCodexEntry } from '../src/tools/mechanisms.ts';
import type { ToolDoors } from '../src/tools/service.ts';
import { defaultToolEnv, place } from '../src/tools/places.ts';
import { SKILL } from '../src/tools/skill.ts';
import { readRecord } from '../src/tools/store.ts';
const ALL_TOOLS = ['claude-code', 'codex', 'cursor', 'claude-desktop'];
import { open, value } from './helpers.ts';

const worlds: ToolWorld[] = [];
after(() => worlds.forEach((w) => w.remove()));
/** A tool world and a host on a fresh data home, stopped when the test ends so clusters do not pile up. */
function setup(t: TestContext, options: Parameters<typeof toolWorld>[0] & { doors?: ToolDoors } = {}) {
  const world = toolWorld(options);
  worlds.push(world);
  const { home, host } = open(undefined, { tools: { label: 'Assistant', env: world.toolEnv, doors: options.doors } });
  t.after(async () => {
    host.close();
    await removeDataHome(home);
  });
  return { world, home, host };
}
type TestHost = ReturnType<typeof setup>['host'];
const ALL: AiToolId[] = ['claude-code', 'codex', 'cursor', 'claude-desktop'];
const tool = async (host: TestHost, id: AiToolId) => (await host.call('tools.list', {})).tools.find((t) => t.id === id)!;
const refusal = (r: Receipt<AiTool>) => (r.ok ? 'ok' : r.reason);
const doors = (home: string) => (existsSync(join(home, 'doors')) ? readdirSync(join(home, 'doors')) : []);
/** Each tool's connection record, as the app keeps it (one file per tool). */
const state = (home: string) => ({ tools: Object.fromEntries(ALL_TOOLS.map((id) => [id, readRecord<{ want: string; finalizers: string[] }>(join(home, 'tools/connections'), id)?.value])) });
/** Our entry's name: distinctive, so it never meets a `backbone` entry a person wrote by hand. */
const NAME = 'backbone-door';
/** The door inside the app (in a checkout, its own main), which every entry starts. */
const DOOR = join(PIECES.mcp.dir, 'src/main.ts');
const ourEntry = (text: string) => (parseJsonc(text) as { mcpServers?: Record<string, { command: string; args: string[]; env: Record<string, string> }> }).mcpServers?.[NAME];
const failingRevoke = (when: () => boolean): ToolDoors => ({
  grant: grantDoor,
  revoke: async (o) => {
    if (when()) throw new Error('the database is not reachable');
    return revokeDoor(o);
  },
});
/** A Codex server's table, read with a TOML parser. */
const codexServer = (text: string, name: string) => (parseToml(text) as { mcp_servers: Record<string, Record<string, unknown>> }).mcp_servers[name];
const seeded = (before: Map<string, string>, path: string) => Buffer.from(before.get(path)!, 'base64').toString('utf8');

async function propose(home: string, grant: string, key: string) {
  const gateway = await openGateway({ home, grant });
  try {
    return await gateway.call('effects.propose', { operation: 'outbox.write', args: { name: `${key}.txt`, content: key }, description: 'a note', idempotencyKey: key });
  } finally {
    await gateway.close();
  }
}

test('detection is read-only and follows HOME, CLAUDE_CONFIG_DIR, CODEX_HOME and XDG_CONFIG_HOME', async (t) => {
  const { world, host } = setup(t);
  const before = world.snapshot();
  const list = await host.call('tools.list', {});
  assert.equal(list.available, true);
  assert.deepEqual(list.tools.map((t) => [t.id, t.state]), ALL.map((id) => [id, 'disconnected']));
  assert.deepEqual(list.offer, { operations: ['outbox.write'], ceiling: 3, days: 30 });
  assert.deepEqual(world.snapshot(), before);
  assert.deepEqual(world.log().map((l) => l.argv), [['mcp', 'get', NAME, '--json']], 'only a read-only look for an entry someone else made');

  const te = world.toolEnv;
  assert.equal(place('claude-code', te).config, join(world.claudeConfig, '.claude.json'));
  assert.equal(place('claude-code', { ...te, env: { ...te.env, CLAUDE_CONFIG_DIR: '' } }).config, join(world.home, '.claude.json'));
  assert.equal(place('codex', te).config, join(world.codexHome, 'config.toml'));
  assert.equal(place('codex', { ...te, env: { ...te.env, CODEX_HOME: '' } }).config, join(world.home, '.codex/config.toml'));
  assert.equal(place('claude-desktop', { ...te, platform: 'linux', env: { ...te.env, XDG_CONFIG_HOME: '/x' } }).data, '/x/Claude');
  assert.equal(place('claude-desktop', te).data, join(world.home, 'Library/Application Support/Claude'));

  const empty = toolWorld({ seed: false });
  worlds.push(empty);
  const bare = { ...empty.toolEnv, applications: [], env: { HOME: empty.home, PATH: '/usr/bin:/bin', CLAUDE_CONFIG_DIR: join(empty.root, 'none'), CODEX_HOME: join(empty.root, 'none') } };
  // Only Cursor's own folder ($HOME/.cursor) is there.
  for (const id of ALL) assert.equal(place(id, bare).installed, id === 'cursor', id);
  assert.ok(defaultToolEnv({ HOME: '/nowhere', PATH: '' }, 'darwin').applications.includes('/Applications'));
});

test('connect, then disconnect, leaves every file byte-identical except our key', async (t) => {
  const { world, home, host } = setup(t);
  const before = world.snapshot();
  const launcher = DOOR;
  for (const id of ALL) {
    const r = await host.connectTool({ tool: id });
    assert.equal(refusal(r), 'ok', JSON.stringify(r));
    assert.deepEqual(r.ok && r.value.permission?.operations, ['outbox.write']);
  }
  const entry = (grant: string) => ({ command: launcher, args: ['serve', '--grant', grant], env: { BACKBONE_HOME: home } });

  // Claude Code, through its own command; nothing else in its file moved.
  const claude = JSON.parse(readFileSync(world.files.claude, 'utf8'));
  assert.deepEqual(claude.mcpServers[NAME], { type: 'stdio', ...entry('claude-code-1') });
  delete claude.mcpServers[NAME];
  assert.deepEqual(claude, JSON.parse(seeded(before, 'claude-config/.claude.json')));
  // Codex, through its own command, with the approval mode stated: the least-prompting one by default.
  const codex = readFileSync(world.files.codex, 'utf8');
  assert.equal(codexServer(codex, NAME).default_tools_approval_mode, 'approve');
  assert.equal(withoutCodexEntry(codex, NAME), withoutCodexEntry(seeded(before, 'codex-home/config.toml'), NAME));
  // Cursor, merged by key: comments and the other server stay.
  const cursor = readFileSync(world.files.cursor, 'utf8');
  assert.match(cursor, /\/\/ my servers/);
  assert.match(cursor, /\/\* keep me \*\//);
  assert.deepEqual((parseJsonc(cursor) as { mcpServers: Record<string, unknown> }).mcpServers[NAME], entry('cursor-1'));
  // Claude Desktop: a bundle opened in Claude itself; its config file is never written.
  const opened = world.log().find((l) => l.tool === 'open')!;
  assert.deepEqual(opened.argv.slice(0, 2), ['-a', join(world.root, 'Applications/Claude.app')]);
  assert.ok(opened.argv[2].endsWith('.mcpb') && existsSync(opened.argv[2]));
  // The bundle is a zip the system reads, whose server starts the door inside the app with this grant and the data home only.
  if (existsSync('/usr/bin/unzip')) {
    const manifest = JSON.parse(execFileSync('/usr/bin/unzip', ['-p', opened.argv[2], 'manifest.json'], { encoding: 'utf8' }));
    assert.equal(manifest.manifest_version, '0.3');
    assert.deepEqual(manifest.server.mcp_config, { command: '${__dirname}/server/door', args: ['serve', '--grant', 'claude-desktop-1'], env: { BACKBONE_HOME: home } });
    assert.match(execFileSync('/usr/bin/unzip', ['-p', opened.argv[2], 'server/door'], { encoding: 'utf8' }), new RegExp(`exec '${launcher}' "\\$@"`));
  }
  assert.ok(!existsSync(join(world.home, 'Library/Application Support/Claude/claude_desktop_config.json')));
  // The usage skill, for Claude Code and for the tools that read $HOME/.agents/skills.
  assert.equal(readFileSync(join(world.claudeConfig, 'skills/backbone/SKILL.md'), 'utf8'), SKILL);
  assert.equal(readFileSync(join(world.home, '.agents/skills/backbone/SKILL.md'), 'utf8'), SKILL);
  assert.ok(SKILL.split('\n').length < 25);
  assert.deepEqual(world.log().filter((l) => l.tool === 'claude').map((l) => l.argv), [
    ['mcp', 'add', '-s', 'user', NAME, '-e', `BACKBONE_HOME=${home}`, '--', launcher, 'serve', '--grant', 'claude-code-1'],
  ]);

  for (const id of ALL) {
    const r = await host.call('tools.disconnect', { tool: id });
    assert.equal(refusal(r), 'ok', JSON.stringify(r));
    assert.equal(r.ok && r.value.state, 'disconnected');
  }
  assert.deepEqual(world.snapshot(), before, 'every file as it was, and nothing left behind');
  assert.match((await tool(host, 'cursor')).note ?? '', /exactly as they were/);
  assert.ok(world.log().some((l) => l.tool === 'codex' && l.argv.join(' ') === `mcp remove ${NAME}`));
  // Every grant is revoked: the door refuses whatever a stale entry might still start.
  for (const id of ALL) {
    const r = await propose(home, `${id}-1`, `after-${id}`);
    assert.equal(!r.ok && r.reason, 'NO_MANDATE');
  }
});

test('an entry under our name that this app did not write stays byte-identical; ours takes the next free name', async (t) => {
  const { world, home, host } = setup(t);
  const foreign = { command: 'someone-elses-server', args: ['--theirs'], env: {} };
  writeFileSync(world.files.claude, JSON.stringify({ mcpServers: { backbone: { type: 'stdio', ...foreign }, [NAME]: { type: 'stdio', ...foreign } } }, null, 2));
  writeFileSync(world.files.codex, `${readFileSync(world.files.codex, 'utf8')}\n[mcp_servers.backbone-door]\ncommand = "someone-elses-server"\n`);
  writeFileSync(world.files.cursor, `{\n  "mcpServers": {\n    "backbone-door": ${JSON.stringify(foreign)}\n  }\n}\n`);
  const before = world.snapshot();
  for (const id of ['claude-code', 'codex', 'cursor'] as const) {
    assert.equal((await tool(host, id)).foreign, true);
    const r = value(await host.connectTool({ tool: id }));
    assert.equal(r.entryName, 'backbone-door-2');
    assert.match(r.note ?? '', /as backbone-door-2/);
  }
  // Theirs is exactly as it was; ours sits beside it under its own name.
  const claude = JSON.parse(readFileSync(world.files.claude, 'utf8')).mcpServers;
  assert.deepEqual(claude.backbone, { type: 'stdio', ...foreign });
  assert.deepEqual(claude[NAME], { type: 'stdio', ...foreign });
  assert.deepEqual(claude['backbone-door-2'].args, ['serve', '--grant', 'claude-code-1']);
  assert.equal(withoutCodexEntry(readFileSync(world.files.codex, 'utf8'), 'backbone-door-2'), withoutCodexEntry(seeded(before, 'codex-home/config.toml'), 'backbone-door-2'));
  assert.equal(codexServer(readFileSync(world.files.codex, 'utf8'), 'backbone-door-2').default_tools_approval_mode, 'approve');
  assert.deepEqual((parseJsonc(readFileSync(world.files.cursor, 'utf8')) as { mcpServers: Record<string, unknown> }).mcpServers[NAME], foreign);
  assert.ok(!world.log().some((l) => ['add', 'remove'].includes(l.argv[1]) && l.argv.includes(NAME)), 'the name taken by someone else is never added or removed');
  for (const id of ['claude-code', 'codex', 'cursor'] as const) value(await host.call('tools.disconnect', { tool: id }));
  assert.deepEqual(world.snapshot(), before);
  assert.deepEqual(doors(home).sort(), ['claude-code-1.json', 'codex-1.json', 'cursor-1.json']);
});

test('an unparsable Cursor or Codex file is refused untouched', async (t) => {
  const { world, home, host } = setup(t);
  writeFileSync(world.files.cursor, '{ "mcpServers": { "linear": { "url": "x" }, \n');
  writeFileSync(world.files.codex, 'model = "gpt-5.5"\nthis is not toml\n');
  const before = world.snapshot();
  assert.equal(refusal(await host.connectTool({ tool: 'cursor' })), 'INVALID');
  assert.equal(refusal(await host.connectTool({ tool: 'codex' })), 'INVALID');
  assert.deepEqual(world.snapshot(), before);
  assert.deepEqual(doors(home), []);
  assert.ok(!existsSync(join(home, 'tools/savepoints')));
});

test('revoke comes before the entry is removed: a disconnect stopped halfway leaves no live permission', async (t) => {
  const { world, home, host } = setup(t);
  value(await host.connectTool({ tool: 'claude-code' }));
  const live = await propose(home, 'claude-code-1', 'live');
  assert.equal(live.ok && live.value.outcome, 'DONE');
  assert.equal((await tool(host, 'claude-code')).receipts, 1);

  world.env.FAKE_FAIL = 'mcp remove';
  const stopped = await host.call('tools.disconnect', { tool: 'claude-code' });
  assert.equal(refusal(stopped), 'NOT_AVAILABLE');
  assert.match(!stopped.ok ? stopped.detail : '', /permission is revoked/);
  assert.ok(JSON.parse(readFileSync(world.files.claude, 'utf8')).mcpServers[NAME], 'the entry is still there');
  const later = await propose(home, 'claude-code-1', 'later');
  assert.equal(!later.ok && later.reason, 'NO_MANDATE');
  assert.equal((await tool(host, 'claude-code')).state, 'needs-attention');
  // The core recorded the revoke before the tool was first asked to remove the entry.
  const grant = JSON.parse(readFileSync(join(home, 'doors/claude-code-1.json'), 'utf8')) as { mandate: string };
  const link = await CoreLink.open({ home });
  const { rows } = await link.read<{ at: Date | null }>(link.person(), 'SELECT revoked_at AS at FROM app.mandates WHERE id = $1', [grant.mandate]);
  await link.release();
  const firstRemove = world.log().find((l) => l.argv[1] === 'remove')!;
  assert.ok(rows[0].at && new Date(rows[0].at).getTime() <= Date.parse(firstRemove.at), 'revoked before removal began');

  delete world.env.FAKE_FAIL;
  assert.equal(refusal(await host.call('tools.disconnect', { tool: 'claude-code' })), 'ok');
  assert.equal(JSON.parse(readFileSync(world.files.claude, 'utf8')).mcpServers[NAME], undefined);
});

test('the permission card narrows what the door declares and can never widen it', async (t) => {
  const { world, home, host } = setup(t);
  const before = world.snapshot();
  for (const wider of [
    { ceiling: 4 },
    { ceiling: 0 },
    { ceiling: 2.5 },
    { operations: ['outbox.write', 'outbox.delete'] },
    { operations: [] },
    { operations: ['outbox.write', 'outbox.write'] },
    { days: 31 },
    { days: 0 },
  ]) {
    assert.equal(refusal(await host.connectTool({ tool: 'codex', ...wider })), 'INVALID', JSON.stringify(wider));
  }
  assert.deepEqual(world.snapshot(), before);
  assert.deepEqual(doors(home), []);

  // Narrowed: a lower ceiling waits for the person, a shorter expiry, and Codex asks before each call.
  const r = value(await host.connectTool({ tool: 'codex', ceiling: 2, days: 7, askEachCall: true }));
  assert.equal(r.permission?.ceiling, 2);
  assert.ok(Math.abs(Date.parse(r.permission!.expiresAt) - (Date.now() + 7 * 86_400_000)) < 60_000);
  assert.equal(codexServer(readFileSync(world.files.codex, 'utf8'), NAME).default_tools_approval_mode, 'prompt');
  const waits = await propose(home, 'codex-1', 'narrow');
  assert.equal(waits.ok && waits.value.outcome, 'AWAITING_DECISION');
});

test('no secret or canary reaches any file this app writes or changes', async (t) => {
  const modelKey = ['canary', 'model', 'key', randomUUID()].join('-');
  const canaries = { ANTHROPIC_API_KEY: `canary-env-${randomUUID()}`, OPENAI_API_KEY: `canary-env-${randomUUID()}`, BACKBONE_CANARY: `canary-env-${randomUUID()}` };
  const { world, home, host } = setup(t, { extraEnv: canaries });
  value(await host.call('settings.model.put', { change: { route: 'own', provider: 'anthropic', key: modelKey } }));
  for (const id of ALL) value(await host.connectTool({ tool: id }));
  const secrets = [...Object.values(canaries), modelKey, ...dataHomePasswords(home)];
  const written: string[] = [];
  for (const [path, b64] of world.snapshot()) written.push(`${path}\n${Buffer.from(b64, 'base64').toString('latin1')}`);
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else written.push(`${full}\n${readFileSync(full).toString('latin1')}`);
    }
  };
  walk(join(home, 'tools'));
  for (const text of written) for (const s of secrets) assert.ok(!text.includes(s), `a secret in ${text.split('\n')[0]}`);
  // Every entry names the data home and nothing else.
  const claude = JSON.parse(readFileSync(world.files.claude, 'utf8')).mcpServers[NAME];
  const cursor = (parseJsonc(readFileSync(world.files.cursor, 'utf8')) as { mcpServers: Record<string, { env: object }> }).mcpServers[NAME];
  assert.deepEqual(Object.keys(claude.env), ['BACKBONE_HOME']);
  assert.deepEqual(Object.keys(cursor.env), ['BACKBONE_HOME']);
  const codexEnv = /^\[mcp_servers\.backbone-door\.env\]\n((?:[^[\n][^\n]*\n)*)/m.exec(readFileSync(world.files.codex, 'utf8'))![1];
  assert.deepEqual(codexEnv.trim().split('\n').map((l) => l.split(' = ')[0]), ['BACKBONE_HOME']);
});

test('a tool that was running before it was connected needs a restart', async (t) => {
  const running = [{ started: new Date(Date.now() - 3_600_000), command: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT' }];
  const { host } = setup(t, { processes: () => running });
  const r = value(await host.connectTool({ tool: 'codex' }));
  assert.equal(r.state, 'needs-restart');
  assert.match(r.note ?? '', /Restart the Codex app/);
  running.length = 0;
  assert.equal((await tool(host, 'codex')).state, 'connected');
});

test('the entry starts the door inside the app, and the tool sees its receipts counted', async (t) => {
  const { world, home, host } = setup(t);
  value(await host.connectTool({ tool: 'cursor' }));
  const entry = ourEntry(readFileSync(world.files.cursor, 'utf8'))!;
  assert.equal(entry.command, DOOR);
  const replies = await mcp(entry.command, entry.args, entry.env, [
    { method: 'tools/call', params: { name: 'propose_effect', arguments: { operation: 'outbox.write', args: { name: 'from-cursor.txt', content: 'hi' }, description: 'a note', idempotencyKey: 'cursor-note-1' } } },
  ]);
  assert.equal((replies[0] as { result: { structuredContent: { value: { outcome: string } } } }).result.structuredContent.value.outcome, 'DONE');
  assert.equal(readFileSync(join(home, 'outbox/from-cursor.txt'), 'utf8'), 'hi');
  assert.equal((await tool(host, 'cursor')).receipts, 1);
});

test('a grant is never made through the generic transport: tools.connect is not one of its methods', async (t) => {
  const { world, home, host } = setup(t);
  assert.ok(!(METHODS as string[]).includes('tools.connect'));
  // What a renderer (or anything that reaches the IPC or HTTP transport) can send is refused before it reaches the tools.
  await assert.rejects(host.call('tools.connect' as never, { tool: 'cursor' } as never), /Unknown api method/);
  assert.deepEqual(doors(home), []);
  assert.deepEqual(world.log(), []);
  // A host not given tools (the browser bridge) manages none, and refuses the main-process call too.
  const bare = open();
  assert.deepEqual(await bare.host.call('tools.list', {}), { available: false, tools: [], offer: null });
  assert.equal(refusal(await bare.host.connectTool({ tool: 'cursor' })), 'NOT_AVAILABLE');
});

test('the reconciler converges each tool to what the person chose: a moved app and a hand edit are repaired at start', async (t) => {
  const world = toolWorld();
  worlds.push(world);
  const first = open(undefined, { tools: { label: 'Assistant', env: world.toolEnv } });
  value(await first.host.connectTool({ tool: 'claude-code' }));
  value(await first.host.connectTool({ tool: 'cursor' }));
  // The person removes our Cursor entry by hand, then the app is moved (or updated) to another path.
  writeFileSync(world.files.cursor, `${JSON.stringify(JSON.parse('{}'))}\n`);
  first.host.close();
  const moved = join(world.root, 'Moved.app-door.ts');
  copyFileSync(DOOR, moved);
  chmodSync(moved, 0o755);
  const second = open(first.home, { tools: { label: 'Assistant', env: world.toolEnv, door: { command: moved, piece: PIECES.mcp.dir } } });
  t.after(async () => {
    second.host.close();
    await removeDataHome(first.home);
  });
  const settled = async (check: () => boolean) => {
    await waitFor(check,'tool entries recover after Host reopen');
    return check();
  };
  // The stand-in client rewrites its file in place, so a poll can catch it half written.
  const claudeCommand = () => { try { return JSON.parse(readFileSync(world.files.claude, 'utf8')).mcpServers[NAME]?.command; } catch { return undefined; } };
  assert.ok(await settled(() => claudeCommand() === moved), 'Claude Code points at the moved app');
  assert.ok(await settled(() => existsSync(world.files.cursor) && ourEntry(readFileSync(world.files.cursor, 'utf8'))?.command === moved), 'Cursor has its entry again');
  // Claude Code's through its own command: remove, then add at the new path, with the same grant.
  assert.deepEqual(world.log().filter((l) => l.tool === 'claude').map((l) => [l.argv[1], l.argv.at(-1)]), [['add', 'claude-code-1'], ['remove', NAME], ['add', 'claude-code-1']]);
  assert.equal((await tool(second.host, 'cursor')).state, 'connected');
  assert.equal(doors(first.home).length, 2, 'no new grant: the same permission, converged');
});

test('a failed connect is undone, revoke first; a revoke that fails stays pending, shown, and retried by disconnect', async (t) => {
  let revokeFails = true;
  const { world, home, host } = setup(t, { doors: failingRevoke(() => revokeFails) });
  const before = world.snapshot();
  world.env.FAKE_FAIL = 'mcp add';
  const r = await host.connectTool({ tool: 'claude-code' });
  assert.equal(refusal(r), 'NOT_AVAILABLE');
  // The grant may still be live, so its record stays, durably, and the tool says so.
  assert.deepEqual(state(home).tools['claude-code'], { ...state(home).tools['claude-code'], want: 'absent', finalizers: ['revoke'] });
  const pending = await tool(host, 'claude-code');
  assert.equal(pending.state, 'needs-attention');
  assert.match(pending.note ?? '', /tried again/);
  assert.deepEqual(world.snapshot(), before, 'everything else was undone');
  revokeFails = false;
  delete world.env.FAKE_FAIL;
  value(await host.call('tools.disconnect', { tool: 'claude-code' }));
  const after = await propose(home, 'claude-code-1', 'after');
  assert.equal(!after.ok && after.reason, 'NO_MANDATE');
  assert.equal((await tool(host, 'claude-code')).state, 'disconnected');
  assert.equal(state(home).tools['claude-code'], undefined);
});

test('a skill that cannot be installed undoes the connect: revoked first, then the entry removed', async (t) => {
  const { world, home, host } = setup(t);
  const skills = join(world.claudeConfig, 'skills');
  mkdirSync(skills);
  chmodSync(skills, 0o500);
  t.after(() => chmodSync(skills, 0o700));
  const before = world.snapshot();
  const r = await host.connectTool({ tool: 'claude-code' });
  assert.equal(refusal(r), 'NOT_AVAILABLE');
  assert.deepEqual(world.log().filter((l) => l.tool === 'claude').map((l) => l.argv[1]), ['add', 'remove']);
  assert.deepEqual(world.snapshot(), before);
  const late = await propose(home, 'claude-code-1', 'late');
  assert.equal(!late.ok && late.reason, 'NO_MANDATE');
  // Revoked before the entry was removed.
  const grant = JSON.parse(readFileSync(join(home, 'doors/claude-code-1.json'), 'utf8')) as { mandate: string };
  const link = await CoreLink.open({ home });
  const { rows } = await link.read<{ at: Date | null }>(link.person(), 'SELECT revoked_at AS at FROM app.mandates WHERE id = $1', [grant.mandate]);
  await link.release();
  assert.ok(rows[0].at && new Date(rows[0].at).getTime() <= Date.parse(world.log().find((l) => l.argv[1] === 'remove')!.at));
  assert.equal((await tool(host, 'claude-code')).state, 'disconnected');
});

test('a revocation still pending when the app stops is retried when it starts again', async (t) => {
  const world = toolWorld();
  worlds.push(world);
  const first = open(undefined, { tools: { label: 'Assistant', env: world.toolEnv, doors: failingRevoke(() => true) } });
  value(await first.host.connectTool({ tool: 'cursor' }));
  assert.equal(refusal(await first.host.call('tools.disconnect', { tool: 'cursor' })), 'NOT_AVAILABLE');
  assert.equal((await tool(first.host, 'cursor')).state, 'needs-attention');
  assert.equal(readFileSync(world.files.cursor, 'utf8'), SEEDS_CURSOR(), 'the entry is removed even while the revoke waits');
  first.host.close();
  const second = open(first.home, { tools: { label: 'Assistant', env: world.toolEnv } });
  t.after(async () => {
    second.host.close();
    await removeDataHome(first.home);
  });
  await waitFor(async()=>(await tool(second.host,'cursor')).state==='disconnected','owed tool revoke after Host reopen');
  assert.equal((await tool(second.host, 'cursor')).state, 'disconnected');
  const r = await propose(first.home, 'cursor-1', 'after-restart');
  assert.equal(!r.ok && r.reason, 'NO_MANDATE');
});
