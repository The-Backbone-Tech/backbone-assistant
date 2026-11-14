import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceIdentity } from '../packages/surfaces/app/scripts/build-identity.ts';
import { prepareInstalled, installedResult } from './gate-installed.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'gate-installed-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, '.gitignore'), 'packages/\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture']);
  const at = join(root, 'packages/surfaces/app');
  mkdirSync(join(at, 'dist/package'), { recursive: true });
  const compiled = { ...sourceIdentity(root), id: 'fresh-build' };
  const info = { compiled, sourceChangedAfterBuild: false, dmg: 'dist/package/test.dmg', sha256: createHash('sha256').update('fresh image').digest('hex') };
  const receipt = join(at, 'dist/package/build.json');
  const write = () => { writeFileSync(join(at, info.dmg), 'fresh image'); writeFileSync(join(at, 'dist/build.json'), JSON.stringify(info.compiled)); writeFileSync(receipt, JSON.stringify(info)); };
  write();
  return { root, at, compiled, info, receipt, write };
}
const passed = { exitCode: 0, signal: null, timedOut: false, passed: 1, failed: 0 };

test('installed acceptance discards old receipts and records the verified fresh DMG identity', async t => {
  const f = fixture(t);
  prepareInstalled(f.root);
  assert.equal(existsSync(f.receipt), false);
  assert.equal(existsSync(join(f.at, 'dist/build.json')), false);
  assert.notEqual((await installedResult(f.root, f.compiled.revision, passed)).exitCode, 0);
  f.write();
  const result = await installedResult(f.root, f.compiled.revision, passed);
  assert.equal(result.exitCode, 0);
  assert.equal(result.packagedApp.sha256, f.info.sha256);
  assert.equal(result.packagedApp.commit, f.compiled.revision);
  assert.equal(result.packagedApp.buildId, f.compiled.id);
  writeFileSync(join(f.at, 'dist/build.json'), JSON.stringify(Object.fromEntries(Object.entries(f.compiled).reverse())));
  assert.equal((await installedResult(f.root, f.compiled.revision, passed)).exitCode, 0, 'receipt key order does not change build identity');
  assert.equal(readFileSync(join(f.at, f.info.dmg), 'utf8'), 'fresh image');
  assert.equal((await installedResult(f.root, f.compiled.revision, { ...passed, exitCode: 1 })).exitCode, 1);
});

test('installed acceptance rejects wrong commits, dirty or changed inputs and tampered images', async t => {
  const f = fixture(t);
  for (const mutate of [
    () => { f.info.compiled.revision = 'other'; },
    () => { f.info.compiled.dirty = true; },
    () => { f.info.compiled.gitSourceHash = '0'.repeat(64); },
    () => { f.info.sourceChangedAfterBuild = true; },
    () => { delete f.info.sha256; },
    () => { f.info.dmg = '../outside.dmg'; },
  ]) {
    f.info.compiled = { ...f.compiled }; f.info.sourceChangedAfterBuild = false;
    f.info.dmg = 'dist/package/test.dmg'; f.info.sha256 = createHash('sha256').update('fresh image').digest('hex');
    mutate(); writeFileSync(join(f.at, 'dist/build.json'), JSON.stringify(f.info.compiled)); writeFileSync(f.receipt, JSON.stringify(f.info));
    const result = await installedResult(f.root, f.compiled.revision, passed);
    assert.notEqual(result.exitCode, 0); assert.ok(result.installedEvidenceError);
  }
  f.info.compiled = { ...sourceIdentity(f.root), id: 'fresh-build' }; f.info.sourceChangedAfterBuild = false;
  f.info.dmg = 'dist/package/test.dmg'; f.info.sha256 = '0'.repeat(64); f.write();
  assert.notEqual((await installedResult(f.root, f.compiled.revision, passed)).exitCode, 0);
  f.info.sha256 = createHash('sha256').update('fresh image').digest('hex'); f.write();
  writeFileSync(join(f.root, 'changed-source.ts'), 'changed after packaging');
  assert.notEqual((await installedResult(f.root, f.compiled.revision, passed)).exitCode, 0);
});

test('a packaging receipt cannot stand in for a fresh matching compilation receipt', async t => {
  const f = fixture(t);
  writeFileSync(join(f.at, 'dist/build.json'), JSON.stringify({ ...f.compiled, id: 'different-build' }));
  assert.notEqual((await installedResult(f.root, f.compiled.revision, passed)).exitCode, 0);
  rmSync(join(f.at, 'dist/build.json'));
  assert.notEqual((await installedResult(f.root, f.compiled.revision, passed)).exitCode, 0);
});
