import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { PIECES } from '../packages/platform/src/composition/pieces.ts';
import { pieceDigest } from '../packages/platform/src/pieces/digest.ts';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pack = join(root, 'scripts/pack-cli.mjs');
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
function expected(tree) {
  const all = new Map();
  for (const f of globSync(['packages/*/package.json', 'packages/*/*/package.json'], { cwd: tree })) {
    const pkg = read(join(tree, f));
    all.set(pkg.name, { dir: dirname(f), pkg });
  }
  const wanted = new Set(['@backbone-next/cli']);
  for (const piece of Object.keys(PIECES)) wanted.add(read(join(tree, relative(root, PIECES[piece].dir), 'package.json')).name);
  const visit = (name) => {
    const entry = all.get(name);
    assert.ok(entry, `missing ${name}`);
    for (const [dep, version] of Object.entries(entry.pkg.dependencies ?? {})) {
      if (version.startsWith('workspace:') && !wanted.has(dep)) { wanted.add(dep); visit(dep); }
    }
  };
  for (const name of [...wanted]) visit(name);
  return Object.fromEntries([...wanted].sort().map((name) => [name, all.get(name).dir]));
}
function inspect(tree, out) {
  const archive = execFileSync(process.execPath, [pack, out, '--root', tree], { encoding: 'utf8' }).trim();
  const map = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/bin/workspace-map.json'], { encoding: 'utf8' }));
  const files = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  const actual = files.filter((f) => /^package\/packages\/.+\/package\.json$/.test(f)).map((f) => f.slice('package/'.length, -'/package.json'.length)).sort();
  assert.deepEqual(map, expected(tree));
  assert.deepEqual(actual, Object.values(map).sort());
  const extracted = join(out, 'extracted'); mkdirSync(extracted);
  execFileSync('tar', ['-xzf', archive, '-C', extracted]);
  for (const piece of Object.values(PIECES)) {
    const dir = join(extracted, 'package', relative(root, piece.dir));
    const manifest = read(join(dir, 'backbone.module.json'));
    assert.equal(manifest.digest, pieceDigest(dir), `${piece.id} shipped digest`);
  }
  const manifest = read(join(extracted, 'package/package.json'));
  const publicBuild = process.env.BACKBONE_PUBLIC_DISTRIBUTION === '1';
  assert.equal(manifest.bundleDependencies.includes(`@embedded-postgres/${process.platform}-${process.arch}`), publicBuild);
  assert.deepEqual(manifest.os, publicBuild ? [process.platform] : undefined);
  assert.deepEqual(manifest.cpu, publicBuild ? [process.arch] : undefined);
  return map;
}

test('packaging follows workspace closure and named runtime pieces', () => {
  const temp = mkdtempSync(join(tmpdir(), 'cli-closure-'));
  try {
    const map = inspect(root, temp);
    assert.equal(map['@backbone-next/telemetry-otel'], 'packages/modules/telemetry-otel');
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('a new workspace dependency is included in an isolated copy', () => {
  const temp = mkdtempSync(join(tmpdir(), 'cli-closure-fixture-'));
  try {
    const tree = join(temp, 'tree'); mkdirSync(tree);
    const files = globSync(['packages/*/package.json', 'packages/*/*/package.json', 'packages/*/backbone.module.json', 'packages/*/*/backbone.module.json'], { cwd: root });
    files.push('LICENSE', 'NOTICE', 'scripts/pg-shm-sweep.mjs', 'scripts/cli-package/backbone.mjs', 'scripts/cli-package/loader.mjs');
    for (const f of files) { mkdirSync(dirname(join(tree, f)), { recursive: true }); cpSync(join(root, f), join(tree, f)); }
    const cli = join(tree, 'packages/surfaces/cli/package.json');
    const pkg = read(cli); pkg.dependencies['@example/fake'] = 'workspace:*'; writeFileSync(cli, JSON.stringify(pkg));
    const fake = join(tree, 'packages/modules/fake'); mkdirSync(fake, { recursive: true });
    writeFileSync(join(fake, 'package.json'), JSON.stringify({ name: '@example/fake', version: '1.0.0', type: 'module', exports: { '.': './src/index.ts' } }));
    writeFileSync(join(fake, 'backbone.module.json'), JSON.stringify({ digest: '' }));
    mkdirSync(join(fake, 'src')); writeFileSync(join(fake, 'src/index.ts'), 'export const fake = true;\n');
    execFileSync('git', ['init', '-q', tree]);
    execFileSync('git', ['-C', tree, 'add', '-A']);
    const map = inspect(tree, temp);
    assert.equal(map['@example/fake'], 'packages/modules/fake');
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
