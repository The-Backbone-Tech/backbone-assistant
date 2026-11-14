import { observeChild } from '../../../../scripts/lib/test-child.ts';
import { waitFor } from '../../../../scripts/lib/test-hang.ts';
// The real bin attached to a running host over the api line, as a person's terminal is to the app. The
// bin runs with no keys named, so it cannot open the home itself: everything it shows came down the
// line. Adverse cases: a No, a method off the line, the host killed mid-send, and the app closed.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { EXIT } from '../src/commands.ts';

const here = dirname(fileURLToPath(import.meta.url));
const main = join(here, '../src/main.ts');
const hostFile = join(here, 'line-host.ts');
const homes: string[] = [];
const children: ChildProcess[] = [];
after(async () => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) await new Promise((r) => (c.once('exit', r), c.kill('SIGKILL')));
  for (const h of homes) await removeDataHome(h);
});

interface Ran { code: number | null; out: string; err: string }
type Env = Record<string, string | undefined>;
/** No BACKBONE_KEYS and no BACKBONE_HARNESS: what a person's shell has. */
const env = (h: string, more: Env = {}) => {
  const { BACKBONE_KEYS: _k, BACKBONE_HARNESS: _h, ...rest } = process.env;
  return { ...rest, BACKBONE_HOME: h, ...more };
};
function start(h: string, args: string[]) {
  const proc = spawn(process.execPath, [main, ...args], { env: env(h), stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(proc);
  const seen = { out: '', err: '' };
  proc.stdout.on('data', (d) => (seen.out += String(d)));
  proc.stderr.on('data', (d) => (seen.err += String(d)));
  return { proc, seen, done: new Promise<Ran>((r) => proc.once('close', (code) => r({ code, ...seen }))) };
}
const run = (h: string, args: string[]) => start(h, args).done;
async function until(ok: () => boolean, what: () => string) {
  await waitFor(ok,'CLI/Host output', {diagnostic:what});
  assert.ok(ok(), `never saw: ${what()}`);
}

async function hosted(more: Env = {}) {
  const h = freshDataHome('cli-line');
  homes.push(h);
  const host = spawn(process.execPath, [hostFile], { env: env(h, { LINE_ANSWER: 'yes', ...more }), stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(host);
  const output = observeChild(host,'API line Host');
  await output.waitForOutput(/^serving\r?$/m);
  return { h, host };
}
const stopped = (host: ChildProcess) => new Promise((r) => (host.once('exit', r), host.kill('SIGTERM')));

test('with the app running, reads and a send reach its host, and this process opens nothing', async () => {
  const { h, host } = await hosted();
  const projects = await run(h, ['projects', 'list', '--json']);
  assert.equal(projects.code, EXIT.OK, projects.err);
  assert.equal(JSON.parse(projects.out)[0].name, 'One');
  const sent = await run(h, ['send', 'Write a brief about the quarter']);
  assert.equal(sent.code, EXIT.OK, sent.err);
  assert.match(sent.out, /brief\.md/);
  const threads = JSON.parse((await run(h, ['threads', 'list', '--json'])).out);
  assert.equal(threads.length, 1);
  assert.equal((await run(h, ['threads', 'show', threads[0].id])).code, EXIT.OK);
  assert.equal((await run(h, ['now'])).code, EXIT.OK);
  assert.equal((await run(h, ['files'])).code, EXIT.OK);
  assert.equal((await run(h, ['models'])).code, EXIT.OK);
  assert.equal(existsSync(join(h, 'cli')), false, 'no CLI hold was taken');
  assert.equal(host.exitCode, null);
  await stopped(host);
});

test('the owner creates a project through the running app without opening another host', async () => {
  const { h, host } = await hosted({ LINE_ANSWER: 'no' });
  const made = await run(h, ['projects', 'create', 'Two', '--kind', 'git', '--json']);
  assert.equal(made.code, EXIT.OK, made.err);
  const project = JSON.parse(made.out);
  assert.equal(project.name, 'Two');
  assert.equal(project.kind, 'git');
  const listed = JSON.parse((await run(h, ['projects', 'list', '--json'])).out);
  assert.ok(listed.some((p: {id:string}) => p.id === project.id));
  assert.equal(existsSync(join(h, 'cli')), false);
  await stopped(host);
});

test('a second command reads and stops a send running through the app, and a running turn reads as running', async () => {
  const { h, host } = await hosted({ BACKBONE_STUB_WRITE_DELAY_MS: '60000' });
  const sending = start(h, ['send', 'Write a brief about it']);
  await until(() => /thread [0-9a-f-]{36}/.test(sending.seen.out), () => `the thread: ${sending.seen.err}`);
  const id = /thread ([0-9a-f-]{36})/.exec(sending.seen.out)![1];
  const shown = await run(h, ['threads', 'show', id]);
  assert.match(shown.out, /\[running\]/);
  assert.doesNotMatch(shown.out + shown.err, /did not finish here/);
  // Its write is under way, and until it lands that write's outcome is not known: never exit 0.
  assert.equal(shown.code, EXIT.UNKNOWN, shown.out);
  assert.match(shown.out, /write-working-copy/);
  const stop = await run(h, ['stop', id]);
  const sent = await sending.done;
  // Whatever the write came to, both commands say what the record says: an UNKNOWN is never exit 0.
  const after = JSON.parse((await run(h, ['threads', 'show', id, '--json'])).out) as { turns: { effects: { outcome: string }[] }[] };
  const unknown = after.turns.some((t) => t.effects.some((e) => e.outcome === 'UNKNOWN'));
  assert.equal(sent.code, unknown ? EXIT.UNKNOWN : EXIT.STOPPED, sent.err);
  assert.equal(stop.code, unknown ? EXIT.UNKNOWN : EXIT.OK, stop.out + stop.err);
  assert.equal(host.exitCode, null);
  await stopped(host);
});

test('what is off the line is refused and done by nothing', async () => {
  const { h, host } = await hosted();
  const sent = await run(h, ['send', 'A real thread to keep']);
  assert.equal(sent.code, EXIT.OK, sent.err);
  const before = JSON.parse((await run(h, ['threads', 'list', '--json'])).out);
  assert.equal(before.length, 1);
  assert.equal(before[0].archived, false);
  const made = await run(h, ['threads', 'archive', before[0].id]);
  assert.equal(made.code, EXIT.REFUSED, made.err);
  assert.match(made.err, /REFUSED \(NOT_AVAILABLE\)/);
  assert.deepEqual(JSON.parse((await run(h, ['threads', 'list', '--json'])).out), before);
  await stopped(host);
});

test('a send too long for the person to read in the question is refused, and nothing is asked', async () => {
  const { h, host } = await hosted();
  const r = await run(h, ['send', 'x'.repeat(5_000)]);
  assert.equal(r.code, EXIT.REFUSED, r.err);
  assert.match(r.err, /REFUSED \(INVALID\)/);
  assert.deepEqual(JSON.parse((await run(h, ['threads', 'list', '--json'])).out), []);
  await stopped(host);
});

test('the person\'s No refuses the send, and no thread is made', async () => {
  const { h, host } = await hosted({ LINE_ANSWER: 'no' });
  const sent = await run(h, ['send', 'Write a brief']);
  assert.equal(sent.code, EXIT.REFUSED, sent.err);
  assert.match(sent.err, /Waiting for you in the app/);
  assert.match(sent.err, /REFUSED/);
  assert.deepEqual(JSON.parse((await run(h, ['threads', 'list', '--json'])).out), []);
  await stopped(host);
});

test('the app killed while a send is followed is UNKNOWN, and nothing opens the home', async () => {
  const { h, host } = await hosted({ BACKBONE_STUB_WRITE_DELAY_MS: '60000' });
  const sending = start(h, ['send', 'Write a brief about it']);
  await until(() => /thread /.test(sending.seen.out), () => 'the thread');
  host.kill('SIGKILL');
  const ended = await sending.done;
  assert.equal(ended.code, EXIT.UNKNOWN, ended.err);
  assert.match(ended.err, /Unknown outcome/);
  assert.equal(existsSync(join(h, 'cli')), false);
});

test('a vault that says neither holder, or cannot be read, opens nothing', async () => {
  for (const content of ['{ not json', JSON.stringify({ format: 1, holder: 'someone-else' })]) {
    const h = mkdtempSync(join(tmpdir(), 'backbone-cli-badvault-'));
    homes.push(h);
    mkdirSync(join(h, 'keys'));
    writeFileSync(join(h, 'keys', 'vault.json'), content);
    const r = await run(h, ['threads', 'list']);
    assert.equal(r.code, EXIT.REFUSED, r.err);
    assert.match(r.err, /cannot tell who keeps this data folder's keys/);
    assert.deepEqual(readdirSync(h), ['keys']);
  }
});

test('a home with data and no vault is refused and opens nothing; a new or plaintext home goes on as before', async () => {
  for (const marker of ['data', 'projects.json', 'cluster.json']) {
    const h = mkdtempSync(join(tmpdir(), 'backbone-cli-novault-'));
    homes.push(h);
    if (marker === 'data') mkdirSync(join(h, marker));
    else writeFileSync(join(h, marker), '[]');
    for (const args of [['threads', 'list'], ['send', 'hello'], ['projects', 'create', 'Two']]) {
      const r = await run(h, args);
      assert.equal(r.code, EXIT.REFUSED, r.err);
      assert.match(r.err, /has data but no vault/, r.err);
    }
    assert.deepEqual(readdirSync(h), [marker], 'nothing was made');
  }
  const talked = mkdtempSync(join(tmpdir(), 'backbone-cli-novault-'));
  homes.push(talked);
  mkdirSync(join(talked, 'threads'));
  writeFileSync(join(talked, 'threads', 'a-thread.json'), '{}');
  const r = await run(talked, ['threads', 'list']);
  assert.equal(r.code, EXIT.REFUSED, r.err);
  assert.match(r.err, /has data but no vault/, r.err);
  const fresh = mkdtempSync(join(tmpdir(), 'backbone-cli-newhome-'));
  homes.push(fresh);
  // A try with no keys chosen leaves a home still new: the second, with keys, makes it.
  assert.match((await run(fresh, ['projects', 'create', 'One'])).err, /BACKBONE_SYSTEM_STORE_UNAVAILABLE=1/);
  const made = spawn(process.execPath, [main, 'projects', 'create', 'One'], { env: env(fresh, { BACKBONE_KEYS: 'plaintext', BACKBONE_HARNESS: 'stub' }), stdio: 'ignore' });
  assert.equal(await new Promise((r) => made.once('close', r)), EXIT.OK);
  const again = spawn(process.execPath, [main, 'projects', 'list'], { env: env(fresh, { BACKBONE_KEYS: 'plaintext', BACKBONE_HARNESS: 'stub' }), stdio: 'ignore' });
  assert.equal(await new Promise((r) => again.once('close', r)), EXIT.OK);
});

test('doctor names the app as the holder and reads through it', async () => {
  const { h, host } = await hosted();
  const r = await run(h, ['doctor', '--json']);
  assert.equal(r.code, EXIT.OK, r.err);
  const checks = JSON.parse(r.out).checks as { name: string; detail: string }[];
  assert.match(checks.find((c) => c.name === 'holder')!.detail, /app/);
  assert.equal(checks.find((c) => c.name === 'projects')!.detail, '1');
  await stopped(host);
});

test('a home the Keychain keeps, with the app closed, says so and starts no host', async () => {
  const h = mkdtempSync(join(tmpdir(), 'backbone-cli-closed-'));
  homes.push(h);
  mkdirSync(join(h, 'keys'));
  writeFileSync(join(h, 'keys', 'vault.json'), JSON.stringify({ format: 1, holder: 'keychain', wrap: 'electron-safeStorage', key: 'c2VhbGVk', entries: {} }));
  for (const args of [['threads', 'list'], ['send', 'hello'], ['stop', 'some-thread'], ['now']]) {
    const r = await run(h, args);
    assert.equal(r.code, EXIT.REFUSED, r.err);
    assert.match(r.err, /app that keeps this data folder is not running/, r.err);
  }
  const doctor = await run(h, ['doctor', '--json']);
  assert.match(doctor.out, /not running/);
  assert.deepEqual(readdirSync(h), ['keys'], 'nothing was made: no owner socket, no threads, no lock');
});

test('with the app running, queue, goal set, goal run and schedule add each go over its line once the person allows them', async () => {
  const { h, host } = await hosted();
  const sent = await run(h, ['send', 'Write a brief about the quarter']);
  assert.equal(sent.code, EXIT.OK, sent.err);
  const thread = JSON.parse((await run(h, ['threads', 'list', '--json'])).out)[0].id as string;
  const set = await run(h, ['goal', 'set', 'Write the quarter brief', '--thread', thread]);
  assert.equal(set.code, EXIT.OK, set.err);
  assert.match(set.err, /Waiting for you in the app/);
  const made = await run(h, ['schedule', 'add', 'Check the quarter', '--when', 'every day at 9:00', '--json']);
  assert.equal(made.code, EXIT.OK, made.err);
  assert.equal(JSON.parse(made.out).when, 'every day at 9:00');
  const queued = await run(h, ['queue', 'And the next quarter', '--thread', thread, '--json']);
  assert.equal(queued.code, EXIT.OK, queued.err);
  const ran = await run(h, ['goal', 'run', thread, '--budget', '1']);
  assert.notEqual(ran.code, EXIT.REFUSED, ran.err);
  const shown = JSON.parse((await run(h, ['threads', 'show', thread, '--json'])).out) as { goal?: { current?: { text: string } }; goalRun?: { budget: number } };
  assert.equal(shown.goal?.current?.text, 'Write the quarter brief');
  assert.equal(shown.goalRun?.budget, 1);
  assert.equal(existsSync(join(h, 'cli')), false, 'no CLI hold was taken');
  await stopped(host);
});

test('the person\'s No refuses queue, goal set, goal run and schedule add, and changes nothing', async () => {
  const { h, host } = await hosted({ LINE_ANSWER: 'no' });
  // The first is asked and the person says No; that No then closes the rest until the app reopens.
  const first = await run(h, ['schedule', 'add', 'Check', '--when', 'every day at 9:00']);
  assert.equal(first.code, EXIT.REFUSED, first.err);
  assert.match(first.err, /REFUSED \(NOT_AVAILABLE\): The person has not allowed/);
  for (const args of [['goal', 'set', 'Ship it', '--thread', 'some-thread'], ['goal', 'run', 'some-thread'], ['queue', 'hello', '--thread', 'some-thread']]) {
    const r = await run(h, args);
    assert.equal(r.code, EXIT.REFUSED, `${args.join(' ')}: ${r.err}`);
    assert.match(r.err, /REFUSED/);
  }
  const view = await run(h, ['status']);
  assert.match(view.out, /held by: the app/);
  assert.match(view.out, /schedules: 0/);
  assert.deepEqual(JSON.parse((await run(h, ['threads', 'list', '--json'])).out), []);
  await stopped(host);
});
