import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureTree, packageInput, suiteInput, publishGate, findGatePass, gateResults } from './test-results.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'gate-results-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lock one');
  writeFileSync(join(root, '.gitattributes'), '*.sql text eol=lf');
  writeFileSync(join(root, '.gitignore'), 'store/\nfirst/\nnext/\ngate/\n');
  for (const name of ['a', 'b', 'other']) {
    mkdirSync(join(root, 'packages', name), { recursive: true });
    writeFileSync(join(root, 'packages', name, 'package.json'), JSON.stringify({ name, dependencies: name === 'a' ? { b: 'workspace:*' } : {}, scripts: { test: 'node --test' } }));
    writeFileSync(join(root, 'packages', name, 'source'), name);
  }
  const suite = { name: 'a', command: 'pnpm', args: ['--filter', 'a', 'test'] };
  const versions = { node: 'v22.1.0', pnpm: '10.1.0' };
  return { root, suite, versions, input: () => packageInput(root, captureTree(root), suite, versions) };
}

test('package keys cover dependencies, lockfile, versions and exact commands, excluding unrelated packages', t => {
  const f = fixture(t), original = f.input().key;
  writeFileSync(join(f.root, 'packages/other/source'), 'unrelated');
  assert.equal(f.input().key, original);
  for (const file of ['packages/b/source', 'pnpm-lock.yaml', '.gitattributes']) {
    const at = join(f.root, file), before = readFileSync(at);
    writeFileSync(at, 'changed'); assert.notEqual(f.input().key, original); writeFileSync(at, before);
  }
  const tree = captureTree(f.root);
  for (const versions of [{ ...f.versions, node: 'v23.0.0' }, { ...f.versions, pnpm: '11.0.0' }]) assert.notEqual(packageInput(f.root, tree, f.suite, versions).key, original);
  assert.notEqual(packageInput(f.root, tree, { ...f.suite, args: [...f.suite.args, '--flag'] }, f.versions).key, original);
  assert.equal(packageInput(f.root, tree, { name: 'check', command: 'pnpm', args: ['check'] }, f.versions), null);
  assert.equal(packageInput(f.root, tree, { name: 'app-e2e', command: 'pnpm', args: ['--filter', 'a', 'e2e'] }, f.versions), null);
});

test('only finalized clean GATE passes populate the store; authors cannot replace them', t => {
  const f = fixture(t), input = f.input(), store = join(f.root, 'store'), run = join(f.root, 'gate');
  mkdirSync(run); writeFileSync(join(run, 'a.log'), 'ok 1 - completes work\n');
  const entry = { name: 'a', command: 'pnpm --filter a test', status: 'completed', exitCode: 0, failed: 0, passed: 1, inputKey: input.key };
  const gate = { kind: 'gate', dirty: false, end: 'done', suites: [entry] };
  const save = record => writeFileSync(join(run, 'gate.json'), JSON.stringify(record));
  save({ ...gate, kind: 'author' }); assert.equal(publishGate(store, run), 0);
  save({ ...gate, end: null }); assert.equal(publishGate(store, run), 0);
  save({ ...gate, dirty: true }); assert.equal(publishGate(store, run), 0);
  save(gate); assert.equal(publishGate(store, run), 1);
  assert.equal(findGatePass(store, input)?.run, run);
  save({ ...gate, kind: 'author' }); assert.equal(publishGate(store, run), 0);
  assert.equal(findGatePass(store, input), null, 'the authoritative record is revalidated');
  save(gate); writeFileSync(join(run, 'a.log'), 'tampered'); assert.equal(findGatePass(store, input), null);
});

test('lookup retains the exact validated log bytes when its source is later replaced', t => {
  const f = fixture(t), input = f.input(), store = join(f.root, 'store'), run = join(f.root, 'gate');
  mkdirSync(run); writeFileSync(join(run, 'a.log'), 'original proof');
  writeFileSync(join(run, 'gate.json'), JSON.stringify({ kind: 'gate', dirty: false, end: 'done', suites: [
    { name: 'a', command: 'pnpm --filter a test', status: 'completed', exitCode: 0, inputKey: input.key },
  ] }));
  publishGate(store, run);
  const found = findGatePass(store, input);
  writeFileSync(join(run, 'a.log'), 'replaced proof');
  assert.equal(found.logBytes?.toString(), 'original proof');
  assert.equal(findGatePass(store, input), null);
});

test('gate adapter copies proven logs, records provenance and never reuses mandatory suites', t => {
  const f = fixture(t), store = join(f.root, 'store'), run = join(f.root, 'first'), next = join(f.root, 'next');
  mkdirSync(run); mkdirSync(next);
  const previous = process.env.BACKBONE_TEST_RESULTS; process.env.BACKBONE_TEST_RESULTS = store;
  t.after(() => { if (previous === undefined) delete process.env.BACKBONE_TEST_RESULTS; else process.env.BACKBONE_TEST_RESULTS = previous; });
  const record = { kind: 'gate', dirty: false, node: f.versions.node, pnpm: f.versions.pnpm, end: null, suites: [] };
  const first = gateResults(f.root, record, run), entry = { name: 'a', command: 'pnpm --filter a test' };
  record.suites.push(entry); assert.equal(first.reuse(f.suite, entry), null);
  Object.assign(entry, { status: 'completed', exitCode: 0, passed: 1, failed: 0 }); record.end = 'done';
  writeFileSync(join(run, 'a.log'), 'ok 1 - finishes\n');
  const mandatory = { name: 'check', command: 'pnpm', args: ['check'] }, checkEntry = { name: 'check', command: 'pnpm check' };
  record.suites.push(checkEntry); assert.equal(first.reuse(mandatory, checkEntry), null);
  Object.assign(checkEntry, { status: 'completed', exitCode: 0, passed: 1, failed: 0 });
  writeFileSync(join(run, 'check.log'), 'ok 1 - checks\n'); first.publish();
  assert.ok(findGatePass(store, suiteInput(f.root, captureTree(f.root), mandatory, f.versions)), 'authors can reuse mandatory-suite evidence');
  assert.equal(suiteInput(f.root, captureTree(f.root), { ...f.suite, name: 'app-installed' }, f.versions), null, 'installed evidence is never reusable, including by authors');
  const second = gateResults(f.root, { ...record, suites: [] }, next), reused = second.reuse(f.suite, {});
  assert.equal(reused.reusedFrom, run); assert.match(reused.reuse, /reused from/);
  assert.equal(readFileSync(join(next, 'a.log'), 'utf8'), 'ok 1 - finishes\n');
  for (const name of ['check', 'oracle', 'app-e2e', 'app-installed', 'native']) assert.equal(second.reuse({ ...f.suite, name }, {}), null);
  writeFileSync(join(f.root, 'packages/b/source'), 'new dependency');
  assert.equal(second.reuse(f.suite, {}), null);
});

test('workspace dependency closure includes transitive development and peer cycles', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'packages/b/package.json'), JSON.stringify({ name: 'b', devDependencies: { other: 'workspace:*' } }));
  writeFileSync(join(f.root, 'packages/other/package.json'), JSON.stringify({ name: 'other', peerDependencies: { a: 'workspace:*' } }));
  const input = f.input();
  assert.deepEqual(input.input.trees.map(t => t.package), ['a', 'b', 'other']);
  writeFileSync(join(f.root, 'packages/other/source'), 'transitive change');
  assert.notEqual(f.input().key, input.key);
});

test('Platform source audits invalidate on packages outside declared dependencies', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'packages/b/package.json'), JSON.stringify({ name: '@backbone-next/platform' }));
  writeFileSync(join(f.root, 'packages/a/package.json'), JSON.stringify({ name: 'a', dependencies: { '@backbone-next/platform': 'workspace:*' } }));
  const input = f.input();
  writeFileSync(join(f.root, 'packages/other/source'), 'new audited caller');
  assert.notEqual(f.input().key, input.key);
});

test('Platform contract tests and Core legacy fixtures invalidate outside their package trees', t => {
  const f = fixture(t);
  const contract = join(f.root, 'docs/contracts/connectors.md');
  mkdirSync(join(f.root, 'docs/contracts'), { recursive: true }); writeFileSync(contract, 'first contract');
  writeFileSync(join(f.root, 'packages/b/package.json'), JSON.stringify({ name: '@backbone-next/platform' }));
  writeFileSync(join(f.root, 'packages/a/package.json'), JSON.stringify({ name: 'a', dependencies: { '@backbone-next/platform': 'workspace:*' } }));
  const platform = f.input(); writeFileSync(contract, 'changed contract');
  assert.notEqual(f.input().key, platform.key);
  writeFileSync(join(f.root, 'packages/b/package.json'), JSON.stringify({ name: '@backbone/core' }));
  writeFileSync(join(f.root, 'packages/a/package.json'), JSON.stringify({ name: 'a', dependencies: { '@backbone/core': 'workspace:*' } }));
  const fixtures = join(f.root, 'packages/platform/test/fixtures'); mkdirSync(fixtures, { recursive: true });
  const legacy = join(fixtures, 'material-guard-legacy.json'); writeFileSync(legacy, 'first fixture');
  const core = f.input(); writeFileSync(legacy, 'changed fixture');
  assert.notEqual(f.input().key, core.key);
});

test('author lookup leaves the index and permanent object database untouched', t => {
  const f = fixture(t);
  const git = (...args) => execFileSync('git', args, { cwd: f.root, encoding: 'utf8' });
  const before = git('count-objects', '-v');
  writeFileSync(join(f.root, 'private.env'), 'fixture-only-value');
  assert.ok(f.input().key);
  assert.equal(git('count-objects', '-v'), before);
  assert.equal(git('ls-files'), '');
});

test('installed acceptance cannot enter the store even with an old reusable input key', t => {
  const f = fixture(t), store = join(f.root, 'store'), run = join(f.root, 'gate');
  mkdirSync(run); writeFileSync(join(run, 'app-installed.log'), '  1 passed (1s)');
  writeFileSync(join(run, 'gate.json'), JSON.stringify({ kind: 'gate', dirty: false, end: 'done', suites: [
    { name: 'app-installed', command: 'pnpm --filter a test', status: 'completed', exitCode: 0, inputKey: f.input().key },
  ] }));
  assert.equal(publishGate(store, run), 0);
  assert.equal(findGatePass(store, f.input()), null);
});
