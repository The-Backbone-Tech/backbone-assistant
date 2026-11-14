import { waitFor, TEST_HANG_MS } from '../../../../scripts/lib/test-hang.ts';
// The headless daemon: one long-lived host for a data home, without the app, so schedules, the
// heartbeat and goal runs go on with the app closed. It owns the home as the app would (one owner per
// home), serves the api line for the command line, and ends cleanly. On macOS it is installed as a
// per-user launchd agent, touching only the user's LaunchAgents folder, and removed the same way.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHost, hostClosed, removeDataHome } from '@backbone-next/platform/composition';
import { attachApi } from '@backbone-next/platform/doors/api-line';
import { plaintextKeys } from '@backbone-next/platform/keys';
import { DAEMON_READY, observeChild } from '../../../../scripts/lib/test-child.ts';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { daemonLabel, install, plistFor, status, uninstall } from '../src/daemon.ts';

const here = dirname(fileURLToPath(import.meta.url));
const main = join(here, '../src/main.ts');
const homes: string[] = [];
const dirs: string[] = [];
const children: ChildProcess[] = [];
// A daemon left running when a test fails is asked to stop first, so it stops its own database;
// only one that will not is killed. Cleanup is bounded: a stuck home must fail the run, not hold a
// test cluster and the machine's shared memory for hours.
const exited = (c: ChildProcess, ms: number) => new Promise<boolean>((r) => {
  if (c.exitCode !== null || c.signalCode !== null) return r(true);
  const output = observeChild(c,'daemon shutdown');
  const t = setTimeout(() => { console.error(output.diagnostic('shutdown still pending at the hang detector').message); r(false); }, ms);
  c.once('exit', () => (clearTimeout(t), r(true)));
});
after(async () => {
  for (const c of children) {
    if (c.exitCode !== null || c.signalCode !== null) continue;
    c.kill('SIGTERM');
    if (!(await exited(c, TEST_HANG_MS))) { c.kill('SIGKILL'); await exited(c, TEST_HANG_MS); }
  }
  for (const h of homes) await removeDataHome(h);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}, { timeout: 120_000 });
const env = (h: string) => ({ ...process.env, BACKBONE_HOME: h, BACKBONE_KEYS: 'plaintext', BACKBONE_HARNESS: 'stub' });
function run(h: string, args: string[]) {
  const proc = spawn(process.execPath, [main, ...args], { env: env(h), stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(proc);
  const output = observeChild(proc, 'CLI daemon');
  const seen = { get out() { return output.stdout; }, get err() { return output.stderr; } };
  const done = new Promise<{ code: number | null; out: string; err: string }>((r) => proc.once('close', (code) => r({ code, ...seen })));
  return { proc, seen, done, output };
}
async function until(ok: () => boolean | Promise<boolean>, what: string, diagnostic:()=>string) {
  await waitFor(ok,what,{diagnostic});
}

test('the launchd agent runs the daemon for one home, at login, and is kept alive only after a failure', () => {
  const plist = plistFor({ label: daemonLabel('/srv/people/x/Backbone & Co'), node: '/usr/local/bin/node', script: '/opt/backbone/cli/src/main.ts', home: '/srv/people/x/Backbone & Co', logs: '/srv/people/x/Backbone & Co/logs' });
  assert.match(plist, /<key>Label<\/key>\s*<string>io\.github\.albertoangulo\.daemon\.[0-9a-f]{12}<\/string>/);
  assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>\s*<string>\/opt\/backbone\/cli\/src\/main\.ts<\/string>\s*<string>daemon<\/string>\s*<string>run<\/string>\s*<string>--home<\/string>\s*<string>\/srv\/people\/x\/Backbone &amp; Co<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(plist, /<key>StandardErrorPath<\/key>\s*<string>\/srv\/people\/x\/Backbone &amp; Co\/logs\/daemon\.log<\/string>/);
  assert.notEqual(daemonLabel('/a'), daemonLabel('/b'), 'one agent per home');
});

test('install and uninstall touch only the LaunchAgents folder, and say what launchctl says', () => {
  const agents = mkdtempSync(join(tmpdir(), 'agents-'));
  dirs.push(agents);
  const calls: string[][] = [];
  let loaded = false;
  const launchctl = (args: string[]) => {
    calls.push(args);
    if (args[0] === 'bootstrap') loaded = true;
    if (args[0] === 'bootout') { const was = loaded; loaded = false; return { code: was ? 0 : 3, out: '' }; }
    if (args[0] === 'print') return loaded ? { code: 0, out: 'state = running\n\tpid = 4242\n' } : { code: 113, out: '' };
    return { code: 0, out: '' };
  };
  const at = { agents, uid: 501, node: '/usr/local/bin/node', script: '/opt/main.ts', launchctl };
  const home = join(mkdtempSync(join(tmpdir(), 'daemon-home-')), 'some home');
  dirs.push(dirname(home));
  assert.deepEqual(status(home, at), { installed: false, running: false });
  const made = install(home, at);
  assert.ok(existsSync(made.plist));
  assert.equal(dirname(made.plist), agents);
  assert.match(readFileSync(made.plist, 'utf8'), /some home/);
  assert.deepEqual(calls.at(-1), ['bootstrap', 'gui/501', made.plist]);
  assert.deepEqual(status(home, at), { installed: true, running: true, pid: 4242 });
  install(home, at);
  assert.deepEqual(calls.filter((c) => c[0] === 'bootout').length, 2, 'every install first unloads whatever launchd has under the label');
  uninstall(home, at);
  assert.equal(existsSync(made.plist), false);
  assert.deepEqual(status(home, at), { installed: false, running: false });
});

test('the daemon owns its home, serves the command line, refuses a second owner, and ends cleanly', { timeout: 240_000 }, async () => {
  const h = freshDataHome('daemon');
  homes.push(h);
  const daemon = run(h, ['daemon', 'run']);
  await daemon.output.waitForOutput(DAEMON_READY);
  assert.ok(existsSync(join(h, 'daemon.json')));
  let line = null as Awaited<ReturnType<typeof attachApi>>;
  line = await attachApi(h);
  assert.ok(line, daemon.output.diagnostic('did not serve the api line').message);
  assert.ok(Array.isArray(await line!.call('projects.list', {})));
  assert.ok((await line.call('projects.create', {name:'Local project',kind:'folder',clientKey:'daemon-local-project'})).ok);
  // No model work or Stop crosses: local project creation is the separate, explicit exception.
  // None of these calls crosses, however well formed.
  const settings = { permission: 'ask', model: 'stub', effort: 3, runsOn: 'this-computer', mode: 'chat' } as const;
  const writes = {
    'turns.stop': { threadId: 't' },
    'turns.send': { projectId: 'p', text: 'hello', attachments: [], settings, clientKey: 'k' },
    'queue.add': { threadId: 't', text: 'hello', attachments: [], settings, clientKey: 'q' },
    'goals.set': { threadId: 't', text: 'Ship it', baseVersion: 0 },
    'goals.run': { threadId: 't', budget: 3 },
    'schedules.create': { projectId: 'p', text: 'Check', when: 'every day at 9:00', settings, clientKey: 's' },
  } as const;
  for (const [method, args] of Object.entries(writes)) {
    const refused = await line!.call(method as 'turns.stop', args as never) as unknown as { ok: boolean; reason: string; detail: string };
    assert.equal(refused.ok, false, method);
    assert.equal(refused.reason, 'NOT_AVAILABLE', method);
    assert.match(refused.detail, /does not start or stop work/, method);
  }
  assert.equal(line!.send, 'closed');
  line!.close();
  assert.equal(JSON.parse(readFileSync(join(h, 'daemon.json'), 'utf8')).pid, daemon.proc.pid);

  const statusLine = await run(h, ['status']).done;
  assert.equal(statusLine.code, 0, statusLine.err);
  assert.match(statusLine.out, new RegExp(`daemon \\(pid ${daemon.proc.pid}\\)`));

  const second = await run(h, ['daemon', 'run']).done;
  assert.equal(second.code, 5, second.err);
  assert.match(second.err, /BUSY/);

  const other = createHost({ home: h, keys: undefined, harness: 'stub' });
  try {
    const held = await other.call('host.status', {});
    assert.equal(held.owns, false);
    assert.equal(held.heldBy?.kind, 'daemon');
    assert.equal(held.heldBy?.pid, daemon.proc.pid);
  } finally { other.close(); }

  daemon.proc.kill('SIGTERM');
  const ended = await daemon.done;
  assert.equal(ended.code, 0, ended.err);
  assert.equal(existsSync(join(h, 'daemon.json')), false);
  await hostClosed(h);
});

test('the owner creates, lists and shares folder and git projects while the shared daemon holds the home', { timeout: 240_000 }, async () => {
  const h = freshDataHome('daemon-projects');
  homes.push(h);
  const daemon = run(h, ['daemon', 'run', '--share', '127.0.0.1:0']);
  await daemon.output.waitForOutput(DAEMON_READY);
  try {
    const ids:string[] = [];
    for (const kind of ['folder', 'git']) {
      const name = `Launch plan ${kind}`;
      const made = await run(h, ['projects', 'create', name, '--kind', kind, '--json']).done;
      assert.equal(made.code, 0, made.err);
      const project = JSON.parse(made.out);
      assert.equal(project.name, name);
      assert.equal(project.kind, kind);
      ids.push(project.id);
      const listed = await run(h, ['projects', 'list', '--json']).done;
      assert.equal(listed.code, 0, listed.err);
      assert.ok(JSON.parse(listed.out).some((p: {id:string}) => p.id === project.id));
    }
    const invitation = await run(h, ['team','invite','--json']).done;
    assert.equal(invitation.code,0,invitation.err);
    const memberHome = freshDataHome('daemon-project-member'); homes.push(memberHome);
    const joined = await run(memberHome, ['join',JSON.parse(invitation.out).link,'--name','Colleague','--json']).done;
    assert.equal(joined.code,0,joined.err);
    const person = JSON.parse(joined.out);
    for (const id of ids) {
      const shared = await run(h, ['team','share',id,'--person',person.id,'--access','editor']).done;
      assert.equal(shared.code,0,shared.err);
    }
    const remote = await run(memberHome, ['remote','projects','--json']).done;
    assert.equal(remote.code,0,remote.err);
    assert.deepEqual(JSON.parse(remote.out).map((p:{id:string})=>p.id).sort(),ids.sort());
    assert.equal(existsSync(join(h, 'cli')), false, 'attached commands take no CLI holder lock');
    assert.equal(daemon.proc.exitCode, null);
  } finally {
    daemon.proc.kill('SIGTERM');
    const ended = await daemon.done;
    assert.equal(ended.code, 0, ended.err);
  }
});

test('with the app closed, the daemon runs a schedule that came due, once, as a turn in its own chat', { timeout: 240_000 }, async () => {
  const h = freshDataHome('daemon-schedule');
  homes.push(h);
  // Made three hours ago with the daemon's keys, as the app would have: every hour, so three runs were missed while nothing was open.
  const made = createHost({ home: h, keys: plaintextKeys(), harness: 'stub', schedules: { now: () => Date.now() - 3 * 3_600_000 } });
  try {
    const project = await made.call('projects.create', { name: 'Ops', kind: 'folder' });
    assert.ok(project.ok);
    const settings = { permission: 'full', model: 'stub', effort: 3, runsOn: 'this-computer', mode: 'chat' } as const;
    const s = await made.call('schedules.create', { projectId: project.value.id, text: 'Summarise the inbox', when: 'every hour', settings, clientKey: 'hourly' });
    assert.ok(s.ok);
  } finally { made.close(); }
  await hostClosed(h);

  const daemon = run(h, ['daemon', 'run']);
  await daemon.output.waitForOutput(DAEMON_READY);
  const line = await attachApi(h);
  assert.ok(line, daemon.output.diagnostic('did not serve the api line').message);
  type Runs = { runs: { outcome: string; caughtUp?: number; threadId: string | null }[]; schedules: { threadId: string | null }[] };
  let seen: Runs | undefined;
  await until(async () => {
    seen = await line!.call('schedules.get', {}) as unknown as Runs;
    return seen.runs.some((r) => !['starting', 'running'].includes(r.outcome));
  }, 'a settled scheduled run in the daemon',()=>daemon.output.diagnostic('schedule still pending').message);
  assert.equal(seen!.runs.length, 1, 'one run stands for all that were missed');
  assert.equal(seen!.runs[0].outcome, 'done', JSON.stringify(seen!.runs[0]));
  assert.equal(seen!.runs[0].caughtUp, 3);
  assert.ok(seen!.runs[0].threadId);
  assert.equal(seen!.schedules[0].threadId, seen!.runs[0].threadId, 'the run is a turn in the schedule\'s own chat');
  line!.close();

  daemon.proc.kill('SIGTERM');
  const ended = await daemon.done;
  assert.equal(ended.code, 0, ended.err);
  await hostClosed(h);
});

/** A launchctl that answers as told, and remembers which agents (by label) are loaded. */
function fakeLaunchd(fail: { bootout?: boolean; bootstrap?: boolean; stuck?: boolean; print?: boolean; settles?: number } = {}) {
  const agents = mkdtempSync(join(tmpdir(), 'agents-'));
  chmodSync(agents, 0o700);
  dirs.push(agents);
  const home = join(mkdtempSync(join(tmpdir(), 'daemon-home-')), 'h');
  dirs.push(dirname(home));
  const loaded = new Set<string>();
  const calls: string[][] = [];
  let stopping = 0;
  const labelOf = (target: string) => target.split('/').at(-1)!;
  const launchctl = (args: string[]) => {
    calls.push(args);
    if (args[0] === 'bootstrap') {
      if (fail.bootstrap) return { code: 5, out: 'Bootstrap failed: 5: Input/output error' };
      loaded.add(labelOf(args[2]).replace(/\.plist$/, ''));
      return { code: 0, out: '' };
    }
    const label = labelOf(args[1]);
    if (args[0] === 'bootout') {
      if (!loaded.has(label)) return { code: 3, out: 'Boot-out failed: 3: No such process' };
      if (fail.bootout) return { code: 1, out: 'Boot-out failed: 1: Operation not permitted' };
      if (!fail.stuck) loaded.delete(label);
      stopping = fail.settles ?? 0;
      return { code: 0, out: '' };
    }
    if (args[0] === 'print') {
      if (fail.print) return { code: 5, out: 'Could not read the domain: 5: Input/output error' };
      if (stopping > 0) { stopping--; return { code: 0, out: 'state = stopping\n' }; }
      return loaded.has(label) ? { code: 0, out: 'state = running\n\tpid = 4242\n' } : { code: 113, out: `Could not find service "${label}" in domain for user gui: 501` };
    }
    return { code: 0, out: '' };
  };
  return { home, calls, at: { agents, uid: 501, node: '/usr/local/bin/node', script: '/opt/main.ts', launchctl, settleMs: 2_000 }, isLoaded: () => loaded.size > 0 };
}

test('an agent installed through a link is the same agent by the real path', () => {
  const { home, at } = fakeLaunchd();
  mkdirSync(home, { recursive: true });
  const link = join(mkdtempSync(join(tmpdir(), 'ln-')), 'h');
  dirs.push(dirname(link));
  symlinkSync(home, link);
  assert.equal(daemonLabel(link), daemonLabel(home));
  const made = install(link, at);
  assert.match(readFileSync(made.plist, 'utf8'), new RegExp(`<string>${realpathSync(home).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</string>`), 'the agent runs the real path');
  assert.deepEqual(status(home, at), { installed: true, running: true, pid: 4242 });
  assert.deepEqual(uninstall(home, at), { label: daemonLabel(home), removed: true });
  assert.equal(existsSync(made.plist), false);
});

test('an uninstall that cannot tell whether launchd still has the agent says so, and keeps it', () => {
  const { home, at } = fakeLaunchd();
  const made = install(home, at);
  const unsure = { ...at, launchctl: (args: string[]) => (args[0] === 'print' ? { code: 5, out: 'Could not read the domain: 5: Input/output error' } : at.launchctl(args)) };
  // This is a person's diagnostic, not a receipt's UNKNOWN code or a JSON outcome.
  assert.throws(() => uninstall(home, unsure), /unknown outcome.*launchctl/i);
  assert.ok(existsSync(made.plist), 'kept: nothing is claimed that is not known');
});

test('reinstalling unloads the loaded agent even when its file is gone, and checks it did', () => {
  const fine = fakeLaunchd();
  const made = install(fine.home, fine.at);
  rmSync(made.plist);
  install(fine.home, fine.at);
  const kinds = fine.calls.map((c) => c[0]);
  assert.ok(kinds.lastIndexOf('bootout') > kinds.indexOf('bootstrap') && kinds.lastIndexOf('bootout') < kinds.lastIndexOf('bootstrap'), kinds.join(' '));
  const failing = fakeLaunchd({ bootout: true });
  const made2 = install(failing.home, failing.at);
  rmSync(made2.plist);
  assert.throws(() => install(failing.home, failing.at), /could not unload the agent/);
});

test('a failed load leaves no agent file behind, and says why', () => {
  const { home, at } = fakeLaunchd({ bootstrap: true });
  assert.throws(() => install(home, at), /could not load the agent: Bootstrap failed: 5/);
  assert.equal(existsSync(join(at.agents, `${daemonLabel(home)}.plist`)), false);
});

test('uninstall claims removal only once launchd no longer has the agent', () => {
  const failing = fakeLaunchd({ bootout: true });
  install(failing.home, failing.at);
  assert.throws(() => uninstall(failing.home, failing.at), /could not unload the agent: Boot-out failed: 1/);
  assert.ok(failing.isLoaded());
  assert.ok(existsSync(join(failing.at.agents, `${daemonLabel(failing.home)}.plist`)), 'kept while launchd still has it');
  const stuck = fakeLaunchd({ stuck: true });
  install(stuck.home, stuck.at);
  assert.throws(() => uninstall(stuck.home, stuck.at), /still loaded/);
  const fine = fakeLaunchd();
  install(fine.home, fine.at);
  assert.deepEqual(uninstall(fine.home, fine.at), { label: daemonLabel(fine.home), removed: true });
  assert.deepEqual(uninstall(fine.home, fine.at), { label: daemonLabel(fine.home), removed: false }, 'nothing there, nothing claimed');
});

test('reinstalling refuses when the running agent cannot be unloaded', () => {
  const { home, at } = fakeLaunchd({ bootout: true });
  install(home, at);
  assert.throws(() => install(home, at), /could not unload the agent/);
});

test('the agent file is written only into folders that are the user\'s alone, never through a link', () => {
  const open = fakeLaunchd();
  chmodSync(open.at.agents, 0o777);
  assert.throws(() => install(open.home, open.at), /LaunchAgents.*not this user's alone|not this user's alone/);
  const linked = fakeLaunchd();
  const elsewhere = join(mkdtempSync(join(tmpdir(), 'elsewhere-')), 'x.plist');
  dirs.push(dirname(elsewhere));
  writeFileSync(elsewhere, 'theirs');
  symlinkSync(elsewhere, join(linked.at.agents, `${daemonLabel(linked.home)}.plist`));
  assert.throws(() => install(linked.home, linked.at), /is a link|not a plain file/);
  assert.equal(readFileSync(elsewhere, 'utf8'), 'theirs', 'nothing written where the link points');
  const sharedLogs = fakeLaunchd();
  mkdirSync(join(sharedLogs.home, 'logs'), { recursive: true });
  chmodSync(join(sharedLogs.home, 'logs'), 0o777);
  assert.throws(() => install(sharedLogs.home, sharedLogs.at), /not this user's alone/);
  const fine = fakeLaunchd();
  const made = install(fine.home, fine.at);
  assert.equal(statSync(join(fine.home, 'logs')).mode & 0o777, 0o700);
  assert.ok(lstatSync(made.plist).isFile());
  assert.equal(statSync(made.plist).mode & 0o777, 0o644);
});

test('bootout lets go a moment later, as launchd does: uninstall waits for it, within a bound', () => {
  const { home, at } = fakeLaunchd({ settles: 3 });
  const made = install(home, at);
  assert.deepEqual(uninstall(home, at), { label: daemonLabel(home), removed: true });
  assert.equal(existsSync(made.plist), false);
});
