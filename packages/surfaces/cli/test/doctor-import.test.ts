// doctor names what this machine has for a home (Node, pnpm, PostgreSQL's binaries, the Codex and
// Claude command lines, the home's holder and the shared memory PostgreSQL needs), and import copies
// memories in from the command line. A temporary folder stands in for the person's home.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';

const main = join(dirname(fileURLToPath(import.meta.url)), '../src/main.ts');
const homes: string[] = [];
const dirs: string[] = [];
after(async () => { for (const h of homes) await removeDataHome(h); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const person = mkdtempSync(join(tmpdir(), 'person-'));
dirs.push(person);
const run = (home: string, args: string[], extra: Record<string, string> = {}) => spawnSync(process.execPath, [main, ...args], { encoding: 'utf8', env: { ...process.env, HOME: person, BACKBONE_HOME: home, BACKBONE_KEYS: 'plaintext', BACKBONE_HARNESS: 'stub', ...extra } });

test('doctor names node, pnpm, PostgreSQL, the AI command lines, the holder and shared memory', () => {
  const home = freshDataHome('doctor');
  homes.push(home);
  run(home, ['projects', 'create', 'Ops']);
  const r = run(home, ['doctor', '--json']);
  const report = JSON.parse(r.stdout) as { ok: boolean; checks: { name: string; status: string; detail: string }[] };
  const names = report.checks.map((c) => c.name);
  for (const name of ['node', 'pnpm', 'postgres', 'codex', 'claude', 'shared memory', 'holder']) assert.ok(names.includes(name), `${name} in ${names.join(', ')}`);
  assert.equal(report.checks.find((c) => c.name === 'postgres')!.status, 'ok');
  // A stub home never asks the person's installed clients about their accounts (doctor-engine.test.ts).
  for (const name of ['codex', 'claude']) assert.equal(report.checks.find((c) => c.name === name)!.detail, 'not checked: this engine is not selected');
});

test('import copies memories in from the command line, with the source unchanged', () => {
  const home = freshDataHome('import');
  homes.push(home);
  run(home, ['projects', 'create', 'Ops']);
  mkdirSync(join(person, '.codex', 'memories'), { recursive: true });
  writeFileSync(join(person, '.codex', 'memories', 'm.md'), '- Deploys happen on Tuesdays.\n');
  // A named home reads the person's folders only when BACKBONE_USER_HOME names them.
  const unnamed = run(home, ['import', 'codex']);
  assert.notEqual(unnamed.status, 0);
  assert.match(unnamed.stderr, /BACKBONE_USER_HOME/);
  const r = run(home, ['import', 'codex'], { BACKBONE_USER_HOME: person });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 added to memory from Codex/);
  const file = join(person, 'notes.md');
  writeFileSync(file, '- Invoices go out on the 5th.\n');
  assert.match(run(home, ['import', file]).stdout, /1 added to memory from .*notes\.md/);
});

/** Every file of the home but the database's own folder, with its size and time of change. */
function files(home: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const at = join(dir, e.name);
      if (relative(home, at) === 'pg') continue;
      if (e.isDirectory()) walk(at);
      else { const s = statSync(at); out.push(`${relative(home, at)} ${s.size} ${s.mtimeMs}`); }
    }
  };
  walk(home);
  return out.sort();
}
const processesOf = (home: string) => execFileSync('ps', ['-axo', 'command'], { encoding: 'utf8' }).split('\n').filter((l) => l.includes(home));

test('doctor opens a free home read-only: no file of it changes, and nothing of it is left running', () => {
  const home = freshDataHome('doctor-read');
  homes.push(home);
  assert.equal(run(home, ['projects', 'create', 'Ops']).status, 0);
  const before = files(home);
  const r = run(home, ['doctor', '--json']);
  const report = JSON.parse(r.stdout) as { checks: { name: string; detail: string }[] };
  assert.match(report.checks.find((c) => c.name === 'holder')!.detail, /read-only/);
  assert.deepEqual(files(home), before);
  assert.deepEqual(processesOf(home), []);
});

test('doctor reports a class for each command line, never the text it printed', () => {
  const home = freshDataHome('doctor-quiet');
  homes.push(home);
  const bin = mkdtempSync(join(tmpdir(), 'bin-'));
  dirs.push(bin);
  // A marker that stands for anything an account line may print: it must never be shown.
  const mark = ['MARK', 'ER', '-7f3a'].join('');
  const tool = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  // Only the selected engine's command line is asked; each line is selected in turn and names its source.
  const report = (engine = 'codex') => {
    const r = run(home, ['doctor', '--json'], { PATH: `${bin}:${process.env.PATH}`, BACKBONE_HARNESS: engine });
    assert.ok(!r.stdout.includes(mark) && !r.stderr.includes(mark), 'nothing a command line printed is shown');
    return (JSON.parse(r.stdout) as { checks: { name: string; detail: string }[] }).checks;
  };
  const detail = (checks: { name: string; detail: string }[], name: string) => checks.find((c) => c.name === name)!.detail;
  tool('codex', `echo "Logged in as someone ${mark}"`);
  tool('claude', `echo "9.9.9 (${mark})"`);
  const checks = report();
  assert.equal(detail(checks, 'codex'), 'machine client sign-in (codex login status): signed in');
  assert.equal(detail(checks, 'claude'), 'not checked: this engine is not selected');
  tool('codex', `echo "Not logged in: ${mark}" >&2; exit 1`);
  tool('claude', `echo "${mark}" >&2; exit 2`);
  assert.equal(detail(report(), 'codex'), 'machine client sign-in (codex login status): signed out');

  tool('codex', `echo "${mark}"; exit 3`);
  assert.equal(detail(report(), 'codex'), 'machine client sign-in (codex login status): error');
});

test('doctor on a folder that is not yet a data home says so, and leaves it empty', () => {
  const empty = mkdtempSync(join(tmpdir(), 'not-a-home-'));
  dirs.push(empty);
  const r = run(empty, ['doctor', '--json']);
  const home = (JSON.parse(r.stdout) as { checks: { name: string; status: string; detail: string }[] }).checks.find((c) => c.name === 'home')!;
  assert.equal(home.status, 'fail');
  assert.match(home.detail, /no data folder here/i);
  assert.deepEqual(readdirSync(empty), [], 'no vault, database, stamp or folder made');
});


test('doctor gives the first-time command for a missing or empty home', () => {
  const empty = mkdtempSync(join(tmpdir(), 'doctor-first-run-'));
  dirs.push(empty);
  for (const home of [empty, join(empty, 'absent')]) {
    const r = run(home, ['doctor']);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /BACKBONE_KEYS=plaintext backbone projects create "My project"/);
    assert.match(r.stdout, /open the app and create a project there/);
    assert.match(r.stdout, /where a system key store is usable, it protects the keys at rest; code running as you can still ask the key store/);
    assert.match(r.stdout, /keys are stored in plain text; protect the folder/);
    assert.ok(r.stdout.indexOf('backbone projects create') < r.stdout.indexOf('BACKBONE_KEYS=plaintext'));
    // 10 November 2026: first-run advice goes from most to least protected (system key store, the app, then plain text),
    // the same order scripts/cli-install.test.mjs pins; this assertion encoded the earlier order.
    assert.ok(r.stdout.indexOf('open the app') < r.stdout.indexOf('BACKBONE_KEYS=plaintext'));
  }
  assert.deepEqual(readdirSync(empty), []);
});
