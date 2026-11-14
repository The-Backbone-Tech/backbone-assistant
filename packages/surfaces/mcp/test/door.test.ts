import { waitFor } from '../../../../scripts/lib/test-hang.ts';
// Conformance of the MCP door, driven by the official MCP client over stdio against the real core
// in a fresh data home. The door holds no secret: it relays to the process that holds the home's
// keys (here `backbone-mcp host` for a test home, or a host with the Keychain's keys in this
// process). Adverse cases: no mandate, a canary secret, a host killed mid-dispatch, a home whose keys
// the door cannot read, and a changed tool description.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { after, test } from 'node:test';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createHost, removeDataHome } from '@backbone-next/platform/composition';
import { grantDoor } from '@backbone-next/platform/composition/gateway';
import { doorSocket } from '@backbone-next/platform/doors';
import { dataHomePasswords, freshDataHome } from '@backbone-next/platform/testing/data-home';
import { findInHome, homeSecrets, memoryKeychain } from '@backbone-next/platform/testing/keys';
import { lapseDispatchClaims } from '@backbone-next/platform/testing/time';
import { MCP_HOST_READY, observeChild } from '../../../../scripts/lib/test-child.ts';
import { READ_TOOLS, TOOLS } from '../src/tools.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, '..');
const repoRoot = join(pkgDir, '../../..');
const main = join(pkgDir, 'src/main.ts');
const CANARY = 'sk-ant-canary-7d1f0c2e9b4a4c55a1b2c3d4e5f60718'; // public-tree: synthetic

const homes: string[] = [];
const clients: Client[] = [];
const hosts: ChildProcess[] = [];
after(async () => {
  for (const c of clients) await c.close().catch(() => {});
  for (const h of hosts) if (h.exitCode === null && h.signalCode === null) await new Promise((r) => (h.once('exit', r), h.kill('SIGTERM')));
  for (const h of homes) await removeDataHome(h);
});
function freshHome(): string {
  const home = freshDataHome('mcp');
  homes.push(home);
  return home;
}

/** Until something answers on the home's door socket (a host listens once its core is up). */
async function serving(home: string) {
  await waitFor(()=>new Promise<boolean>(resolve=>{
    const probe=createConnection(doorSocket(home));
    probe.once('connect',()=>{probe.destroy();resolve(true);});
    probe.once('error',()=>resolve(false));
  }),'Host door socket readiness', {diagnostic:()=>`socket=${doorSocket(home)}`});
}

interface Host {
  output: () => string;
  exited: Promise<unknown>;
}
/** `backbone-mcp host` on a test home: the one process holding its keys, which carries every door's calls. */
async function startHost(home: string, env: Record<string, string> = {}): Promise<Host> {
  const proc = spawn(process.execPath, [main, 'host', '--home', home], { env: { ...process.env, BACKBONE_KEYS: 'plaintext', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  hosts.push(proc);
  const output = observeChild(proc, 'MCP door host');
  const exited = new Promise((r) => proc.once('exit', r));
  await output.waitForOutput(MCP_HOST_READY);
  return { output: () => output.stdout + output.stderr, exited };
}

interface Door {
  client: Client;
  stderr: () => string;
}
async function connect(home: string, grant: string, env: Record<string, string> = {}, legacy = false): Promise<Door> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [main, 'serve', '--home', home, '--grant', grant],
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TMPDIR: process.env.TMPDIR ?? tmpdir(), ...env },
    stderr: 'pipe',
  });
  let err = '';
  transport.stderr?.on('data', (d) => {
    err += String(d);
  });
  // Pinned to the 2026-07-28 revision: no fallback. A client still on the 2025 handshake is served too.
  const client = new Client({ name: 'door-conformance', version: '0.0.0' }, legacy ? {} : { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(transport);
  clients.push(client);
  return { client, stderr: () => err };
}

type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown>; content: { type: string; text?: string }[] };
const call = async (door: Door, name: string, args: Record<string, unknown>) => (await door.client.callTool({ name, arguments: args })) as ToolResult;
const body = (r: ToolResult) => r.structuredContent as { ok: boolean; value?: Record<string, unknown> & { outcome?: string }; reason?: string; detail?: string };
/** The receipt for `key` once the door's sweep has made it UNKNOWN (or the last one read, after 10 s). */
async function untilUnknown(door: Door, key: string): Promise<ToolResult> {
  let r = await call(door, 'effect_status', { idempotencyKey: key });
  for (let i = 0; i < 50 && body(r).value?.outcome !== 'UNKNOWN'; i++) {
    await new Promise((res) => setTimeout(res, 200));
    r = await call(door, 'effect_status', { idempotencyKey: key });
  }
  return r;
}
const write = (key: string, name = 'note.txt', content = 'hello') => ({ operation: 'outbox.write', args: { name, content }, description: 'Leave a note in the outbox.', idempotencyKey: key });

test('the door speaks MCP 2026-07-28 and offers exactly its hand-picked tools, as described in src/tools.ts', async () => {
  const home = freshHome();
  const door = await connect(home, 'none');
  assert.equal(door.client.getNegotiatedProtocolVersion(), '2026-07-28');
  const { tools } = await door.client.listTools();
  assert.deepEqual(
    tools.map((t) => [t.name, t.description]).sort(),
    [...TOOLS, ...READ_TOOLS].map((t) => [t.name, t.description]).sort(),
  );
  const readme = readFileSync(join(pkgDir, 'README.md'), 'utf8');
  const table = readme.split('| Tool | Arguments | Returns |')[1]?.split('\n\n')[0] ?? '';
  const documented = [...table.matchAll(/^\s*\| `([a-z_]+)` \|/gm)].map((match) => match[1]).sort();
  assert.deepEqual(documented, tools.map((tool) => tool.name).sort());
  // Effect proposal and solution execution can write; the other tools only read.
  assert.deepEqual(tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort(), ['effect_status', 'list_goals', 'list_projects', 'list_receipts', 'list_schedules', 'list_threads', 'read_thread', 'recall_knowledge', 'search_memory', 'search_threads', 'solutions_options', 'solutions_verify']);
  const older = await connect(home, 'none', {}, true);
  assert.equal(older.client.getNegotiatedProtocolVersion(), '2025-11-25');
  assert.equal((await older.client.listTools()).tools.length, TOOLS.length + READ_TOOLS.length);
});

test('a call without a mandate is refused, and nothing is sent', async () => {
  const home = freshHome();
  await startHost(home);
  const door = await connect(home, 'never-granted');
  for (const [name, args] of [
    ['propose_effect', write('k-1')],
    ['effect_status', { idempotencyKey: 'k-1' }],
    ['list_receipts', {}],
    ['recall_knowledge', { words: ['plan'] }],
  ] as const) {
    const r = await call(door, name, args);
    assert.equal(r.isError, true, name);
    assert.equal(body(r).reason, 'NO_MANDATE', name);
  }
  assert.ok(!existsSync(join(home, 'outbox/note.txt')));
});

test('every effect returns its receipt; only DONE is success; the same key is the same effect', async () => {
  const home = freshHome();
  await grantDoor({ home, name: 'claude-code', operations: ['outbox.write'], ceiling: 3 });
  await startHost(home);
  const door = await connect(home, 'claude-code');
  const done = await call(door, 'propose_effect', write('note-1'));
  assert.equal(done.isError, false);
  assert.equal(body(done).value?.outcome, 'DONE');
  assert.equal(readFileSync(join(home, 'outbox/note.txt'), 'utf8'), 'hello');
  const again = await call(door, 'propose_effect', write('note-1'));
  assert.equal(body(again).value?.effect, body(done).value?.effect);
  const status = await call(door, 'effect_status', { effect: body(done).value?.effect });
  assert.equal(body(status).value?.outcome, 'DONE');
  const list = await call(door, 'list_receipts', {});
  assert.equal((body(list).value as unknown as unknown[]).length, 1);
  // Outside the grant: the core refuses, the door reports it as an error and sends nothing.
  const outside = await call(door, 'propose_effect', { ...write('mail-1'), operation: 'email.send' });
  assert.equal(outside.isError, true);
  const blocked = await call(door, 'propose_effect', write('note-2', 'other.txt', 'different'));
  assert.equal(body(blocked).value?.outcome, 'DONE');
});

test('a canary secret never appears in any tool output or log', async () => {
  const home = freshHome();
  // The person's own model key is sealed in the same data home through the platform API.
  const host = createHost({ home });
  const sealed = await host.call('settings.model.put', { change: { route: 'own', provider: 'anthropic', key: CANARY } });
  assert.equal(sealed.ok, true);
  host.close();
  await grantDoor({ home, name: 'canary', operations: ['outbox.write'], ceiling: 3 });
  const hostOf = await startHost(home);
  const door = await connect(home, 'canary', { ANTHROPIC_API_KEY: CANARY, BACKBONE_CANARY: CANARY });
  const outputs = [
    await door.client.listTools(),
    await call(door, 'propose_effect', write('c-1')),
    await call(door, 'propose_effect', { ...write('c-2'), operation: 'model.call', args: { key: 'ANTHROPIC_API_KEY' } }),
    await call(door, 'propose_effect', write('c-3', '../../keys/master.key')),
    await call(door, 'effect_status', { effect: "x' OR 1=1 --" }),
    await call(door, 'effect_status', { effect: '00000000-0000-0000-0000-000000000000' }),
    await call(door, 'list_receipts', { limit: 200 }),
    await call(door, 'recall_knowledge', {}),
  ];
  const secrets = [CANARY, ...dataHomePasswords(home)];
  const seen = JSON.stringify(outputs) + door.stderr() + hostOf.output();
  for (const s of secrets) assert.ok(!seen.includes(s), 'a secret appeared in the door output');
});

test('an effect killed mid-way shows UNKNOWN; a retry with the same key does not resend it', async () => {
  const home = freshHome();
  await grantDoor({ home, name: 'hermes', operations: ['outbox.write'], ceiling: 3 });
  // The process holding the keys carries the dispatch, and is killed in the middle of it.
  const dying = await startHost(home, { BACKBONE_CRASH_AT: 'effect.begun' });
  const door = await connect(home, 'hermes');
  const lost = await call(door, 'propose_effect', write('kill-1', 'report.txt', 'quarterly'));
  assert.equal(lost.isError, true);
  assert.equal((lost.structuredContent as { outcome?: string }).outcome, 'UNKNOWN', 'a call cut short is never reported as refused');
  await dying.exited;
  // The host again, and the same door: the dispatch stays in flight until its own claim lapses, then
  // the host's sweep settles it by inspection.
  await startHost(home);
  assert.equal(body(await call(door, 'effect_status', { idempotencyKey: 'kill-1' })).value?.outcome, 'PENDING');
  await lapseDispatchClaims(home);
  const status = await untilUnknown(door, 'kill-1');
  assert.equal(body(status).value?.outcome, 'UNKNOWN');
  assert.ok(body(status).value?.resolveBy);
  const retry = await call(door, 'propose_effect', write('kill-1', 'report.txt', 'quarterly'));
  assert.equal(retry.isError, true);
  assert.equal(body(retry).value?.outcome, 'UNKNOWN');
  assert.equal(body(retry).value?.effect, body(status).value?.effect);
  // The same change under a new key is refused as a copy of the UNKNOWN one.
  const copy = await call(door, 'propose_effect', write('kill-2', 'report.txt', 'quarterly'));
  assert.equal(body(copy).value?.outcome, 'REFUSED');
  assert.equal(body(copy).value?.reason, 'repeat_unknown_blocked');
  assert.ok(!existsSync(join(home, 'outbox/report.txt')), 'the killed effect was sent again');
});

test('effect_status reports an UNKNOWN receipt as an error, as propose_effect does; a DONE one is not', async () => {
  const home = freshHome();
  await grantDoor({ home, name: 'codex', operations: ['outbox.write'], ceiling: 3 });
  const dying = await startHost(home, { BACKBONE_CRASH_AT: 'effect.begun' });
  const first = await connect(home, 'codex');
  assert.equal((await call(first, 'propose_effect', write('u-1', 'u.txt', 'u'))).isError, true);
  await dying.exited;
  await startHost(home);
  const door = await connect(home, 'codex');
  await lapseDispatchClaims(home);
  const unknown = await untilUnknown(door, 'u-1');
  assert.equal(body(unknown).value?.outcome, 'UNKNOWN');
  assert.equal(unknown.isError, true);
  assert.equal((await call(door, 'propose_effect', write('u-1', 'u.txt', 'u'))).isError, true);
  assert.equal(body(await call(door, 'propose_effect', write('u-2', 'v.txt', 'v'))).value?.outcome, 'DONE');
  assert.equal((await call(door, 'effect_status', { idempotencyKey: 'u-2' })).isError, false);
});

test('the README recipe: grant from the command line, use the door, revoke it, and every later call is refused', async () => {
  const home = freshHome();
  const cli = (...args: string[]) => spawnSync(process.execPath, [main, ...args], { encoding: 'utf8', env: { ...process.env, BACKBONE_HOME: home, BACKBONE_KEYS: 'plaintext' } });
  const granted = cli('grant', '--name', 'claude-code', '--operations', 'outbox.write', '--ceiling', '3');
  assert.equal(granted.status, 0, granted.stderr);
  await startHost(home);
  const door = await connect(home, 'claude-code');
  assert.equal(body(await call(door, 'propose_effect', write('r-1'))).value?.outcome, 'DONE');
  const revoked = cli('revoke', '--name', 'claude-code');
  assert.equal(revoked.status, 0, revoked.stderr);
  const later = await call(door, 'propose_effect', write('r-2', 'later.txt'));
  assert.equal(body(later).reason, 'NO_MANDATE');
});

test('the door holds no secret: with the home\'s keys in the Keychain it works only through the running app, and nothing the person\'s user can read unlocks the home', async () => {
  // A home as the app makes it: a cluster of its own, its vault wrapped by the Keychain, played here
  // by a key held in this process's memory only. The app's host serves the doors.
  const home = mkdtempSync(join(tmpdir(), 'backbone-mcp-keychain-'));
  homes.push(home);
  const keys = memoryKeychain();
  const app = createHost({ home, keys, doors: true });
  assert.equal((await app.call('settings.model.put', { change: { route: 'own', provider: 'anthropic', key: CANARY } })).ok, true);
  await grantDoor({ home, name: 'keyless', operations: ['outbox.write'], ceiling: 3, keys });
  await serving(home);
  const door = await connect(home, 'keyless');
  const done = await call(door, 'propose_effect', write('keyless-1'));
  assert.equal(body(done).value?.outcome, 'DONE', JSON.stringify(body(done)));
  assert.equal(readFileSync(join(home, 'outbox/note.txt'), 'utf8'), 'hello');

  // What the person's user can read is the files, and they hold no secret in the clear: the cluster's
  // passwords, the master key and the model key are nowhere, and a command run as that user is refused.
  const { passwords, master } = await homeSecrets(home, keys);
  const secrets = [passwords.admin, passwords.app, passwords.operator, master, CANARY];
  assert.deepEqual(findInHome(home, secrets), []);
  const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', BACKBONE_HOME: home };
  const outputs: string[] = [door.stderr()];
  for (const [args, extra] of [
    [['grant', '--name', 'mine', '--operations', 'outbox.write', '--ceiling', '4'], {}],
    [['grant', '--name', 'mine', '--operations', 'outbox.write', '--ceiling', '4'], { BACKBONE_KEYS: 'plaintext' }],
    [['revoke', '--name', 'keyless'], {}],
    [['host'], { BACKBONE_KEYS: 'plaintext' }],
  ] as const) {
    const r = spawnSync(process.execPath, [main, ...args], { encoding: 'utf8', env: { ...env, ...extra } });
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /held in the Keychain by the app/);
    outputs.push(r.stdout, r.stderr);
  }
  assert.ok(!existsSync(join(home, 'doors/mine.json')), 'a command without the keys granted a door');
  assert.equal(body(await call(door, 'propose_effect', write('keyless-2', 'second.txt'))).value?.outcome, 'DONE', 'a refused revoke revoked');
  const seen = outputs.join('') + door.stderr();
  for (const s of secrets) assert.ok(!seen.includes(typeof s === 'string' ? s : s.toString('hex')), 'a secret appeared in a log');

  // The app quits: the door says so, and sends nothing.
  app.close();
  await waitFor(()=>!existsSync(doorSocket(home)),'Host door socket removal');
  const refused = await call(door, 'propose_effect', write('keyless-3', 'later.txt'));
  assert.equal(refused.isError, true);
  assert.equal(body(refused).reason, 'NOT_AVAILABLE');
  assert.match(body(refused).detail ?? '', /not running/);
  assert.ok(!existsSync(join(home, 'outbox/later.txt')));
});

test('on Windows the door refuses to start, and says why, until its pipe is the person\'s own', () => {
  const home = freshHome();
  const cwd = mkdtempSync(join(tmpdir(), 'backbone-win32-door-'));
  try {
    const r = spawnSync(process.execPath, ['--import', "data:text/javascript,Object.defineProperty(process,'platform',{value:'win32'})", main, 'serve', '--home', home, '--grant', 'any'], {
      encoding: 'utf8',
      cwd,
      input: '',
    });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /not supported on Windows yet/);
    assert.equal(r.stdout, '', 'the door spoke MCP although it refused to run');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the tool descriptions are part of the package digest: changing one fails the manifest check", async () => {
  const { manifestProblems } = await import(join(repoRoot, 'scripts/manifests.mjs'));
  const { listFiles } = await import(join(repoRoot, 'scripts/lib/repo.mjs'));
  const ours = (listFiles(repoRoot) as string[]).filter((f) => f.startsWith(`${relative(repoRoot, pkgDir)}/`));
  assert.deepEqual(manifestProblems(repoRoot, ours), []);
  const copy = mkdtempSync(join(tmpdir(), 'mcp-digest-'));
  for (const f of [...ours, 'schemas/backbone.module.schema.json', 'packages/platform/test/gateway.test.ts']) {
    mkdirSync(dirname(join(copy, f)), { recursive: true });
    cpSync(join(repoRoot, f), join(copy, f));
  }
  assert.deepEqual(manifestProblems(copy, ours), []);
  const tools = join(copy, relative(repoRoot, pkgDir), 'src/tools.ts');
  const before = readFileSync(tools, 'utf8');
  const after = before.replace('Reading only observes: it never sends anything', 'Reading may send it again');
  assert.notEqual(after, before, 'the description to change was not found');
  writeFileSync(tools, after);
  assert.match(manifestProblems(copy, ours).join('\n'), /digest .* is not the package's content/);
  rmSync(copy, { recursive: true, force: true });
});

test('an outside MCP client cannot turn on a connector server or tool, directly or as a proposed effect', async () => {
  const home = freshHome();
  await grantDoor({ home, name: 'connector-test', operations: ['outbox.write'], ceiling: 3 });
  await startHost(home);
  const door = await connect(home, 'connector-test');
  for (const args of [{ serverId: 'claude-code:notes', enabled: true }, { serverId: 'claude-code:notes', tool: { name: 'search', enabled: true } }]) {
    await assert.rejects(call(door, 'connectors.set', args), /not found|unknown tool/i);
    const effect = await call(door, 'propose_effect', { operation: 'connectors.set', args, description: 'Enable a connector', idempotencyKey: JSON.stringify(args) });
    assert.equal(effect.isError, true);
    assert.equal(body(effect).ok, false);
  }
});
