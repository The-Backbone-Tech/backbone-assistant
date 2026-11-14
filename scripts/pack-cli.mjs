// Assemble an unpublished npm package in a temporary directory. Output the tarball path.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, globSync, readdirSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pieceDigest } from '../packages/platform/src/pieces/digest.ts';
import { createNoticeInventory, filesBelow, frozenPackageNoticeProblems, installedPackage } from './lib/notices.mjs';
import { prepareNativePayload } from './lib/notices-payload.mjs';
import { publicCliBundle, stageNativeLgpl } from './native-lgpl/payload.mjs';
import { verifyNoticeCoverage } from './lib/notices.mjs';
import { productVersion } from './lib/product-version.mjs';
import { sourceIdentity } from '../packages/surfaces/app/scripts/build-identity.ts';
import { bundleTeams } from './lib/bundle-cli-teams.mjs';
import { PIECES } from '../packages/platform/src/composition/pieces.ts';
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// --root supports isolated packaging fixtures; the normal invocation uses this checkout.
const root = process.argv[3] === '--root' ? resolve(process.argv[4]) : sourceRoot;
const output = resolve(process.argv[2] ?? '.');
const stage = mkdtempSync(join(tmpdir(), 'backbone-pack-'));
const packages = new Map();
for (const file of globSync(['packages/*/package.json', 'packages/*/*/package.json'], { cwd: root })) {
  const pkg = JSON.parse(readFileSync(join(root, file), 'utf8'));
  if (packages.has(pkg.name)) throw new Error(`Duplicate workspace package ${pkg.name}`);
  packages.set(pkg.name, { dir: dirname(file), pkg });
}
// Every piece the platform can load must be present, including dynamically loaded engines.
const pieceNames = Object.keys(PIECES);
const selected = new Set(['@backbone-next/cli']);
for (const name of pieceNames) {
  const dir = relative(sourceRoot, PIECES[name].dir);
  const pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
  selected.add(pkg.name);
}
const queue = [...selected];
for (const name of queue) {
  const entry = packages.get(name);
  if (!entry) throw new Error(`Workspace dependency ${name} is missing`);
  for (const [dependency, version] of Object.entries(entry.pkg.dependencies ?? {})) {
    if (version.startsWith('workspace:') && !selected.has(dependency)) {
      selected.add(dependency);
      queue.push(dependency);
    }
  }
}
const names = Object.fromEntries([...selected].sort().map((name) => [name, packages.get(name).dir]));
const dirs = Object.values(names);
try {
  const files = execFileSync('git', ['ls-files', '-z', ...dirs], { cwd: root }).toString().split('\0').filter(Boolean);
  for (const f of files) {
    const relative = f.slice(dirs.find((d) => f.startsWith(`${d}/`)).length + 1);
    if (!(relative === 'package.json' || relative === 'backbone.module.json' || relative.startsWith('src/') || relative.startsWith('schema/') || relative.startsWith('sql/'))) continue;
    if (relative.split('/').some((p) => /^(test|tests|fixtures|testing|__tests__)$/.test(p))) continue;
    mkdirSync(dirname(join(stage, f)), { recursive: true });
    cpSync(join(root, f), join(stage, f));
  }
  for (const f of ['LICENSE', 'NOTICE']) cpSync(join(root, f), join(stage, f));
  mkdirSync(join(stage, 'bin'));
  for (const f of ['backbone.mjs', 'loader.mjs']) cpSync(join(root, 'scripts/cli-package', f), join(stage, 'bin', f));
  // `backbone --version` reads this: the product version and the source revision this archive was packed from.
  const source = sourceIdentity(root);
  writeFileSync(join(stage, 'bin/build.json'), `${JSON.stringify({ version: productVersion(), revision: source.revision, dirty: source.dirty }, null, 2)}\n`);
  writeFileSync(join(stage, 'bin/workspace-map.json'), `${JSON.stringify(names, null, 2)}\n`);
  cpSync(join(root, 'scripts/pg-shm-sweep.mjs'), join(stage, 'scripts/pg-shm-sweep.mjs'), { recursive: true });
  const dependencies = {};
  for (const dir of dirs) {
    const pkg = JSON.parse(readFileSync(join(root, dir, 'package.json')));
    for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
      if (version.startsWith('workspace:')) continue;
      if (dependencies[name] && dependencies[name] !== version) throw new Error(`Conflicting ${name} versions`);
      dependencies[name] = version;
    }
  }
  for (const dir of dirs) {
    const path = join(stage, dir, 'backbone.module.json');
    const manifest = JSON.parse(readFileSync(path));
    manifest.digest = pieceDigest(join(stage, dir));
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  // npm consumers do not read pnpm's patch metadata. Bundle the installed, pinned
  // Teams component so its internal App logger remains silent away from this checkout.
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify({ name: 'backbone-cli-local', version: productVersion(), type: 'module', license: 'Apache-2.0', engines: { node: '>=22.18' }, bin: { backbone: './bin/backbone.mjs' }, bundleDependencies: ['@chat-adapter/teams'], dependencies }, null, 2)}\n`);
  bundleTeams(stage,sourceRoot,dependencies['@chat-adapter/teams']);
  // npm installs this archive, so let npm choose and freeze its complete resolution
  // before collecting notices. Force optional platform packages into this disposable
  // build tree too: other targets must receive the same frozen notice coverage.
  const npmrc = join(stage, '.npmrc-build'); writeFileSync(npmrc, '');
  const installArgs = ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--force', '--userconfig', npmrc];
  try { execFileSync('npm', [...installArgs, '--offline'], { cwd: stage, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }); }
  catch { execFileSync('npm', installArgs, { cwd: stage, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }); }
  rmSync(npmrc);
  execFileSync('npm', ['shrinkwrap', '--ignore-scripts', '--offline'], { cwd: stage, stdio: ['ignore', 'pipe', 'pipe'] });
  // Keep npm's resolved tree only as build input. Recreate the reviewed Teams
  // bundle in an empty root so hoisting cannot replace a CLI dependency with an
  // empty optional-peer placeholder when npm later installs this archive.
  const resolvedTree = join(stage, '.notice-resolved'); mkdirSync(resolvedTree);
  renameSync(join(stage, 'node_modules'), join(resolvedTree, 'node_modules'));
  bundleTeams(stage, sourceRoot, dependencies['@chat-adapter/teams']);
  const lockPath = join(stage, 'npm-shrinkwrap.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const teamsPrefix = 'node_modules/@chat-adapter/teams';
  const nativeName = `@embedded-postgres/${process.platform}-${process.arch}`;
  const nativePrefix = `node_modules/${nativeName}`;
  // Bundle the current target after npm resolution, so installation cannot restore the
  // publisher's opaque LGPL bytes over the reviewed replacement. Other targets remain optional.
  const bundleNative = publicCliBundle();
  if (bundleNative) {
    const source = join(resolvedTree, nativePrefix), destination = join(stage, nativePrefix);
    cpSync(source, destination, { recursive: true, dereference: true });
    const nativeRecord = JSON.parse(readFileSync(join(sourceRoot, 'scripts/notices/native.json'), 'utf8'));
    prepareNativePayload(join(destination, 'native'), nativeRecord.payloadDigests[process.platform]);
    stageNativeLgpl(join(destination, 'native'));
    const manifestPath = join(stage, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.dependencies[nativeName] = nativeRecord.packageVersion;
    manifest.bundleDependencies.push(nativeName);
    manifest.os = [process.platform]; manifest.cpu = [process.arch];
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    lock.packages[''].dependencies[nativeName] = nativeRecord.packageVersion;
    lock.packages[''].bundleDependencies = manifest.bundleDependencies;
  }
  if (!bundleNative) process.stderr.write('notices: local CLI retains publisher LGPL libraries with unknown provenance; public distribution requires node scripts/native-lgpl/build.mjs.\n');
  const bundledPrefixes = bundleNative ? [teamsPrefix, nativePrefix] : [teamsPrefix];
  const isBundled = path => bundledPrefixes.some(prefix => path === prefix || path.startsWith(prefix + '/'));
  for (const [path, entry] of Object.entries(lock.packages)) {
    delete entry.inBundle;
    if (isBundled(path)) delete lock.packages[path];
  }
  for (const file of bundledPrefixes.flatMap(prefix => filesBelow(join(stage, prefix)))) {
    if (!/(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(file)) continue;
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    lock.packages[relative(stage, dirname(file))] = { version: pkg.version, inBundle: true, license: pkg.license,
      ...(pkg.dependencies ? { dependencies: pkg.dependencies } : {}),
      ...(pkg.optionalDependencies ? { optionalDependencies: pkg.optionalDependencies } : {}),
      ...(pkg.peerDependencies ? { peerDependencies: pkg.peerDependencies } : {}),
      ...(pkg.peerDependenciesMeta ? { peerDependenciesMeta: pkg.peerDependenciesMeta } : {}) };
  }
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
  const notices = createNoticeInventory({ repository: sourceRoot });
  for (const dir of dirs) if (JSON.parse(readFileSync(join(stage, dir, 'package.json'))).license) notices.includePackage(join(stage, dir));
  for (const file of filesBelow(join(resolvedTree, 'node_modules'))) {
    if (isBundled(relative(resolvedTree, file))) continue;
    if (/(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(file)) notices.includePackage(dirname(file));
  }
  // npm records other target binaries in its lock even when it omits their local
  // directory. These packages share the pinned publisher's MIT wrapper licence;
  // native component terms are retained separately by the inventory generator.
  const nativeWrapper = installedPackage(`@embedded-postgres/${process.platform}-${process.arch}`, installedPackage('embedded-postgres', join(sourceRoot, 'packages/kernel')));
  const nativeMetadata = JSON.parse(readFileSync(join(nativeWrapper, 'package.json'), 'utf8'));
  const wrapperText = readFileSync(join(nativeWrapper, 'LICENSE.md'), 'utf8');
  for (const [path, metadata] of Object.entries(lock.packages)) {
    const name = path.split('node_modules/').at(-1);
    if (!name?.startsWith('@embedded-postgres/')) continue;
    if (metadata.version !== nativeMetadata.version || metadata.license !== nativeMetadata.license) throw new Error(`Review target binary notices for ${name}@${metadata.version}.`);
    notices.extra(`${name}@${metadata.version}`, name, metadata.version, nativeMetadata.license, wrapperText);
  }
  if (bundleNative) {
    const destination = join(stage, nativePrefix);
    const nativeId = notices.includePackage(destination);
    for (const file of filesBelow(join(destination, 'native'))) {
      const name = file.split('/').at(-1);
      let component = 'PostgreSQL';
      const families = { libiconv: 'libiconv', libintl: 'libintl', libicu: 'ICU', libssl: 'OpenSSL', libcrypto: 'OpenSSL', liblz4: 'lz4', libzstd: 'zstd', libxml: 'libxml2', libedit: 'libedit', libuuid: 'libuuid', libcom_err: 'Kerberos', libgssapi: 'Kerberos', libk5: 'Kerberos', libkrb5: 'Kerberos' };
      for (const [prefix, family] of Object.entries(families)) if (name.startsWith(prefix)) component = family;
      if (/^libz\./.test(name)) component = 'zlib';
      notices.coverIds(relative(stage, file), [nativeId, `postgres-native:${component}`]);
    }
  }
  const cli = join(sourceRoot, 'packages/surfaces/cli');
  for (const file of filesBelow(stage)) {
    if (file.startsWith(resolvedTree + '/')) continue;
    if (file.includes('/node_modules/') && !isBundled(relative(stage, file))) continue;
    // Root metadata and launchers are authored here. Nested dependencies below
    // Teams carry their own identity, retained by bundleTeams.
    let owner = cli;
    if (file.includes('/node_modules/')) {
      for (let at = dirname(file); at.startsWith(stage); at = dirname(at)) {
        if (existsSync(join(at, 'package.json')) && JSON.parse(readFileSync(join(at, 'package.json'))).name) { owner = at; break; }
      }
    } else {
      const dir = dirs.find(dir => file.startsWith(join(stage, dir) + '/'));
      if (dir && JSON.parse(readFileSync(join(stage, dir, 'package.json'))).license) owner = join(stage, dir);
    }
    notices.cover(relative(stage, file), [owner]);
  }
  notices.extra('backbone', 'Backbone', 'source', 'Apache-2.0', ['LICENSE', 'NOTICE'].map(f => readFileSync(join(stage, f), 'utf8')).join('\n\n'));
  const noticeEntries = await notices.write(stage);
  const coverage = verifyNoticeCoverage(stage, { roots: bundleNative ? [nativePrefix] : [] });
  if (coverage.length) throw new Error(coverage.join('\n'));
  const missing = frozenPackageNoticeProblems(lock, noticeEntries);
  if (missing.length) throw new Error(missing.join('\n'));
  cpSync(join(stage, 'notices'), join(stage, 'packages/surfaces/cli/notices'), { recursive: true });
  rmSync(join(stage, 'notices'), { recursive: true });
  rmSync(resolvedTree, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  const result = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', output], { cwd: stage, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  console.log(join(output, result[0].filename));
} finally { rmSync(stage, { recursive: true, force: true }); }
