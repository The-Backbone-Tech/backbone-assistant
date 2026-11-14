import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertBuildConfiguration, buildConfiguration, sourceIdentity } from '../scripts/build-identity.ts';

test('a build records dirty source changes even when HEAD stays fixed, from any package directory', () => {
  const home = mkdtempSync(join(tmpdir(), 'app-build-identity-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: home, stdio: 'ignore' });
  try {
    git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Build fixture');
    mkdirSync(join(home, 'package')); writeFileSync(join(home, 'package/source.ts'), 'first');
    git('add', '.'); git('commit', '-qm', 'fixture');
    const clean = sourceIdentity(home);
    assert.equal(clean.dirty, false); assert.match(clean.revision!, /^[0-9a-f]{40}$/);
    assert.deepEqual(sourceIdentity(join(home, 'package')), clean);
    writeFileSync(join(home, 'package/source.ts'), 'changed after HEAD');
    const changed = sourceIdentity(home);
    assert.equal(changed.revision, clean.revision); assert.equal(changed.dirty, true);
    assert.notEqual(changed.gitSourceHash, clean.gitSourceHash);
    writeFileSync(join(home, 'package/new.ts'), 'also compiled');
    assert.notEqual(sourceIdentity(home).gitSourceHash, changed.gitSourceHash);
    assert.equal(JSON.stringify(changed).includes(home), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('building outside Git declares provenance unknown', () => {
  const home = mkdtempSync(join(tmpdir(), 'app-build-outside-git-'));
  try { assert.deepEqual(sourceIdentity(home), { revision: null, dirty: null, gitSourceHash: null }); }
  finally { rmSync(home, { recursive: true, force: true }); }
});


test('packaging refuses a different version, brand or external icon than the compiled configuration', () => {
  const home = mkdtempSync(join(tmpdir(), 'app-build-brand-'));
  try {
    const icon = join(home, 'external-icon.png'); writeFileSync(icon, 'original icon');
    const brand = { name: 'Fixture', appId: 'test.fixture', light: 'warm', dark: 'neutral', icon };
    const configuration = buildConfiguration(brand, '1.2.3');
    const compiled = { configuration };
    assert.doesNotThrow(() => assertBuildConfiguration(compiled, buildConfiguration(brand, '1.2.3')));
    assert.throws(() => assertBuildConfiguration(compiled, buildConfiguration(brand, '9.9.9')), /changed after compilation/);
    assert.throws(() => assertBuildConfiguration(compiled, buildConfiguration({ ...brand, name: 'Another' }, '1.2.3')), /changed after compilation/);
    writeFileSync(icon, 'changed icon');
    assert.throws(() => assertBuildConfiguration(compiled, buildConfiguration(brand, '1.2.3')), /changed after compilation/);
    assert.equal(JSON.stringify(configuration).includes(home), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
