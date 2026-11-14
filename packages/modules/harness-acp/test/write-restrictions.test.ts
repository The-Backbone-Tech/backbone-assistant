import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { candidateWriteRestrictionCommand as writeRestrictionCommand } from '../src/write-restrictions.ts';

test('the OS write-restriction profile limits direct writes and denies a protected read', async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'acp-write-restrictions-')));
  const work = join(root, 'work'), state = join(root, 'state'), secret = join(root, 'secret');
  await mkdir(work); await mkdir(state); await mkdir(secret);
  try {
    if (process.platform !== 'darwin') {
      assert.throws(() => writeRestrictionCommand({ command: '/bin/echo', args: [], work, state }), /refused|No supported write-restriction profile/); return;
    }
    const script = 'printf inside > "$1/in"; printf outside > "$2/out" 2>/dev/null; test ! -e "$2/out" && test ! -r "$3"';
    const [command, ...args] = writeRestrictionCommand({ command: '/bin/sh', args: ['-c', script, 'probe', work, root, secret], work, state, extraDenies: [secret] });
    const result = spawnSync(command, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(join(work, 'in'), 'utf8'), 'inside');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('explicit person-rights execution cannot silently ignore denied folders', () => {
  assert.throws(() => writeRestrictionCommand({ command: '/bin/echo', args: [], work: '/unused', state: '/unused', environment: 'person-rights', extraDenies: ['/denied'] }), /cannot honor denied folders/);
  assert.deepEqual(writeRestrictionCommand({ command: '/bin/echo', args: ['ready'], work: '/unused', state: '/unused', environment: 'person-rights' }), ['/bin/echo', 'ready']);
});

test('production restricted-writes execution uses the qualified profile on macOS and refuses unsupported hosts', async () => {
  const { writeRestrictionCommand: production } = await import('../src/write-restrictions.ts');
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'acp-production-profile-')));
  const work = join(root, 'work'), state = join(root, 'agent'); await mkdir(work); await mkdir(state);
  try {
    if (process.platform === 'darwin') {
      const argv = production({ command: '/usr/bin/true', args: [], work, state });
      assert.equal(argv[0], '/usr/bin/sandbox-exec'); assert.match(argv[2], /\(deny default\)/);
      const result = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
    } else assert.throws(() => production({ command: '/usr/bin/true', args: [], work, state }), /unavailable|missing|refused/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('credential-place denies are independent of storage and extra denied folders', async () => {
  if (process.platform !== 'darwin') return;
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'acp-credential-deny-')));
  const storage = join(root, 'storage'), work = join(storage, 'work'), state = join(storage, 'agent'), home = join(root, 'fake-home');
  const { writeFile } = await import('node:fs/promises');
  for (const path of [work, state, join(home, '.ssh')]) await mkdir(path, { recursive: true });
  await writeFile(join(home, '.ssh', 'canary'), 'private'); await writeFile(join(home, 'plain'), 'readable');
  const previous = process.env.HOME;
  try {
    process.env.HOME = home;
    const run = (path: string) => { const [command, ...args] = writeRestrictionCommand({ command: '/bin/cat', args: [path], storage, work, state }); return spawnSync(command, args, { encoding: 'utf8' }); };
    assert.equal(run(join(home, 'plain')).stdout, 'readable');
    const denied = run(join(home, '.ssh', 'canary')); assert.notEqual(denied.status, 0); assert.equal(denied.stdout, '');
    assert.throws(() => writeRestrictionCommand({ command: '/usr/bin/true', args: [], work, state, storage, extraDenies: [work] }), /overlaps/);
    assert.throws(() => writeRestrictionCommand({ command: '/usr/bin/true', args: [], work, state, storage, extraDenies: [root + '/bad"path'] }), /quotes/);
  } finally { process.env.HOME = previous; await rm(root, { recursive: true, force: true }); }
});

test('a restricted-writes profile refuses storage that does not strictly contain both granted session folders', async () => {
  if (process.platform !== 'darwin') return;
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'acp-storage-ancestry-'))), storage = join(root, 'pool'), work = join(storage, 'work'), state = join(storage, 'agent'), elsewhere = join(root, 'elsewhere');
  for (const dir of [work, state, elsewhere]) await mkdir(dir, { recursive: true });
  const options = { command: '/usr/bin/true', args: [], work, state, storage };
  try {
    assert.equal(writeRestrictionCommand(options)[0], '/usr/bin/sandbox-exec');
    for (const override of [{ storage: elsewhere }, { state: elsewhere }, { work: elsewhere }, { storage: work }, { work: storage }]) assert.throws(() => writeRestrictionCommand({ ...options, ...override }), /storage folder must contain both session folders/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('plain cd in POSIX-mode shells fails through unreadable ancestors while the documented alternatives work', async () => {
  if (process.platform !== 'darwin') return;
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'acp-shell-cd-'))), work = join(root, 'work'), state = join(root, 'agent');
  await mkdir(work); await mkdir(state); await mkdir(join(work, 'child'));
  const run = (shell: string, script: string, options: string[] = []) => {
    const argv = writeRestrictionCommand({ command: shell, args: [...options, '-c', script], work, state, storage: root });
    return spawnSync(argv[0], argv.slice(1), { cwd: work, env: { PATH: '/usr/bin:/bin', HOME: state }, encoding: 'utf8' });
  };
  try {
    for (const script of ['cd . && echo ready', 'cd child && echo ready']) {
      const sh = run('/bin/sh', script); assert.notEqual(sh.status, 0); assert.match(sh.stderr, /Not a directory/); assert.equal(sh.stdout, '');
      const posix = run('/bin/bash', script, ['--posix']); assert.notEqual(posix.status, 0); assert.match(posix.stderr, /Not a directory/);
      for (const shell of ['/bin/zsh', '/bin/bash', '/bin/dash']) { const result = run(shell, script); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), 'ready'); }
      for (const alternative of [script.replace('cd ', 'cd -P '), 'set +o posix; ' + script]) { const result = run('/bin/sh', alternative); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), 'ready'); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
