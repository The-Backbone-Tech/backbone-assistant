import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from '@babel/parser';
import { cherryPickUnit, unionJourneyText, unionDependencyText, unionImportText, unionInstalledArgsText } from './lib/merge-queue-mechanical.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'queue-mechanical-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  for (const [key, value] of Object.entries({ 'user.name': 'Test', 'user.email': 'test@example.invalid', 'commit.gpgsign': 'false', 'core.hooksPath': '.hooks' })) git('config', key, value);
  const put = (file, text) => { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), text); };
  put('.gitignore', '.gate/\n');
  put('.hooks/commit-msg', '#!/bin/sh\ngrep -Eq "^Agent: .+" "$1" || exit 1\n'); chmodSync(join(root, '.hooks/commit-msg'), 0o755);
  put('code.ts', 'export const value = 1;\n');
  const commit = message => { git('add', '.'); git('commit', '-qm', message, '--trailer', 'Agent: human'); return git('rev-parse', 'HEAD'); };
  const base = commit('base');
  const unit = (name, changes) => { git('checkout', '-qb', name, base); for (const change of changes) { change(put); commit(name); } const head = git('rev-parse', 'HEAD'); git('checkout', '-q', 'main'); return { name, head }; };
  return { root, git, put, commit, base, unit };
}

const compact = rows => '[\n  {"id":1,"name":"Work","journeys":[' + rows.map(row => JSON.stringify(row)).join(',') + ']}\n]\n';
test('journey three-way merges retain deletions, replace scalar arrays and refuse delete/edit conflicts', () => {
  const keep = { id: 'keep', evidenceRequired: ['a'] }, drop = { id: 'drop' };
  const base = compact([keep, drop]);
  const ours = compact([keep, drop, { id: 'new' }]);
  const theirs = compact([{ ...keep, evidenceRequired: ['b'] }]);
  const merged = JSON.parse(unionJourneyText(base, [ours, theirs], { formatText: ours }));
  assert.deepEqual(merged[0].journeys, [{ ...keep, evidenceRequired: ['b'] }, { id: 'new' }]);
  assert.throws(() => unionJourneyText(base, [compact([keep, { ...drop, sentence: 'edited' }]), theirs]), /conflict|judgement/i);
  assert.deepEqual(JSON.parse(unionJourneyText(base, ['[]\n'])), []);
});

for (const conflicting of [false, true]) test(`real cherry-pick preserves journey deletion and replacement (${conflicting ? 'conflicting' : 'clean'})`, t => {
  const f = fixture(t), keep = { id: 'keep', evidenceRequired: ['a'] };
  f.put('docs/journeys.json', compact([keep, { id: 'drop' }])); const base = f.commit('catalogue');
  f.git('checkout', '-qb', 'unit', base);
  f.put('docs/journeys.json', compact([{ ...keep, evidenceRequired: ['b'] }])); const head = f.commit('retire and replace');
  f.git('checkout', '-q', 'main');
  if (conflicting) f.put('docs/journeys.json', compact([keep, { id: 'drop' }, { id: 'new' }]));
  else f.put('unrelated', 'integration\n');
  const start = f.commit('integration');
  const picked = cherryPickUnit(f.root, { name: 'unit', head }, { base: start });
  assert.deepEqual(picked.conflicts, []);
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'docs/journeys.json')))[0].journeys,
    [{ ...keep, evidenceRequired: ['b'] }, ...(conflicting ? [{ id: 'new' }] : [])]);
  assert.notEqual(picked.head, start);
});

test('dependency three-way merges remove names, accept one-sided bumps and refuse deletion against edits', () => {
  const text = dependencies => JSON.stringify({ dependencies });
  const base = text({ a: '1.0.0', b: '1.0.0' });
  for (const [ours, theirs] of [[{ a: '1.0.0', b: '1.0.0', c: '1.0.0' }, { a: '2.0.0' }], [{ a: '2.0.0' }, { a: '1.0.0', b: '1.0.0', c: '1.0.0' }]]) {
    assert.deepEqual(JSON.parse(unionDependencyText(base, text(ours), text(theirs))).dependencies, { a: '2.0.0', c: '1.0.0' });
  }
  assert.throws(() => unionDependencyText(base, text({ a: '1.0.0' }), text({ a: '1.0.0', b: '2.0.0' })), /conflict/i);
});

test('import three-way merges preserve removed specifiers and side effects as absent', () => {
  const base = "import './side';\nimport { a, b } from 'work';\nexport const value = a;\n";
  const ours = base.replace('{ a, b }', '{ a, b, c }');
  const theirs = base.replace("import './side';\n", '').replace('{ a, b }', '{ a }');
  const merged = unionImportText(base, ours, theirs);
  const imports = parse(merged, { sourceType: 'module' }).program.body.filter(node => node.type === 'ImportDeclaration');
  assert.deepEqual(imports.map(node => node.source.value), ['work']);
  assert.deepEqual(imports.flatMap(node => node.specifiers.map(specifier => specifier.local.name)), ['a', 'c']);
  assert.throws(() => unionImportText(base, base.replace('{ a, b }', '{ a }'), base.replace('{ a, b }', '{ a, other as b }')), /conflict/i);
  assert.throws(() => unionImportText(base, base.replace('{ a, b }', '{ a, other as b }'), base.replace('{ a, b }', '{ a, type b }')), /conflict/i);
});
test('compact journeys round-trip byte-exact and additions preserve existing compact entries', () => {
  const base = '[\n  {"id":1,"name":"Work","journeys":[{"id":"a", "sentence":"A"}]}\n]\n';
  assert.equal(unionJourneyText(base, [base]), base);
  const ours = compact([{ id: 'a', sentence: 'A', evidenceRequired: 'package-test' }, { id: 'b', sentence: 'B' }]);
  const theirs = compact([{ id: 'a', sentence: 'A' }, { id: 'c', sentence: 'C' }]);
  const text = unionJourneyText(base, [ours, theirs]);
  assert.ok(text.includes('"id":"a", "sentence":"A"'));
  assert.deepEqual(JSON.parse(text)[0].journeys.map(journey => journey.id), ['a', 'b', 'c']);
  assert.ok(!text.includes('\n    "id"'));
});

test('legacy journey schema and installed claims from fake-agent proofs need judgement', () => {
  const base = compact([{ id: 'a', sentence: 'A' }]);
  for (const journey of [
    { id: 'old', level: 'package-test', supportingTests: ['fake.test.ts'] },
    { id: 'old-proof', provingTest: { file: 'fake.test.ts', name: 'works', level: 'package-test' } },
    { id: 'fake', requiresInstalled: true, provingTest: { file: 'packages/platform/test/fake-agent.test.ts', suite: 'platform', name: 'fake' } },
  ]) assert.throws(() => unionJourneyText(base, [compact([journey])]), /judgement/i);
  const oldBase = compact([{ id: 'old', level: 'package-test' }]);
  assert.equal(unionJourneyText(oldBase, [oldBase]), oldBase);
});

test('dependency maps union only compatible versions and refuse conflicting nondependency fields', () => {
  const base = '{"name":"work","scripts":{"test":"node --test"},"dependencies":{"a":"1.0.0"}}\n';
  const ours = '{"name":"work","scripts":{"test":"node --test"},"dependencies":{"a":"1.0.0","b":"2.0.0"}}\n';
  const theirs = '{"name":"work","scripts":{"test":"node --test"},"dependencies":{"a":"1.0.0","c":"3.0.0"}}\n';
  assert.deepEqual(JSON.parse(unionDependencyText(base, ours, theirs)).dependencies, { a: '1.0.0', b: '2.0.0', c: '3.0.0' });
  assert.throws(() => unionDependencyText(base, ours.replace('"a":"1.0.0"', '"a":"2.0.0"'), theirs.replace('"a":"1.0.0"', '"a":"4.0.0"')), /conflict/i);
  assert.throws(() => unionDependencyText(base, ours.replace('node --test', 'ours'), theirs.replace('node --test', 'theirs')), /conflict/i);
});

test('import-only blocks union named bindings while executable conflicts stay with the author', () => {
  const base = "import { a } from 'work';\nexport const value = a;\n";
  const ours = base.replace('{ a }', '{ a, b }');
  const theirs = base.replace('{ a }', '{ a, c }');
  const text = unionImportText(base, ours, theirs);
  assert.ok(text.includes('a, b, c')); assert.ok(text.includes('export const value = a;'));
  assert.throws(() => unionImportText(base, ours.replace('value = a', 'value = b'), theirs.replace('value = a', 'value = c')), /conflict/i);
  assert.throws(() => unionImportText(base, ours.replace('{ a, b }', '{ mine as a, b }'), theirs.replace('{ a, c }', '{ other as a, c }')), /binding|conflict/i);
});

test('installed regex alternations union while unrelated constant conflicts stay unresolved', () => {
  const base = "export const INSTALLED_TEST_ARGS = ['test', 'e2e/(?:one)\\\\.spec\\\\.ts$'] as const;\nexport const other = 1;\n";
  const ours = base.replace('(?:one)', '(?:one|two)');
  const theirs = base.replace('(?:one)', '(?:one|three)');
  const text = unionInstalledArgsText(base, ours, theirs);
  assert.ok(text.includes('(?:one|three|two)'));
  assert.doesNotThrow(() => parse(text, { sourceType: 'module', plugins: ['typescript'] }));
  assert.throws(() => unionInstalledArgsText(base, ours.replace('other = 1', 'other = 2'), theirs.replace('other = 1', 'other = 3')), /conflict/i);
});

test('candidate cherry-picks the unit range with one parent and runs the Agent commit hook', t => {
  const f = fixture(t), unit = f.unit('unit', [put => put('first', 'one\n'), put => put('second', 'two\n')]);
  f.put('integrated', 'already present\n'); const integrationBase = f.commit('integration');
  const result = cherryPickUnit(f.root, unit, { base: integrationBase });
  assert.deepEqual(result.conflicts, []); assert.equal(result.picked.length, 2);
  assert.equal(f.git('rev-list', '--count', `${integrationBase}..HEAD`), '2');
  assert.equal(f.git('rev-list', '--min-parents=2', `${integrationBase}..HEAD`), '');
  assert.ok(f.git('log', '-1', '--format=%B').includes('Agent: human'));
  assert.ok(f.git('log', '-1', '--format=%B').endsWith('Agent: human'));
  assert.equal(f.git('show', 'HEAD:integrated'), 'already present');
});

test('textual conflicts return exact paths and roll the whole unit back', t => {
  const f = fixture(t), unit = f.unit('unit', [put => put('first', 'picked then undone\n'), put => put('code.ts', 'export const value = 2;\n')]);
  f.put('code.ts', 'export const value = 3;\n'); const start = f.commit('integration');
  const result = cherryPickUnit(f.root, unit, { base: start });
  assert.deepEqual(result.conflicts, ['code.ts']); assert.equal(f.git('rev-parse', 'HEAD'), start);
  assert.equal(f.git('status', '--porcelain'), '');
  assert.throws(() => f.git('show', 'HEAD:first'));
});

test('generated files take the unit side, dependency unions request relocking and authored manifests are retained', t => {
  const f = fixture(t);
  f.put('.dockerignore', 'base\n'); f.put('package.json', '{"name":"work","dependencies":{"a":"1.0.0"}}\n');
  f.commit('metadata'); const base = f.git('rev-parse', 'HEAD');
  f.git('checkout', '-qb', 'unit', base); f.put('.dockerignore', 'unit\n'); f.put('package.json', '{"name":"work","dependencies":{"a":"1.0.0","c":"3.0.0"}}\n'); const head = f.commit('unit');
  f.git('checkout', '-q', 'main'); f.put('.dockerignore', 'integration\n'); f.put('package.json', '{"name":"work","dependencies":{"a":"1.0.0","b":"2.0.0"}}\n'); const start = f.commit('integration');
  const result = cherryPickUnit(f.root, { name: 'unit', head }, { base: start });
  assert.deepEqual(result.conflicts, []); assert.equal(result.needsRelock, true);
  assert.equal(readFileSync(join(f.root, '.dockerignore'), 'utf8'), 'unit\n');
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'package.json'))).dependencies, { a: '1.0.0', b: '2.0.0', c: '3.0.0' });
});

test('journey schema judgement returns the entry and leaves the candidate unchanged', t => {
  const f = fixture(t), unit = f.unit('unit', [put => put('docs/journeys.json', compact([{ id: 'old', level: 'package-test' }]))]);
  const result = cherryPickUnit(f.root, unit, { base: f.base });
  assert.equal(result.judgement[0].id, 'old'); assert.equal(f.git('rev-parse', 'HEAD'), f.base);
  assert.equal(f.git('status', '--porcelain'), '');
});

test('current proof levels and deliberately partial supporting evidence do not trigger legacy alignment', () => {
  const base = compact([]);
  const entry = { id: 'current', evidenceRequired: 'installed', provingTest: { file: 'packages/platform/test/work.test.ts', name: 'works', suite: 'platform', level: 'test' }, supportingTests: [{ file: 'support.test.ts', name: 'support', level: 'test' }] };
  const text = compact([entry]);
  assert.deepEqual(JSON.parse(unionJourneyText(base, [text]))[0].journeys, [entry]);
});

test('import blocks preserve alias replacement alongside independent namespace and named additions', () => {
  const base = "import First from 'work';\nexport const value = 1;\n";
  const ours = "import First from 'work';\nimport * as Namespace from 'work';\nexport const value = 1;\n";
  const theirs = "import Second from 'work';\nimport { named } from 'work';\nexport const value = 1;\n";
  const text = unionImportText(base, ours, theirs);
  for (const name of ['Second', 'Namespace', 'named']) assert.ok(text.includes(name));
  assert.ok(!text.includes('First'));
});

test('authored manifest conflicts return the unit and never discard capabilities', t => {
  const f = fixture(t);
  const file = 'packages/a/backbone.module.json';
  f.put(file, '{"id":"a","digest":"base","capabilities":{"operations":["base"]}}\n'); f.commit('manifest'); const base = f.git('rev-parse', 'HEAD');
  f.git('checkout', '-qb', 'unit', base); f.put(file, '{"id":"a","digest":"unit","capabilities":{"operations":["unit"]}}\n'); const head = f.commit('unit');
  f.git('checkout', '-q', 'main'); f.put(file, '{"id":"a","digest":"integration","capabilities":{"operations":["integration"]}}\n'); const start = f.commit('integration');
  const result = cherryPickUnit(f.root, { name: 'unit', head }, { base: start });
  assert.deepEqual(result.conflicts, [file]); assert.equal(f.git('rev-parse', 'HEAD'), start);
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, file))).capabilities.operations, ['integration']);
});

test('missing Agent trailers and merge ranges are returned before stacking', t => {
  const f = fixture(t);
  f.git('checkout', '-qb', 'unit', f.base); f.put('unit', 'one\n'); f.git('add', '.');
  // This deliberately creates an old commit without a trailer; the candidate hook remains enabled.
  f.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'old unreviewed commit'); const head = f.git('rev-parse', 'HEAD'); f.git('checkout', '-q', 'main');
  const result = cherryPickUnit(f.root, { name: 'unit', head }, { base: f.base });
  assert.ok(result.reason.includes('Agent trailer')); assert.equal(f.git('rev-parse', 'HEAD'), f.base);
});

test('an import block added independently to a previously import-free file is mechanical', () => {
  const base = 'export const value = 1;\n';
  const text = unionImportText(base, "import { a } from 'work';\n" + base, "import { b } from 'work';\n" + base);
  assert.ok(text.includes('a, b')); assert.ok(text.includes(base));
});

test('duplicate JSON fields and edited legacy proof levels require an explicit alignment', () => {
  const base = compact([{ id: 'a', sentence: 'A' }]);
  assert.throws(() => unionJourneyText(base, ['[{"id":1,"journeys":[{"id":"a","sentence":"first","sentence":"second"}]}]']), /duplicate/i);
  const before = compact([{ id: 'old', provingTest: { file: 'old.test.ts', name: 'works', level: 'package-test' } }]);
  assert.equal(unionJourneyText(before, [before]), before);
  assert.throws(() => unionJourneyText(before, [before.replace('"works"', '"new work"')]), /judgement/i);
});

test('digest-only manifest conflicts preserve authored declarations and take the unit digest for regen', t => {
  const f = fixture(t), file = 'packages/a/backbone.module.json';
  const manifest = digest => JSON.stringify({ id: 'a', digest, capabilities: { operations: ['preserved'] }, dependsOn: [{ name: 'dep', version: '1.0.0', licence: 'MIT' }] }) + '\n';
  f.put(file, manifest('base')); f.commit('manifest'); const base = f.git('rev-parse', 'HEAD');
  f.git('checkout', '-qb', 'unit', base); f.put(file, manifest('unit')); const head = f.commit('unit');
  f.git('checkout', '-q', 'main'); f.put(file, manifest('integration')); const start = f.commit('integration');
  const result = cherryPickUnit(f.root, { name: 'unit', head }, { base: start });
  assert.deepEqual(result.conflicts, []); assert.equal(result.needsRegeneration, true);
  assert.equal(readFileSync(join(f.root, file), 'utf8'), manifest('unit'));
});

test('the candidate commit-msg hook may refuse a cherry-picked source and causes whole-unit rollback', t => {
  const f = fixture(t);
  f.put('.hooks/commit-msg', '#!/bin/sh\ngrep -q "candidate-refuses" "$1" && exit 1\ngrep -Eq "^Agent: .+" "$1" || exit 1\n'); f.commit('candidate policy'); const base = f.git('rev-parse', 'HEAD');
  f.git('checkout', '-qb', 'unit', base); f.put('unit', 'one\n'); f.git('add', '.');
  f.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'candidate-refuses', '--trailer', 'Agent: human'); const head = f.git('rev-parse', 'HEAD'); f.git('checkout', '-q', 'main');
  const result = cherryPickUnit(f.root, { name: 'unit', head }, { base });
  assert.ok(result.reason.includes('Commit hook')); assert.equal(f.git('rev-parse', 'HEAD'), base); assert.equal(f.git('status', '--porcelain'), '');
});

test('a TypeScript file may mechanically union both imports and installed regex alternatives together', t => {
  const f = fixture(t), file = 'installed.ts';
  const baseText = "import { a } from 'work';\nexport const INSTALLED_TEST_ARGS = ['test', 'e2e/(?:one)\\\\.spec\\\\.ts$'] as const;\nexport const value = a;\n";
  f.put(file, baseText); f.commit('installed'); const base = f.git('rev-parse', 'HEAD');
  f.git('checkout', '-qb', 'unit', base); f.put(file, baseText.replace('{ a }', '{ a, c }').replace('(?:one)', '(?:one|three)')); const head = f.commit('unit');
  f.git('checkout', '-q', 'main'); f.put(file, baseText.replace('{ a }', '{ a, b }').replace('(?:one)', '(?:one|two)')); const start = f.commit('integration');
  const result = cherryPickUnit(f.root, { name: 'unit', head }, { base: start });
  assert.deepEqual(result.conflicts, []);
  const text = readFileSync(join(f.root, file), 'utf8'); assert.ok(text.includes('a, b, c')); assert.ok(text.includes('(?:one|three|two)'));
});

test('a union cannot retain an installed flag while replacing its proof with fake-agent evidence', () => {
  const base = compact([{ id: 'installed', requiresInstalled: true, evidenceRequired: 'installed', provingTest: { file: 'packages/surfaces/app/e2e/work.electron.spec.ts', name: 'installed work', suite: 'app-e2e', level: 'installed' } }]);
  const changed = compact([{ id: 'installed', evidenceRequired: 'installed', provingTest: { file: 'packages/platform/test/fake-agent.test.ts', name: 'seeded fake agent', suite: 'platform', level: 'test' } }]);
  assert.throws(() => unionJourneyText(base, [changed]), error => /judgement/i.test(error.message) && error.judgement.some(entry => entry.id === 'installed' && entry.previous?.requiresInstalled === true));
});

test('dropping an installed guarantee or weakening required evidence and proof needs judgement', () => {
  const proof = { file: 'packages/surfaces/app/e2e/work.electron.spec.ts', name: 'installed work', suite: 'app-e2e', level: 'installed' };
  const original = { id: 'installed', requiresInstalled: true, evidenceRequired: 'installed', provingTest: proof };
  const { requiresInstalled, ...withoutFlag } = original;
  const fake = { file: 'packages/platform/test/fake-agent.test.ts', name: 'seeded fake agent', suite: 'platform', level: 'test' };
  for (const entry of [withoutFlag, { ...withoutFlag, provingTest: fake }, { ...withoutFlag, evidenceRequired: 'test', provingTest: fake },
    { ...original, requiresInstalled: false }, { ...original, evidenceRequired: 'test' }]) {
    assert.throws(() => unionJourneyText(compact([original]), [compact([entry])]), error =>
      Array.isArray(error.judgement) && error.judgement.some(item => item.id === 'installed'));
  }
  const real = { id: 'real', evidenceRequired: 'real use', provingTest: { ...fake, level: 'real use' } };
  for (const entry of [{ ...real, evidenceRequired: 'test' }, { ...real, provingTest: fake }, { ...real, provingTest: { ...real.provingTest, scope: 'partial' } }]) {
    assert.throws(() => unionJourneyText(compact([real]), [compact([entry])]), error => Array.isArray(error.judgement));
  }
});

for (const conflicting of [false, true]) test(`a real ${conflicting ? 'conflicting' : 'clean'} pick returns a dropped installed guarantee`, t => {
  const f = fixture(t), original = { id: 'installed', requiresInstalled: true, evidenceRequired: 'installed', provingTest: {
    file: 'packages/surfaces/app/e2e/work.electron.spec.ts', name: 'installed work', suite: 'app-e2e', level: 'installed' } };
  f.put('docs/journeys.json', compact([original])); const base = f.commit('installed catalogue');
  f.git('checkout', '-qb', 'unit', base);
  f.put('docs/journeys.json', compact([{ id: 'installed', evidenceRequired: 'test', provingTest: {
    file: 'packages/platform/test/fake-agent.test.ts', name: 'seeded fake agent', suite: 'platform', level: 'test' } }])); const head = f.commit('drop guarantee');
  f.git('checkout', '-q', 'main');
  if (conflicting) f.put('docs/journeys.json', compact([original, { id: 'added' }]));
  else f.put('independent', 'integration\n');
  const start = f.commit('integration'), picked = cherryPickUnit(f.root, { name: 'unit', head }, { base: start });
  assert.ok(picked.judgement.some(entry => entry.id === 'installed'));
  assert.equal(f.git('rev-parse', 'HEAD'), start); assert.equal(f.git('status', '--porcelain'), '');
});

test('clean pick validates its edits against integration without blaming unrelated legacy changes', t => {
  const f = fixture(t);
  const catalogue = (old, current) => '[\n' + JSON.stringify({ id: 1, journeys: [{ id: 'old', level: 'package-test', sentence: old }] }) + ',\n\n\n\n' +
    JSON.stringify({ id: 2, journeys: [{ id: 'current', sentence: current }] }) + '\n]\n';
  f.put('docs/journeys.json', catalogue('before', 'before')); const base = f.commit('catalogue');
  f.git('checkout', '-qb', 'unit', base); f.put('docs/journeys.json', catalogue('before', 'unit')); const head = f.commit('current entry');
  f.git('checkout', '-q', 'main'); f.put('docs/journeys.json', catalogue('integration', 'before')); const start = f.commit('legacy edit');
  const picked = cherryPickUnit(f.root, { name: 'unit', head }, { base: start });
  assert.deepEqual(picked.conflicts, []); assert.equal(picked.judgement, undefined);
  assert.equal(readFileSync(join(f.root, 'docs/journeys.json'), 'utf8'), catalogue('integration', 'unit'));
});

test('conflicted id-array reorders return to the author rather than silently restoring base order', () => {
  const a = { id: 'a', sentence: 'A' }, b = { id: 'b', sentence: 'B' }, base = compact([a, b]);
  const reorder = compact([b, a]), edit = compact([{ ...a, sentence: 'edited' }, b]);
  for (const variants of [[reorder, edit], [edit, reorder]]) assert.throws(() => unionJourneyText(base, variants), /reorder/i);
});

test('a clean cherry-picked reorder keeps its exact authored bytes', t => {
  const f = fixture(t), a = { id: 'a' }, b = { id: 'b' }, reordered = compact([b, a]);
  f.put('docs/journeys.json', compact([a, b])); const base = f.commit('catalogue');
  f.git('checkout', '-qb', 'unit', base); f.put('docs/journeys.json', reordered); const head = f.commit('reorder');
  f.git('checkout', '-q', 'main');
  assert.deepEqual(cherryPickUnit(f.root, { name: 'unit', head }, { base }).conflicts, []);
  assert.equal(readFileSync(join(f.root, 'docs/journeys.json'), 'utf8'), reordered);
});

test('legacy fields retained by a union still require explicit schema alignment', () => {
  const base = compact([{ id: 'old', level: 'package-test', supportingTests: [{ file: 'old.test.ts', name: 'old' }] }]);
  const current = compact([{ id: 'old', evidenceRequired: 'test', provingTest: { file: 'new.test.ts', name: 'new', suite: 'check', level: 'test' } }]);
  assert.throws(() => unionJourneyText(base, [current]), error => /judgement/i.test(error.message) && error.judgement.some(entry => entry.id === 'old' && entry.previous?.level === 'package-test'));
});
