import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { plan, replaceBundle, sameSource } from './ship-mac.mjs';

test('the default plan installs the app and the command, and never names the data folder', () => {
  const home = join('/', 'srv', 'someone');
  const p = plan({ home });
  assert.equal(p.dryRun, false);
  assert.equal(p.applications, '/Applications');
  assert.equal(p.cliPrefix, join(home, '.local'));
  assert.deepEqual(p.steps, ['package the app', 'ask a running copy to quit', 'install the app in /Applications', `install the backbone command under ${join(home, '.local')}`, 'open the app']);
  assert.ok(!JSON.stringify(p).includes('Application Support'));
});

test('--no-cli leaves the command alone and --dry-run only prints', () => {
  const p = plan({ args: ['--no-cli', '--dry-run'], home: join('/', 'srv', 'someone') });
  assert.equal(p.cliPrefix, null);
  assert.equal(p.dryRun, true);
  assert.ok(!p.steps.some((s) => s.includes('backbone command')));
});

const bundle = (dir, name, text) => { const b = join(dir, name); mkdirSync(b, { recursive: true }); writeFileSync(join(b, 'v'), text); return b; };
const copy = (from, to) => cpSync(from, to, { recursive: true });

test('a replacement swaps the bundle and removes the previous one only afterwards', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ship-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = bundle(dir, 'App.app', 'old'), source = bundle(dir, 'built', 'new');
  replaceBundle(source, target, { copy });
  assert.equal(readFileSync(join(target, 'v'), 'utf8'), 'new');
  assert.ok(!existsSync(`${target}.previous`) && !existsSync(`${target}.new`));
});

test('a failed move puts the previous bundle back', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ship-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = bundle(dir, 'App.app', 'old'), source = bundle(dir, 'built', 'new');
  const move = (from, to) => { if (from.endsWith('.new')) throw new Error('disk'); renameSync(from, to); };
  assert.throws(() => replaceBundle(source, target, { copy, move }), /disk/);
  assert.equal(readFileSync(join(target, 'v'), 'utf8'), 'old');
});

test('an interrupted earlier run is recovered before the next replacement', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ship-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, 'App.app'); bundle(dir, 'App.app.previous', 'old');
  const source = bundle(dir, 'built', 'new');
  const move = (from, to) => { if (from.endsWith('.new')) throw new Error('disk'); renameSync(from, to); };
  assert.throws(() => replaceBundle(source, target, { copy, move }), /disk/);
  assert.equal(readFileSync(join(target, 'v'), 'utf8'), 'old');
});

test('the app and the command must come from one source', () => {
  const compiled = { revision: 'a', gitSourceHash: 'h' };
  assert.equal(sameSource(compiled, { revision: 'a', gitSourceHash: 'h' }), true);
  assert.equal(sameSource(compiled, { revision: 'b', gitSourceHash: 'h' }), false);
  assert.equal(sameSource(compiled, { revision: 'a', gitSourceHash: 'x' }), false);
});
