import { observeChild, MCP_HOST_READY } from '../../../../scripts/lib/test-child.ts';
import { waitFor } from '../../../../scripts/lib/test-hang.ts';
// The real bin against the real host and core, in a fresh data home: one process per command, as a
// person runs it. The stub harness calls no model. A home that a second process finds held, a
// killed send and a home with no keys are the adverse cases.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { EXIT } from '../src/commands.ts';

const here = dirname(fileURLToPath(import.meta.url));
const main = join(here, '../src/main.ts');
const mcp = join(here, '../../mcp/src/main.ts');
const homes: string[] = [];
const children: ChildProcess[] = [];
after(async () => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) await new Promise((r) => (c.once('exit', r), c.kill('SIGKILL')));
  for (const h of homes) await removeDataHome(h);
});
function home(): string {
  const h = freshDataHome('cli');
  homes.push(h);
  return h;
}
type Env = Record<string, string | undefined>;
const baseEnv = (h: string, env: Env) => ({ ...process.env, BACKBONE_HOME: h, BACKBONE_KEYS: 'plaintext', BACKBONE_HARNESS: 'stub', ...env });

interface Ran { code: number | null; signal: NodeJS.Signals | null; out: string; err: string }
function start(h: string, args: string[], env: Env = {}) {
  const proc = spawn(process.execPath, [main, ...args], { env: baseEnv(h, env), stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(proc);
  const seen = { out: '', err: '' };
  proc.stdout.on('data', (d) => (seen.out += String(d)));
  proc.stderr.on('data', (d) => (seen.err += String(d)));
  const done = new Promise<Ran>((r) => proc.once('close', (code, signal) => r({ code, signal, ...seen })));
  return { proc, seen, done };
}
const run = (h: string, args: string[], env: Env = {}) => start(h, args, env).done;
async function until(ok: () => boolean, what: () => string) {
  await waitFor(ok,'CLI/Host output', {diagnostic:what});
  assert.ok(ok(), `never saw: ${what()}`);
}
const json = (r: Ran) => JSON.parse(r.out);

test('projects, a turn, threads, files, now, models and doctor, one process each', async () => {
  const h = home();
  const made = await run(h, ['projects', 'create', 'Q4 review', '--json']);
  assert.equal(made.code, EXIT.OK, made.err);
  assert.equal(json(made).name, 'Q4 review');
  assert.deepEqual(json(await run(h, ['projects', 'list', '--json'])).map((p: { name: string }) => p.name), ['Q4 review']);
  assert.deepEqual(json(await run(h, ['threads', 'list', '--json'])), []);

  const sent = await run(h, ['send', 'Write a brief about the quarter']);
  assert.equal(sent.code, EXIT.OK, sent.err);
  assert.match(sent.out, /brief\.md/);
  const threads = json(await run(h, ['threads', 'list', '--json']));
  assert.equal(threads.length, 1);
  const id = threads[0].id;

  const shown = await run(h, ['threads', 'show', id, '--json']);
  assert.equal(shown.code, EXIT.OK, shown.err);
  assert.equal(json(shown).turns[0].status, 'done');
  assert.equal(json(shown).turns[0].effects[0].outcome, 'DONE');
  assert.match((await run(h, ['threads', 'show', id])).out, /DONE.*brief\.md/);

  const again = await run(h, ['send', 'And what does it say?', '--thread', id]);
  assert.equal(again.code, EXIT.OK, again.err);
  assert.equal(json(await run(h, ['threads', 'show', id, '--json'])).turns.length, 2);

  assert.ok(json(await run(h, ['files', '--json'])).some((f: { path: string }) => f.path === 'brief.md'));
  const now = await run(h, ['now', '--json']);
  assert.equal(now.code, EXIT.OK, now.err);
  assert.ok(Array.isArray(json(now).current));
  const models = json(await run(h, ['models', '--json']));
  assert.ok(models.models.length >= 1);
  assert.match(models.settings.harness, /Stub/);

  const archived = await run(h, ['threads', 'archive', id]);
  assert.equal(archived.code, EXIT.OK, archived.err);
  assert.deepEqual(json(await run(h, ['threads', 'list', '--json'])), []);
  assert.equal(json(await run(h, ['threads', 'list', '--all', '--json'])).length, 1);

  const doctor = await run(h, ['doctor', '--json']);
  assert.equal(doctor.code, EXIT.OK, doctor.out + doctor.err);
  assert.equal(json(doctor).ok, true);
});

test('a thread that does not exist is refused, exit 1, with the reason', async () => {
  const h = home();
  await run(h, ['projects', 'create', 'One']);
  const r = await run(h, ['send', 'hello', '--thread', 'no-such-thread']);
  assert.equal(r.code, EXIT.REFUSED);
  assert.match(r.err, /REFUSED \(NOT_FOUND\)/);
  assert.equal((await run(h, ['threads', 'show', 'no-such-thread'])).code, EXIT.REFUSED);
});

test('on the real engine with no model route a send is refused, exit 1, and doctor warns of it', async () => {
  const h = home();
  const real = { BACKBONE_HARNESS: undefined, BACKBONE_MODEL_ENDPOINT: undefined };
  await run(h, ['projects', 'create', 'One'], real);
  const sent = await run(h, ['send', 'hello'], real);
  assert.equal(sent.code, EXIT.REFUSED, sent.out + sent.err);
  assert.match(sent.err, /REFUSED \(NOT_AVAILABLE\)/);
  const doctor = await run(h, ['doctor', '--json'], real);
  assert.equal(doctor.code, EXIT.OK, doctor.out);
  assert.equal(json(doctor).checks.find((c: { name: string }) => c.name === 'route').status, 'warn');
});

test('while a send holds the home a second process is refused by name, and stop reaches the send', async () => {
  const h = home();
  await run(h, ['projects', 'create', 'One']);
  const send = start(h, ['send', 'Write a brief about it'], { BACKBONE_STUB_WRITE_DELAY_MS: '120000' });
  await until(() => /thread [0-9a-f-]{36}/.test(send.seen.out), () => `the thread line (${send.seen.err})`);

  const second = await run(h, ['projects', 'list']);
  assert.equal(second.code, EXIT.BUSY, second.err);
  assert.match(second.err, /backbone send/);
  assert.match(second.err, /nothing was done/i);
  assert.equal(second.out, '');
  const asJson = await run(h, ['projects', 'list', '--json']);
  assert.equal(asJson.code, EXIT.BUSY);

  const doctor = await run(h, ['doctor', '--json']);
  assert.ok(json(doctor).checks.some((c: { name: string; detail: string }) => c.name === 'holder' && /send/.test(c.detail)), doctor.out);

  const id = /thread ([0-9a-f-]{36})/.exec(send.seen.out)![1];
  const wrong = await run(h, ['stop', '00000000-0000-4000-8000-000000000000']);
  assert.equal(wrong.code, EXIT.BUSY, wrong.err);

  const stop = await run(h, ['stop', id]);
  const sent = await send.done;
  assert.notEqual(sent.code, EXIT.OK, sent.out + sent.err);
  assert.ok(sent.code === EXIT.STOPPED || sent.code === EXIT.UNKNOWN, `send exited ${sent.code}: ${sent.err}`);
  assert.equal(stop.code, sent.code === EXIT.UNKNOWN ? EXIT.UNKNOWN : EXIT.OK, stop.out + stop.err);
  assert.equal((await run(h, ['projects', 'list', '--json'])).code, EXIT.OK, 'the home is free again');
});

test('a send killed mid-write leaves UNKNOWN, which show prints and never exits 0 on', async () => {
  const h = home();
  await run(h, ['projects', 'create', 'One']);
  const killed = await run(h, ['send', 'Write a brief about it'], { BACKBONE_CRASH_AT: 'write.begun' });
  assert.equal(killed.signal, 'SIGKILL');
  const id = /thread ([0-9a-f-]{36})/.exec(killed.out)![1];
  // The killed process's lock goes stale; until then the home reads as held, never as free.
  let shown: Ran;
  for (;;) {
    shown = await run(h, ['threads', 'show', id]);
    if (shown.code !== EXIT.BUSY) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(shown.code, EXIT.UNKNOWN, shown.out + shown.err);
  assert.match(shown.out + shown.err, /Unknown outcome/);
  // Reading it again is the same answer: nothing was resent or settled by looking.
  assert.equal((await run(h, ['threads', 'show', id])).code, EXIT.UNKNOWN);
});

test('a headless host serves reads to the command line and nothing that changes the home, and goes on serving', async () => {
  const h = home();
  await run(h, ['projects', 'create', 'One']);
  const host = spawn(process.execPath, [mcp, 'host', '--home', h], { env: baseEnv(h, {}), stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(host);
  const output = observeChild(host,'MCP Host');
  await output.waitForOutput(MCP_HOST_READY);
  const r = await run(h, ['projects', 'list']);
  assert.equal(r.code, EXIT.OK, r.err);
  assert.match(r.out, /One/, 'the read attached to the live host');
  const changed = await run(h, ['projects', 'create', 'Two']);
  assert.notEqual(changed.code, EXIT.OK, 'a change is not carried by a headless host');
  assert.doesNotMatch((await run(h, ['projects', 'list'])).out, /Two/);
  assert.equal(host.exitCode, null);
  await new Promise((resolve) => (host.once('exit', resolve), host.kill('SIGTERM')));
});

test('a home that does not exist is not made by reading it', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'backbone-cli-absent-'));
  const absent = join(parent, 'typo');
  const r = await run(absent, ['projects', 'list']);
  assert.equal(r.code, EXIT.REFUSED, r.err);
  assert.match(r.err, /NOT_FOUND/);
  const doctor = await run(absent, ['doctor', '--json']);
  assert.equal(doctor.code, EXIT.REFUSED);
  assert.equal(json(doctor).ok, false);
  rmSync(parent, { recursive: true });
});

test('a fresh home without a choice refuses when the test wrapper disables the system store', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'backbone-cli-nokeys-'));
  homes.push(empty);
  const r = await run(empty, ['projects', 'create', 'One'], { BACKBONE_KEYS: '' });
  assert.equal(r.code, EXIT.REFUSED, r.err);
  assert.match(r.err, /BACKBONE_SYSTEM_STORE_UNAVAILABLE=1/);
});

test('with no home named it says how to name one', async () => {
  const proc = spawn(process.execPath, [main, 'projects', 'list'], { env: { ...process.env, BACKBONE_HOME: '' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => (err += String(d)));
  const code = await new Promise((r) => proc.once('close', r));
  assert.equal(code, EXIT.USAGE);
  assert.match(err, /--home/);
});

test('chat: lines piped in run one after another in one thread, and the session ends with its input', async () => {
  const h = home();
  assert.equal((await run(h, ['projects', 'create', 'Demo'])).code, EXIT.OK);
  const proc = spawn(process.execPath, [main, 'chat'], { env: baseEnv(h, {}), stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(proc);
  const seen = { out: '', err: '' };
  proc.stdout.on('data', (d) => (seen.out += String(d)));
  proc.stderr.on('data', (d) => (seen.err += String(d)));
  const done = new Promise<number | null>((r) => proc.once('close', (code) => r(code)));
  proc.stdin.end('first message\n/effort 4\nsecond message\n/bogus\n/files\n');
  assert.equal(await done, EXIT.OK, seen.err);
  const threads = [...seen.out.matchAll(/^thread (\S+)$/gm)].map((m) => m[1]);
  assert.equal(threads.length, 2);
  assert.equal(threads[0], threads[1], 'the second message carried on in the first one\'s thread');
  assert.match(seen.out, /Effort: 4\./);
  assert.match(seen.err, /No command \/bogus/);
  assert.doesNotMatch(seen.err, /REFUSED/);
  assert.match(seen.out, /^No files\.$/m, '/files prints its list, as before the pane');
  assert.doesNotMatch(seen.out + seen.err, /\x1b|Ctrl-O/, 'piped input never gets the screen, the pane or its keys');
  const shown = json(await run(h, ['threads', 'show', threads[0], '--json']));
  assert.deepEqual(shown.turns.map((t: { user: { text: string; settings?: { effort: number } } }) => [t.user.text, t.user.settings?.effort]), [['first message', 3], ['second message', 4]]);
});
