import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs, { mkdtemp, mkdir, writeFile, readFile, readdir, access, rm, symlink } from 'node:fs/promises';
import cp, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TurnContext, TurnRequest } from '@backbone-next/platform/ports';
import { createAcpHarness } from '../src/index.ts';
import { removeRetiredTree } from '../src/storage.ts';
const fixture = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));
const request: TurnRequest = { threadId: 'native-retire', turnId: 'one', text: 'ready', history: [], attachments: [], effort: 3, resumed: false };
const context: TurnContext = { tools: { list: async () => [], read: async () => null, write: async () => ({ outcome: 'REFUSED', detail: 'no grant' }) }, route: { kind: 'agent', provider: 'acp:fake', baseUrl: '', model: 'chosen-by-agent', label: 'fake', credential: null }, credential: async () => { throw new Error('No credential'); } };
for (const plant of ['acl', 'clone', 'deep', 'acl-fifo', 'acl-sealed', 'locked-directory', 'spaced-flags', 'spaced-flags-fallback']) test(`Stop removes an agent-planted ${plant} tree under the real write-restriction profile`, async () => {
  if (process.platform !== 'darwin') return;
  const fixturePlant = plant === 'spaced-flags-fallback' ? 'spaced-flags' : plant;
  const root = await mkdtemp(join(tmpdir(), 'acp-retire-native-')), storageDir = join(root, 'storage'), helper = join(root, 'retire-plant'), source = join(root, 'locked-source'), fixtureSource = join(root, 'fixture-source');
  await mkdir(storageDir, { mode: 0o700 }); await writeFile(source, 'owned locked source');
  const compile = spawnSync('/usr/bin/clang', [fileURLToPath(new URL('./retire-plant.c', import.meta.url)), '-o', helper], { encoding: 'utf8' }); assert.equal(compile.status, 0, compile.stderr);
  assert.equal(spawnSync('/usr/bin/chflags', ['uchg', source]).status, 0);
  if (fixturePlant === 'spaced-flags') { const prepared = spawnSync(helper, [fixturePlant, fixtureSource], { encoding: 'utf8' }); assert.equal(prepared.status, 0, prepared.stderr); }
  const spawn = cp.spawn, readDirectory = fs.readdir, utilities: ReturnType<typeof spawn>[] = [], commands: { command: string; args: string[] }[] = [];
  let forcedFallback = false;
  fs.readdir = (async (...args: Parameters<typeof fs.readdir>) => { if (plant === 'spaced-flags-fallback' && String(args[0]).includes('.retired-') && (args[1] as { withFileTypes?: boolean })?.withFileTypes) { forcedFallback = true; throw Object.assign(new Error('Force relative traversal'), { code: 'ENAMETOOLONG' }); } return readDirectory(...args); }) as typeof fs.readdir;
  cp.spawn = ((...args: Parameters<typeof spawn>) => { commands.push({ command: String(args[0]), args: (args[1] ?? []) as string[] }); const child = spawn(...args); if (['/usr/bin/find', '/bin/rm'].includes(String(args[0]))) utilities.push(child); return child; }) as typeof spawn; syncBuiltinESMExports();
  const h = createAcpHarness({ acceptsProcessVisibility: true, command: process.execPath, args: [fixture], storageDir, environment: 'restricted-writes', env: { ACP_FAKE_MODE: 'poison-wait', ACP_FAKE_PLANT: fixturePlant, ACP_FAKE_PLANT_HELPER: helper, ACP_FAKE_PLANT_SOURCE: fixturePlant === 'spaced-flags' ? fixtureSource : source } });
  try {
    const turn = h.start(request, context); let oldRoot = '';
    const stream = (async () => { for await (const event of turn.events) if (event.type === 'text' && event.delta === 'rea') {
      const anchor = join(storageDir, (await readdir(storageDir))[0]); oldRoot = join(anchor, JSON.parse(await readFile(join(anchor, 'current.json'), 'utf8')));
      // Each fixture has actually landed, rather than merely attempting a denied operation.
      const planted = join(oldRoot, 'work', 'planted'); await access(planted);
      if (plant === 'acl') assert.match(spawnSync('/bin/ls', ['-lde', planted], { encoding: 'utf8' }).stdout, /deny delete/);
      if (fixturePlant === 'spaced-flags') { for (const name of ['entry-00000', 'entry-00256']) assert.match(spawnSync('/bin/ls', ['-lO', join(planted, name)], { encoding: 'utf8' }).stdout, /uchg/, 'both flagged entries must land on opposite sides of the 256-entry batch boundary'); }
      if (plant === 'clone') assert.match(spawnSync('/bin/ls', ['-lO', planted], { encoding: 'utf8' }).stdout, /uchg/);
      if (plant === 'locked-directory') {
        // Seal and lock the owned fixture from the Host while the restricted agent is running.
        assert.equal(spawnSync('/bin/chmod', ['000', planted]).status, 0); assert.equal(spawnSync('/usr/bin/chflags', ['uchg', planted]).status, 0);
      }
      await symlink(source, join(oldRoot, 'work', 'zz-outside-link'));
      turn.stop();
    } })();
    const outcome = await turn.outcome; await stream;
    assert.equal(outcome.status, 'interrupted'); assert.doesNotMatch(outcome.error ?? '', /cleanup could not be confirmed|cleanup failed/);
    assert.match(spawnSync('/bin/ls', ['-lO', source], { encoding: 'utf8' }).stdout, /uchg/, 'repair must never follow the planted symlink into its target');
    for (const utility of utilities) assert.ok(utility.exitCode !== null || utility.signalCode !== null, 'no cleanup utility survives its outcome');
    assert.ok(oldRoot); await assert.rejects(access(oldRoot));
    assert.ok((await readdir(dirname(oldRoot))).every(name => !name.startsWith('.retired-')), 'no retired native state remains');
    if (fixturePlant === 'spaced-flags') {
      if (plant === 'spaced-flags-fallback') { assert.equal(forcedFallback, true); assert.ok(commands.some(call => call.command === '/usr/bin/find' && call.args.includes('/usr/bin/chflags'))); }
      else {
        const flagBatches = commands.filter(call => call.command === '/usr/bin/chflags' && call.args.some(path => /entry-(00000|00256)$/.test(path)));
        assert.equal(flagBatches.length, 2, 'both flagged items require distinct metadata batches');
        assert.ok(flagBatches.every(call => !(call.args.some(path => path.endsWith('entry-00000')) && call.args.some(path => path.endsWith('entry-00256')))));
        assert.equal(commands.some(call => call.command === '/usr/bin/find'), false);
      }
    }
    const next = await h.start({ ...request, turnId: 'two', text: 'next' }, context).outcome;
    assert.equal(next.status, 'done'); assert.equal(next.answer, 'fresh');
  } finally { await h.close(); for (const utility of utilities) assert.ok(utility.exitCode !== null || utility.signalCode !== null); cp.spawn = spawn; fs.readdir = readDirectory; syncBuiltinESMExports(); spawnSync('/usr/bin/chflags', ['nouchg', source]); await removeRetiredTree(root).catch(() => { spawnSync('/bin/chmod', ['-RN', root]); spawnSync('/usr/bin/chflags', ['-R', 'nouchg', root]); spawnSync('/bin/rm', ['-rf', root]); }); await rm(root, { recursive: true, force: true }); }
});
