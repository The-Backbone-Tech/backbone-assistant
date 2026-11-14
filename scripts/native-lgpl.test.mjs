import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { stageNativeLgpl, validateBuild, verifyArchive } from './native-lgpl/payload.mjs';
import * as payload from './native-lgpl/payload.mjs';
import { verifyNoticeCoverage } from './lib/notices.mjs';
const inspect = () => ({ architectures: ['arm64', 'x86_64'], deploymentTargets: ['13.0'] });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const records = JSON.parse(readFileSync(new URL('./notices/native.json', import.meta.url))).components;
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'lgpl-build-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const build = join(root, 'build'), native = join(root, 'postgres/native');
  mkdirSync(join(build, 'lib'), { recursive: true }); mkdirSync(join(native, 'lib'), { recursive: true });
  const record = { schema: 1, platform: process.platform, arch: 'universal', architectures: ['arm64', 'x86_64'], recipeSha256: payload.recipeDigest(), environment: { MACOSX_DEPLOYMENT_TARGET: '13.0' }, libraries: {} };
  for (const name of ['libiconv', 'libintl']) {
    const file = name === 'libiconv' ? 'libiconv.2.dylib' : 'libintl.8.dylib';
    const bytes = `built ${name}`;
    record.libraries[name] = { ...records[name], file, dylibSha256: sha(bytes), architectures: ['arm64', 'x86_64'], deploymentTargets: ['13.0'], signature: { verified: true, fingerprint: name === 'libiconv' ? '9001B85AF9E1B83DF1BDA942F5BE8B267C6A406D' : 'E0FFBD975397F77A32AB76ECB6301D9E1BBEAC08', keyExpired: false } };
    writeFileSync(join(build, 'lib', file), bytes); writeFileSync(join(native, 'lib', file), 'third-party bytes');
  }
  writeFileSync(join(build, 'build.json'), JSON.stringify(record));
  return { root, build, native, record };
}
test('replacement uses both verified files and copies the build record; mismatch fails closed', t => {
  const { build, native, record } = fixture(t);
  assert.equal(stageNativeLgpl(native, { buildRoot: build, required: true, inspect }), true);
  assert.deepEqual(JSON.parse(readFileSync(join(native, 'lgpl-build.json'))), record);
  for (const item of Object.values(record.libraries)) assert.equal(sha(readFileSync(join(native, 'lib', item.file))), item.dylibSha256);
  writeFileSync(join(build, 'lib/libintl.8.dylib'), 'wrong build');
  assert.throws(() => stageNativeLgpl(native, { buildRoot: build, required: false, inspect }), /digest/i);
  assert.throws(() => stageNativeLgpl(native, { buildRoot: join(build, 'absent'), required: true, inspect }), /build.*native-lgpl/i);
  assert.equal(stageNativeLgpl(native, { buildRoot: join(build, 'absent'), required: false, inspect }), false);
});
test('cache refuses changed source pins, wrong architecture and wrong archive digest', t => {
  const { build, record } = fixture(t);
  assert.deepEqual(validateBuild(build, { inspect }), record);
  assert.throws(() => verifyArchive(Buffer.from('wrong archive'), records.libiconv), /SHA-256/);
  record.arch = 'wrong'; writeFileSync(join(build, 'build.json'), JSON.stringify(record));
  assert.throws(() => validateBuild(build, { inspect }), /architecture/);
  record.arch = 'universal'; record.libraries.libiconv.archiveSha256 = '0'.repeat(64);
  writeFileSync(join(build, 'build.json'), JSON.stringify(record));
  assert.throws(() => validateBuild(build, { inspect }), /source/);
});
test('public coverage binds actual dylibs to source records even when inventory hashes are refreshed', t => {
  const { root, native, build, record } = fixture(t);
  stageNativeLgpl(native, { buildRoot: build, required: true, inspect }); mkdirSync(join(root, 'notices'));
  const entries = [], artifacts = [];
  for (const [name, item] of Object.entries(record.libraries)) {
    const text = `${item.archiveUrl} ${item.archiveSha256}`, id = `postgres-native:${name}`;
    writeFileSync(join(root, 'notices', `${name}.txt`), text);
    entries.push({ id, version: item.version, license: item.license, file: `${name}.txt`, sha256: sha(text) });
    artifacts.push({ path: `postgres/native/lib/${item.file}`, packages: [id], sha256: item.dylibSha256 });
  }
  artifacts.push({ path: 'postgres/native/lgpl-build.json', packages: [entries[0].id], sha256: sha(readFileSync(join(native, 'lgpl-build.json'))) });
  const index = () => writeFileSync(join(root, 'notices/index.json'), JSON.stringify({ entries, artifacts })); index();
  const check = () => verifyNoticeCoverage(root, { roots: ['postgres'], requireLgplSources: true, inspectNative: inspect });
  assert.deepEqual(check(), []);
  const recipe = record.recipeSha256;
  for (const problem of ['recipe', 'signature']) {
    if (problem === 'recipe') record.recipeSha256 = '0'.repeat(64);
    else record.libraries.libintl.signature.verified = false;
    writeFileSync(join(native, 'lgpl-build.json'), JSON.stringify(record));
    artifacts.at(-1).sha256 = sha(readFileSync(join(native, 'lgpl-build.json'))); index();
    assert.ok(check().some(p => new RegExp(`LGPL.*${problem}`, 'i').test(p)), problem);
    record.recipeSha256 = recipe; record.libraries.libintl.signature.verified = true;
  }
  writeFileSync(join(native, 'lgpl-build.json'), JSON.stringify(record));
  artifacts.at(-1).sha256 = sha(readFileSync(join(native, 'lgpl-build.json'))); index();
  const copiedPins = { ...records, libiconv: { ...records.libiconv, providerSha256: record.libraries.libiconv.dylibSha256 } };
  assert.ok(verifyNoticeCoverage(root, { roots: ['postgres'], requireLgplSources: true, inspectNative: inspect, nativeRecords: copiedPins }).some(p => /provider/i.test(p)));
  writeFileSync(join(native, 'lib/libiconv.2.dylib'), 'provider bytes'); artifacts[0].sha256 = sha('provider bytes'); index();
  assert.ok(check().some(p => /LGPL.*digest/i.test(p)));
  rmSync(join(native, 'lgpl-build.json'));
  assert.ok(check().some(p => /LGPL.*build record/i.test(p)));
});

test('public admission rejects stale recipes, unverified signatures and copied provider originals', t => {
  const { build, native, record } = fixture(t);
  const save = () => writeFileSync(join(build, 'build.json'), JSON.stringify(record));
  const validRecipe = record.recipeSha256;
  record.recipeSha256 = '0'.repeat(64); save();
  assert.throws(() => stageNativeLgpl(native, { buildRoot: build, required: true, inspect }), /recipe/i);
  record.recipeSha256 = validRecipe; record.libraries.libiconv.signature.verified = false; save();
  assert.throws(() => stageNativeLgpl(native, { buildRoot: build, required: true, inspect }), /signature/i);
  record.libraries.libiconv.signature.verified = true;
  writeFileSync(join(build, 'lib/libiconv.2.dylib'), 'third-party bytes');
  record.libraries.libiconv.dylibSha256 = sha('third-party bytes'); save();
  assert.throws(() => stageNativeLgpl(native, { buildRoot: build, required: true, inspect }), /provider/i);
});
test('shipped records refuse absolute user paths anywhere, including linkage headers', t => {
  const { build, native, record } = fixture(t);
  record.libraries.libintl.linkage = ['/Users', 'builder', 'next/libintl.8.dylib:'].join('/');
  writeFileSync(join(build, 'build.json'), JSON.stringify(record));
  assert.throws(() => stageNativeLgpl(native, { buildRoot: build, inspect }), /user path/i);
});
test('native lib folder admits only rebuilt names and links to those files', t => {
  const { build, native } = fixture(t);
  writeFileSync(join(native, 'lib/libiconv-extra.dylib'), 'provider alias');
  assert.throws(() => stageNativeLgpl(native, { buildRoot: build, inspect }), /unexpected.*libiconv/i);
  rmSync(join(native, 'lib/libiconv-extra.dylib'));
  symlinkSync('libiconv.2.dylib', join(native, 'lib/libiconv.dylib'));
  assert.equal(stageNativeLgpl(native, { buildRoot: build, inspect }), true);
});
test('build support records expiry and isolates the environment; deployment and architectures are inspected', async t => {
  const { buildEnvironment, signatureRecord, inspectMachO, assertArchitectures } = await import('./native-lgpl/build-support.mjs');
  const { build } = fixture(t);
  const inherited = { CONFIG_SITE: process.env.CONFIG_SITE, MAKEFLAGS: process.env.MAKEFLAGS };
  process.env.CONFIG_SITE = '/inherited/config'; process.env.MAKEFLAGS = '-e';
  try {
    const env = buildEnvironment({ compiler: '/usr/bin/clang', cxx: '/usr/bin/clang++', sdk: '/Library/SDK', work: build });
    assert.equal(env.CONFIG_SITE, '/dev/null'); assert.equal(env.MAKEFLAGS, undefined);
    assert.equal(env.MACOSX_DEPLOYMENT_TARGET, '13.0');
  } finally { for (const [key, value] of Object.entries(inherited)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  const fingerprint = '9001B85AF9E1B83DF1BDA942F5BE8B267C6A406D';
  assert.equal(signatureRecord(`[GNUPG:] EXPKEYSIG key signer\n[GNUPG:] VALIDSIG ${fingerprint} date`, fingerprint).keyExpired, true);
  assert.equal(signatureRecord(`[GNUPG:] VALIDSIG ${fingerprint} date`, fingerprint).keyExpired, false);
  const inspect = target => inspectMachO('library', (cmd) => cmd === 'lipo' ? 'x86_64 arm64' : `cmd LC_BUILD_VERSION\n minos ${target}\n`);
  assert.deepEqual(inspect('13.0').architectures, ['arm64', 'x86_64']);
  assert.throws(() => inspect('14.0'), /deployment/i);
  assert.throws(() => assertArchitectures(['arm64'], ['arm64', 'x86_64']), /architecture/i);
});

test('CLI native bundling requires explicit public mode regardless of cache presence', () => {
  assert.equal(payload.publicCliBundle({}), false);
  assert.equal(payload.publicCliBundle({ BACKBONE_PUBLIC_DISTRIBUTION: '0' }), false);
  assert.equal(payload.publicCliBundle({ BACKBONE_PUBLIC_DISTRIBUTION: '1' }), true);
});

test('public admission requires both archive signatures even for a single-library coverage check', t => {
  const { build, record } = fixture(t);
  record.libraries.libintl.signature.verified = false;
  writeFileSync(join(build, 'build.json'), JSON.stringify(record));
  assert.throws(() => validateBuild(build, { required: true, names: ['libiconv'], inspect }), /signature/i);
});
test('packaging refuses PostgreSQL architectures missing from the rebuilt libraries', t => {
  const { build, native } = fixture(t);
  mkdirSync(join(native, 'bin')); writeFileSync(join(native, 'bin/postgres'), 'postgres');
  assert.throws(() => stageNativeLgpl(native, { buildRoot: build, inspect, binaryArchitectures: () => ['arm64', 'future-arch'] }), /architecture/i);
});

test('a rebuilt library cannot embed an absolute build-user path', t => {
  const { build, native, record } = fixture(t);
  const bytes = ['/Users', 'builder', 'prefix/share/locale'].join('/');
  writeFileSync(join(build, 'lib/libintl.8.dylib'), bytes);
  record.libraries.libintl.dylibSha256 = sha(bytes);
  writeFileSync(join(build, 'build.json'), JSON.stringify(record));
  assert.throws(() => stageNativeLgpl(native, { buildRoot: build, inspect }), /user path/i);
});
