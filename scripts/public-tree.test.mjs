import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { selectFiles, replacementFor, scanText, checkTree, exportTree } from './public-tree.mjs';

const root = resolve(import.meta.dirname, '..');
const config = JSON.parse(readFileSync(join(root, 'scripts/public-tree.json'), 'utf8'));
const scratch = t => { const dir = mkdtempSync(join(tmpdir(), 'backbone-public-test-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };

test('selection excludes only reviewed paths and maps replacements exactly', () => {
  const policy = { exclusions: [{ path: 'docs/history/', reason: 'Private records.' }, { path: 'private.md', reason: 'Private notes.' }], replacements: { 'README.md': 'public/README.md.txt' } };
  assert.deepEqual(selectFiles(['README.md', 'docs/history/a.md', 'docs/history-other.md', 'private.md', 'public/README.md.txt'], policy), ['README.md', 'docs/history-other.md', 'public/README.md.txt']);
  assert.equal(replacementFor('README.md', policy), 'public/README.md.txt');
  assert.equal(replacementFor('other.md', policy), 'other.md');
});

test('privacy rules detect synthetic samples without embedding real identities', () => {
  const samples = [
    ['personal-email', ['person', 'gmail.com'].join('@')],
    ['owner-surname', ['An', 'gulo'].join('').toLowerCase()],
    ['home-path', '/' + ['Users', 'real-user', 'work'].join('/')],
    ['private-evidence', ['owner', 'private:'].join('-') + 'evidence/result'],
    ['private-evidence', ['backbone', 'owner:'].join('-') + 'reports/result'],
    ['client-session', 'session ' + ['12345678', '1234', '1234', '1234', '123456789abc'].join('-')],
    ['client-session', ['local', '123456789abcdef'].join('_')],
    ['token', 'sk-' + 'A'.repeat(40)],
    ['token', 'ghp_' + 'B'.repeat(36)],
    ['token', 'Bearer ' + 'C'.repeat(40)],
  ];
  for (const [id, sample] of samples) {
    assert.ok(scanText('docs/example.md', `Safe\n${sample}\n`, config).some(hit => hit.rule === id && hit.line === 2), id);
  }
  assert.deepEqual(scanText('docs/example.md', 'mail@example.com; session settings; local_model', config), []);
  const token = 'sk-' + 'A'.repeat(40);
  assert.deepEqual(scanText('packages/a/test/example.test.ts', `// public-tree: synthetic\nconst canary = '${token}';`, config), []);
  assert.ok(scanText('packages/a/src/example.ts', `// public-tree: synthetic\nconst canary = '${token}';`, config).length);
  assert.ok(scanText('packages/a/test/example.test.ts', `const canary = '${token}';`, config).length);
});

test('check scans untracked files, names and exclusions and refuses symbolic links', t => {
  const dir = scratch(t);
  mkdirSync(join(dir, 'docs/history'), { recursive: true });
  writeFileSync(join(dir, 'docs/history/a.md'), 'Retained record');
  writeFileSync(join(dir, 'untracked.md'), ['person', 'gmail.com'].join('@'));
  symlinkSync('untracked.md', join(dir, 'linked.md'));
  const hits = checkTree(dir, config);
  assert.ok(hits.some(h => h.file === 'linked.md' && h.rule === 'non-regular-file'));
  const command = spawnSync(process.execPath, [join(root, 'scripts/public-tree.mjs'), '--check', dir], { encoding: 'utf8' });
  assert.equal(command.status, 1);
  assert.match(command.stderr, /untracked\.md:1: personal-email/);
  assert.ok(hits.some(h => h.file === 'docs/history/a.md' && h.rule === 'excluded-file'));
  assert.ok(hits.some(h => h.file === 'untracked.md' && h.line === 1));
});

test('export reads HEAD bytes and templates, never dirty, staged, ignored or untracked content', t => {
  const dir = scratch(t), source = join(dir, 'source'), out = join(dir, 'output'); mkdirSync(source);
  const git = (...args) => execFileSync('git', args, { cwd: source, stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.name', 'Synthetic Contributor'); git('config', 'user.email', 'contributor@example.com');
  mkdirSync(join(source, 'scripts')); mkdirSync(join(source, 'public'));
  writeFileSync(join(source, 'scripts/public-tree.json'), JSON.stringify({ exclusions: [], replacements: { 'README.md': 'public/readme.txt' }, forbiddenPatterns: [] }));
  writeFileSync(join(source, 'README.md'), 'private original'); writeFileSync(join(source, 'public/readme.txt'), 'public committed');
  writeFileSync(join(source, 'keep.txt'), 'committed'); writeFileSync(join(source, 'deleted.txt'), 'committed deletion'); writeFileSync(join(source, '.gitignore'), 'ignored.txt\n');
  git('add', '.'); git('commit', '-qm', 'Synthetic fixture');
  writeFileSync(join(source, 'public/readme.txt'), 'dirty template'); writeFileSync(join(source, 'keep.txt'), 'dirty source');
  git('rm', 'deleted.txt');
  writeFileSync(join(source, 'staged.txt'), 'staged'); git('add', 'staged.txt');
  writeFileSync(join(source, 'untracked.txt'), 'untracked'); writeFileSync(join(source, 'ignored.txt'), 'ignored');
  exportTree(source, out);
  assert.equal(readFileSync(join(out, 'README.md'), 'utf8'), 'public committed');
  assert.equal(readFileSync(join(out, 'keep.txt'), 'utf8'), 'committed');
  assert.equal(readFileSync(join(out, 'deleted.txt'), 'utf8'), 'committed deletion');
  for (const file of ['.git', 'staged.txt', 'ignored.txt', 'untracked.txt']) assert.equal(existsSync(join(out, file)), false, file);
  assert.throws(() => exportTree(source, out), /already exists/);
});

test('real committed tree exports and passes the command-line privacy check without installing', t => {
  const out = join(scratch(t), 'output');
  exportTree(root, out);
  const result = spawnSync(process.execPath, [join(root, 'scripts/public-tree.mjs'), '--check', out], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(join(out, 'docs/history')), false);
  assert.equal(existsSync(join(out, '.git')), false);
});
