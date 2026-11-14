import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { regenerate, regenerationProblems, generators } from './regen.mjs';

test('regeneration follows dependencies, is idempotent and checking preserves the input', t => {
  const root = mkdtempSync(join(tmpdir(), 'regen-check-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'source'), 'first');
  const step = (input, output) => ({ name: output, run: root => writeFileSync(join(root, output), readFileSync(join(root, input))), check: root => { try { return readFileSync(join(root, input), 'utf8') === readFileSync(join(root, output), 'utf8') ? [] : [output]; } catch { return [output]; } } });
  const steps = [step('source', 'readme'), step('readme', 'digest'), step('digest', 'context')];
  assert.ok(regenerationProblems(root, steps).length);
  regenerate(root, steps);
  assert.deepEqual(regenerationProblems(root, steps), []);
  const before = readFileSync(join(root, 'context'), 'utf8');
  regenerate(root, steps);
  assert.equal(readFileSync(join(root, 'context'), 'utf8'), before);
  writeFileSync(join(root, 'source'), 'second');
  assert.ok(regenerationProblems(root, steps).length);
  assert.equal(readFileSync(join(root, 'context'), 'utf8'), before);
});

test('the repository generator registry includes source artifacts before digests and context', () => {
  const position = name => generators.findIndex(g => g.name === name);
  for (const name of ['core-sources', 'manifest-fields', 'module-readme', 'manifests', 'docker-context']) assert.ok(position(name) >= 0);
  assert.ok(position('core-sources') < position('manifests'));
  assert.ok(position('manifest-fields') < position('module-readme'));
  assert.ok(position('module-readme') < position('manifests'));
  assert.ok(position('manifests') < position('docker-context'));
});

test('the actual generators detect stale outputs and reproduce a clean committed snapshot', t => {
  const root = mkdtempSync(join(tmpdir(), 'regen-snapshot-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = new URL('../', import.meta.url).pathname;
  const archive = execFileSync('git', ['archive', 'HEAD'], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
  execFileSync('tar', ['-xf', '-', '-C', root], { input: archive });
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['add', '-A'], { cwd: root });
  symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), 'dir');
  const readme = join(root, 'packages/modules/harness-pi/README.md');
  const original = readFileSync(readme, 'utf8');
  writeFileSync(readme, original.replace('| Field | Value |', '| Field | stale |'));
  const artifact = join(root, 'packages/core/src/db/material-closure-release.generated.ts');
  writeFileSync(artifact, readFileSync(artifact, 'utf8') + '// stale\n');
  writeFileSync(join(root, '.dockerignore'), '*\n');
  const problems = regenerationProblems(root);
  for (const generator of ['core-sources', 'module-readme', 'manifests', 'docker-context']) assert.ok(problems.some(p => p.startsWith(`${generator}:`)), generator);
  assert.equal(readFileSync(readme, 'utf8').includes('| stale |'), true);
  regenerate(root);
  assert.deepEqual(regenerationProblems(root), []);
  assert.equal(readFileSync(readme, 'utf8'), original);
  regenerate(root);
  assert.deepEqual(regenerationProblems(root), []);
});
