import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manifestProblems, digestOf } from './manifests.mjs';
import { regenerate, generators } from './regen.mjs';
import { BEGIN, END } from './module-readme.mjs';
import { listFiles } from './lib/repo.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'manifest-fields-')), dir = 'packages/modules/demo';
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  mkdirSync(join(root, dir, 'test'), { recursive: true }); mkdirSync(join(root, 'schemas'));
  cpSync(new URL('../schemas/backbone.module.schema.json', import.meta.url), join(root, 'schemas/backbone.module.schema.json'));
  const pkg = { name: 'demo', version: '1.0.0', license: 'Apache-2.0', backbone: { layer: 'modules' }, dependencies: { retained: '1.2.3', minisearch: '7.2.0', workspace: 'workspace:*' } };
  const manifest = { manifest: 1, id: 'io.github.someone/demo', kind: 'module', version: pkg.version, licence: pkg.license,
    publisher: { name: 'Someone', namespace: 'io.github.someone', verification: { method: 'github', status: 'pending' } },
    provides: [], consumes: [], stability: 'experimental', capabilities: { planes: ['personal'], effectClasses: [], operations: [], network: [], secrets: 'none' },
    data: { owns: [], migrations: [], export: 'nothing' }, dependsOn: [{ name: 'retained', version: '1.2.3', licence: 'MIT' }, { name: 'minisearch', version: '7.2.0' }, { name: 'workspace', version: 'workspace' }],
    conformance: { suite: [`${dir}/test/demo.test.ts`], quality: { level: 'bronze', exemptions: [] } }, removal: { refusedWhileUnknown: true, rule: 'always' }, digest: `sha256:${'0'.repeat(64)}` };
  const path = join(root, dir, 'backbone.module.json'), packagePath = join(root, dir, 'package.json'), readme = join(root, dir, 'README.md');
  writeFileSync(packagePath, JSON.stringify(pkg)); writeFileSync(path, JSON.stringify(manifest));
  writeFileSync(join(root, dir, 'test/demo.test.ts'), ''); writeFileSync(readme, `Human introduction\n${BEGIN}\n${END}\nHuman conclusion\n`);
  const steps = generators.filter(g => ['manifest-fields', 'module-readme', 'manifests'].includes(g.name));
  const run = () => regenerate(root, steps), check = () => manifestProblems(root, listFiles(root));
  run();
  return { root, dir, path, packagePath, readme, pkg, manifest, run, check, read: () => JSON.parse(readFileSync(path, 'utf8')), put: value => writeFileSync(path, JSON.stringify(value, null, 2) + '\n') };
}

test('a lost dependency is rejected independently of its digest and one regen restores it', t => {
  const f = fixture(t), before = f.read();
  f.put({ ...before, dependsOn: before.dependsOn.filter(d => d.name !== 'minisearch') });
  f.put({ ...f.read(), digest: digestOf(f.root, f.dir) });
  assert.ok(f.check().some(p => p.includes('minisearch') || p.includes('dependsOn')));
  f.run();
  const restored = f.read();
  assert.deepEqual(restored.dependsOn, before.dependsOn);
  assert.deepEqual(restored.capabilities, before.capabilities); assert.deepEqual(restored.conformance, before.conformance);
  assert.deepEqual(f.check(), []); assert.equal(restored.digest, digestOf(f.root, f.dir));
  const readme = readFileSync(f.readme, 'utf8'); assert.ok(readme.includes('minisearch')); assert.ok(readme.startsWith('Human introduction\n')); assert.ok(readme.endsWith('Human conclusion\n'));
  const bytes = readFileSync(f.path, 'utf8'); f.run(); assert.equal(readFileSync(f.path, 'utf8'), bytes); assert.equal(readFileSync(f.readme, 'utf8'), readme);
});

test('regen replaces stale source-derived fields and retains only matching reviewed licence annotations', t => {
  const f = fixture(t);
  writeFileSync(f.packagePath, JSON.stringify({ ...f.pkg, version: '2.0.0', license: 'MIT', backbone: { layer: 'surfaces' }, dependencies: { retained: '1.2.3', added: '4.0.0', workspace: 'workspace:^' } }));
  f.run(); const m = f.read();
  assert.equal(m.version, '2.0.0'); assert.equal(m.licence, 'MIT'); assert.equal(m.kind, 'surface');
  assert.deepEqual(m.dependsOn, [{ name: 'retained', version: '1.2.3', licence: 'MIT' }, { name: 'added', version: '4.0.0' }, { name: 'workspace', version: 'workspace' }]);
  assert.deepEqual(f.check(), []); assert.equal(m.digest, digestOf(f.root, f.dir));
  writeFileSync(f.packagePath, JSON.stringify({ ...f.pkg, dependencies: { retained: '2.0.0' } })); f.run();
  assert.deepEqual(f.read().dependsOn, [{ name: 'retained', version: '2.0.0' }]); assert.deepEqual(f.check(), []);
});

test('regen reconstructs missing derived fields without replacing authored declarations', t => {
  const f = fixture(t), before = f.read();
  const missing = { ...before }; for (const key of ['version', 'licence', 'kind', 'dependsOn', 'digest']) delete missing[key];
  f.put(missing); f.run(); const m = f.read();
  for (const field of ['version', 'licence', 'kind']) assert.equal(m[field], before[field]);
  assert.deepEqual(m.dependsOn.map(({ name, version }) => ({ name, version })), before.dependsOn.map(({ name, version }) => ({ name, version })));
  for (const field of ['id', 'publisher', 'provides', 'consumes', 'capabilities', 'conformance', 'removal']) assert.deepEqual(m[field], before[field]);
  assert.deepEqual(f.check(), []);
});

test('regeneration refuses a linked manifest before changing its target', t => {
  const f = fixture(t), target = join(f.root, 'outside-piece.json'), before = readFileSync(f.path, 'utf8');
  writeFileSync(target, before); unlinkSync(f.path); symlinkSync(target, f.path);
  writeFileSync(f.packagePath, JSON.stringify({ ...f.pkg, version: '2.0.0' }));
  assert.throws(() => f.run(), /symbolic link/);
  assert.equal(readFileSync(target, 'utf8'), before);
});
