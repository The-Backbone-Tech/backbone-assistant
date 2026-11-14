import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, fileProblems } from './vocabulary.mjs';
import { repositoryChecks } from './check.mjs';

const problems = (text, file = 'docs/guide.md') => fileProblems(file, text, new Set(text.split('\n').map((_, i) => i + 1)));

test('new prose names the glossary word and location for each retired idea', () => {
  for (const [old, word] of [['standing signature', 'permission'], ['grant', 'permission'], ['held write', 'held action'], ['UNKNOWN', 'unknown outcome'], ['harness', 'engine'], ['data home', 'data folder'], ['AI operating system', 'open-source AI assistant'], ['AI operating platform', 'open-source AI assistant'], ['Backbone is an operating system', 'open-source AI assistant'], ['Backbone is an operating platform', 'open-source AI assistant']]) {
    const found = problems(`Use the ${old} here.`);
    assert.ok(found.some(p => p.includes('docs/guide.md:1:') && p.includes(`use "${word}"`)), old);
  }
});

test('release keeps its ordinary meaning in documents and stays a retired label in the app', () => {
  assert.deepEqual(problems('Each release is installed. A refused restart releases the queue.'), []);
  assert.equal(problems('export const view = <button>Release</button>;', 'packages/surfaces/app/src/Example.tsx').length, 1);
});

test('code, links, history, cryptographic signatures and operating-system homes are exempt', () => {
  assert.deepEqual(problems('`harness-pi` and `UNKNOWN`\n```ts\nconst home = "signature";\n```\n[engine](contracts/harness.md)\nThe operating system home folder.\nVerify the Ed25519 signature.\nThe package release is pinned.\nRelease the lock after closing the descriptor.\nThe client releases its slot when its socket closes.'), []);
  assert.deepEqual(problems('A harness and a grant.', 'docs/history/old.md'), []);
  assert.deepEqual(problems('````ts\n```\nconst home = \"harness\";\n````'), []);
  assert.deepEqual(problems('<code>harness</code>', 'packages/surfaces/app/src/Code.tsx'), []);
});

test('UI text is checked while identifiers, API values and quoted code stay intact', () => {
  const file = 'packages/surfaces/app/src/Example.tsx';
  const source = 'import { harness } from "harness-pi";\nconst signature = "UNKNOWN";\nconst state = { home: "home", release: "release" };\nexport const view = <button title="End signature">Release</button>;\nconst help = "Use `harness-pi` with this data folder.";';
  const found = problems(source, file);
  assert.equal(found.length, 2, found.join('\n'));
  assert.ok(found.every(p => p.includes(':4:') && p.includes('permission')));
  assert.equal(problems('<p>Launch the harness.</p>', 'packages/surfaces/app/index.html').length, 1);
  assert.equal(problems('const label = "Grant";', file).length, 1);
  assert.deepEqual(fileProblems(file, source, new Set([1, 2, 3, 5])), []);
});

test('multiline UI literals check only their changed lines', () => {
  const source = 'const help = `Old harness\nUse this data folder.\nNew standing signature`;';
  assert.deepEqual(fileProblems('packages/surfaces/app/src/help.ts', source, new Set([2])), []);
  assert.equal(fileProblems('packages/surfaces/app/src/help.ts', source, new Set([3])).length, 1);
});

test('git scope covers committed, staged, unstaged and new prose without flagging untouched debt', t => {
  const originalEvent = process.env.GITHUB_EVENT_PATH;
  delete process.env.GITHUB_EVENT_PATH;
  t.after(() => {
    if (originalEvent === undefined) delete process.env.GITHUB_EVENT_PATH;
    else process.env.GITHUB_EVENT_PATH = originalEvent;
  });
  const root = mkdtempSync(join(tmpdir(), 'vocabulary-check-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Vocabulary test');
    mkdirSync(join(root, 'docs')); writeFileSync(join(root, 'README.md'), 'Old harness\n\nPlain words.\n');
    git('add', '.'); git('commit', '-qm', 'baseline'); const base = git('rev-parse', 'HEAD');
    assert.deepEqual(check(root, { base }), []);
    git('update-ref', 'refs/remotes/origin/claude/integration', base);
    assert.deepEqual(check(root), []);
    writeFileSync(join(root, 'README.md'), 'Old harness\n\nNew signature.\n');
    git('add', '.'); git('commit', '-qm', 'changed prose');
    writeFileSync(join(root, 'docs/staged.md'), 'A grant.\n'); git('add', '.');
    writeFileSync(join(root, 'docs/unstaged.md'), 'Plain.\n'); git('add', '.');
    writeFileSync(join(root, 'docs/unstaged.md'), 'A harness.\n');
    writeFileSync(join(root, 'docs/new.md'), 'A data home.\n');
    const found = check(root, { base });
    assert.equal(found.length, 4, found.join('\n'));
    git('update-ref', 'refs/remotes/origin/claude/integration', git('rev-parse', 'HEAD'));
    const eventFile = join(root, '.git/vocabulary-event.json');
    writeFileSync(eventFile, JSON.stringify({ before: base }));
    const previousEvent = process.env.GITHUB_EVENT_PATH;
    try {
      process.env.GITHUB_EVENT_PATH = eventFile;
      assert.deepEqual(check(root), found);
      assert.deepEqual(repositoryChecks(root, {}).vocabulary(), found);
    } finally {
      if (previousEvent === undefined) delete process.env.GITHUB_EVENT_PATH;
      else process.env.GITHUB_EVENT_PATH = previousEvent;
    }
    assert.ok(!found.some(p => p.includes('README.md:1:')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('escaped line breaks in a single source line do not hide later prose', () => {
  const file = 'packages/surfaces/app/src/help.ts';
  assert.equal(fileProblems(file, 'const help = "Hello\\nEnd signature";', new Set([1])).length, 1);
  assert.equal(fileProblems(file, 'const label = "Release";', new Set([1])).length, 1);
});


test('the assistant description preserves platform breadth and the glossary can name retired words', () => {
  assert.deepEqual(problems('Backbone is an open-source AI assistant. Its company platform includes the technical layers.'), []);
  const text = '# Backbone\n\n## Words used here\n\n| Backbone | The open-source AI assistant | AI operating platform |\n| permission | What a person allows | signature, grant, release |';
  assert.deepEqual(problems(text, 'README.md'), []);
});

test('a stack diff and a single-file diff over 1 MiB preserve changed-line checks', t => {
  const originalEvent = process.env.GITHUB_EVENT_PATH;
  delete process.env.GITHUB_EVENT_PATH;
  t.after(() => {
    if (originalEvent === undefined) delete process.env.GITHUB_EVENT_PATH;
    else process.env.GITHUB_EVENT_PATH = originalEvent;
  });
  const root = mkdtempSync(join(tmpdir(), 'vocabulary-large-diff-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: Infinity }).trim();
  const file = 'docs/large explanation.md';
  const lines = 30_000;
  const after = 'After plain words.\n'.repeat(lines);
  try {
    git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Vocabulary test');
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'README.md'), 'Old harness\n');
    writeFileSync(join(root, file), 'Before plain words.\n'.repeat(lines));
    git('add', '.'); git('commit', '-qm', 'baseline');
    const base = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/claude/integration', base);
    writeFileSync(join(root, file), after);
    git('add', '.'); git('commit', '-qm', 'first unit');
    writeFileSync(join(root, 'docs/second.md'), 'Use the permitted action.\n'.repeat(10_000));
    git('add', '.'); git('commit', '-qm', 'second unit');

    const diff = (...paths) => git('diff', '--no-ext-diff', '--no-color', '--unified=0', base, '--', ...paths);
    assert.ok(Buffer.byteLength(diff()) > 1024 * 1024, 'the stack exceeds the old stdout limit');
    assert.ok(Buffer.byteLength(diff(file)) > 1024 * 1024, 'per-file reads also need no fixed small buffer');
    assert.deepEqual(check(root), [], 'large valid edits pass without flagging untouched debt');

    writeFileSync(join(root, file), after + 'Use the harness.\n');
    const found = check(root);
    assert.equal(found.length, 1, found.join('\n'));
    assert.ok(found[0].includes(`${file}:${lines + 1}:`) && found[0].includes('engine'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
