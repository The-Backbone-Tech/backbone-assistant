import { fingerprints, recipeDigest } from './native-lgpl/payload.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, lstatSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { payloadDigest, prepareNativePayload, verifyReviewedPayload } from './lib/notices-payload.mjs';
import { createNoticeInventory, frozenPackageNoticeProblems, installedPackage, verifyNoticeCoverage } from './lib/notices.mjs';

test('output inventory retains every licence and NOTICE and rejects uncovered shipped bytes', async t => {
  const root = mkdtempSync(join(tmpdir(), '.notice-resolved-output-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = join(root, 'dependency'); mkdirSync(pkg);
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.2.3', license: 'MIT' }));
  writeFileSync(join(pkg, 'LICENSE'), 'MIT License\nCopyright Fixture\nPermission is hereby granted');
  writeFileSync(join(pkg, 'LICENSE-extra'), 'Additional attribution must survive.');
  writeFileSync(join(pkg, 'NOTICE'), 'Fixture attribution.');
  mkdirSync(join(pkg, 'dist')); writeFileSync(join(pkg, 'dist/binary.node'), 'not-a-licence-payload');
  const output = join(root, 'dist'); mkdirSync(output); writeFileSync(join(output, 'main.cjs'), 'fixture output');
  const inventory = createNoticeInventory(); inventory.includePackage(pkg);
  inventory.cover('main.cjs', [pkg]); await inventory.write(output);
  const index = JSON.parse(readFileSync(join(output, 'notices/index.json'), 'utf8'));
  assert.equal(index.entries.length, 1);
  const text = readFileSync(join(output, 'notices', index.entries[0].file), 'utf8');
  for (const words of ['Copyright Fixture', 'Additional attribution must survive.', 'Fixture attribution.']) assert.ok(text.includes(words));
  assert.ok(!text.includes('not-a-licence-payload'));
  assert.deepEqual(verifyNoticeCoverage(output), []);
  writeFileSync(join(output, 'extra.mjs'), 'unrecorded dependency');
  assert.ok(verifyNoticeCoverage(output).some(p => p.includes('extra.mjs')));
  writeFileSync(join(output, 'main.cjs'), 'changed output');
  assert.ok(verifyNoticeCoverage(output).some(p => p.includes('main.cjs')));
});

test('notice generation refuses prohibited metadata and missing attribution', async t => {
  const root = mkdtempSync(join(tmpdir(), 'notices-refusal-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = join(root, 'dependency'); mkdirSync(pkg);
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', license: 'GPL-3.0' }));
  assert.throws(() => createNoticeInventory().includePackage(pkg), /policy/);
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', license: 'MIT' }));
  const inventory = createNoticeInventory(); inventory.includePackage(pkg);
  await assert.rejects(inventory.write(join(root, 'output')), /licen|attribution/i);
});

test('an opaque native payload must match the reviewed bytes, including unknown additions', t => {
  const root = mkdtempSync(join(tmpdir(), 'notice-native-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'postgres'), 'reviewed binary');
  const digest = payloadDigest(root); verifyReviewedPayload(root, digest, 'fixture');
  writeFileSync(join(root, 'unknown-library.dylib'), 'unreviewed third party');
  assert.throws(() => verifyReviewedPayload(root, digest, 'fixture'), /Review notices/);
});

test('the reviewed Pi prebundle retains embedded contributors beyond its declared package closure', async t => {
  const root = mkdtempSync(join(tmpdir(), 'notice-pi-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const pi = installedPackage('@earendil-works/pi-coding-agent', new URL('../packages/modules/harness-pi', import.meta.url).pathname);
  const record = JSON.parse(readFileSync(new URL('./notices/prebundled.json', import.meta.url), 'utf8'));
  assert.equal(payloadDigest(join(pi, 'dist/bundle')), record.payloadSha256);
  const inventory = createNoticeInventory(); inventory.closure(pi); const entries = await inventory.write(root);
  for (const name of record.contributors) assert.ok(entries.some(entry => entry.name === name), `Embedded contributor ${name}`);
  for (const name of ['supports-color', 'mlly', 'get-tsconfig', 'resolve-pkg-maps']) assert.ok(entries.some(entry => entry.name === name));
});

test('an unreviewed Pi upgrade refuses before silently dropping embedded notices', t => {
  const root = mkdtempSync(join(tmpdir(), 'notice-pi-upgrade-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '99.0.0', license: 'MIT' }));
  assert.throws(() => createNoticeInventory().includePackage(root), /Review.*Pi/i);
});

test('frozen optional targets require a notice even when no local directory exists', () => {
  const lock = { packages: { '': { version: '1' }, 'node_modules/optional-target': { version: '2', optional: true, os: ['linux'] } } };
  assert.equal(frozenPackageNoticeProblems(lock, []).length, 1);
  assert.deepEqual(frozenPackageNoticeProblems(lock, [{ id: 'optional-target@2' }]), []);
});

test('native aliases become inventoried regular files without retaining external build paths', t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-notice-alias-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'native'); mkdirSync(join(root, 'lib'), { recursive: true });
  const source = join(root, 'lib/reviewed.1.dylib'), alias = join(root, 'lib/reviewed.dylib'), outside = join(directory, 'outside');
  writeFileSync(source, 'reviewed publisher bytes'); writeFileSync(outside, 'outside bytes must stay untouched');
  writeFileSync(join(root, 'pg-symlinks.json'), JSON.stringify([{ source: 'native/lib/reviewed.1.dylib', target: 'native/lib/reviewed.dylib' }]));
  const digest = payloadDigest(root); symlinkSync(outside, alias);
  prepareNativePayload(root, digest);
  assert.equal(lstatSync(alias).isFile(), true); assert.equal(readFileSync(alias, 'utf8'), readFileSync(source, 'utf8'));
  assert.equal(readFileSync(outside, 'utf8'), 'outside bytes must stay untouched');
  assert.equal(payloadDigest(root, { exclude: ['lib/reviewed.dylib'] }), digest);
  prepareNativePayload(root, digest);
  assert.equal(lstatSync(alias).isFile(), true, 'already hydrated inputs keep the same reviewed bytes');
  symlinkSync(outside, join(root, 'lib/unreviewed.dylib'));
  assert.throws(() => prepareNativePayload(root, digest), /Unreviewed native/);
});

test('a native alias manifest cannot write outside the staged payload', t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-notice-boundary-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'native'); mkdirSync(root);
  writeFileSync(join(root, 'source'), 'reviewed');
  writeFileSync(join(root, 'pg-symlinks.json'), JSON.stringify([{ source: 'native/source', target: 'outside' }]));
  assert.throws(() => prepareNativePayload(root, payloadDigest(root)), /escapes/);
});

test('a native alias manifest link is refused before any outside JSON can be parsed', t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-notice-manifest-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'native'); mkdirSync(root);
  const outside = join(directory, 'outside'); writeFileSync(outside, 'not JSON; must not be parsed');
  symlinkSync(outside, join(root, 'pg-symlinks.json'));
  assert.throws(() => prepareNativePayload(root, payloadDigest(root)), /manifest must be a staged regular file/);
});

test('coverage refuses an LGPL native library without a complete reviewed source record', t => {
  const root = mkdtempSync(join(tmpdir(), 'notice-lgpl-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'notices')); mkdirSync(join(root, 'postgres/native/lib'), { recursive: true });
  const text = `LGPL terms https://example.org/libiconv-1.0.tar.gz ${'a'.repeat(64)}`, bytes = 'native library';
  writeFileSync(join(root, 'notices/terms.txt'), text); writeFileSync(join(root, 'postgres/native/lib/libiconv.2.dylib'), bytes);
  const digest = value => createHash('sha256').update(value).digest('hex');
  const entry = { id: 'postgres-native:libiconv', license: 'LGPL-2.1-or-later', version: '1.0', file: 'terms.txt', sha256: digest(text) };
  writeFileSync(join(root, 'notices/index.json'), JSON.stringify({ entries: [entry], artifacts: [{ path: 'postgres/native/lib/libiconv.2.dylib', packages: [entry.id], sha256: digest(bytes) }] }));
  const record = { license: entry.license, version: '1.0', archiveUrl: 'https://example.org/libiconv-1.0.tar.gz', archiveSha256: 'a'.repeat(64), unmodified: true, replacementPath: 'Contents/Resources/postgres/native/lib/libiconv.2.dylib', providerSha256: digest('provider bytes') };
  writeFileSync(join(root, 'postgres/native/lgpl-build.json'), JSON.stringify({ schema: 1, platform: process.platform, arch: process.arch, architectures: [process.arch], recipeSha256: recipeDigest(), libraries: { libiconv: { ...record, file: 'libiconv.2.dylib', dylibSha256: digest(bytes), architectures: [process.arch], deploymentTargets: ['13.0'], signature: { verified: true, fingerprint: fingerprints.libiconv, keyExpired: false } }, libintl: { signature: { verified: true, fingerprint: fingerprints.libintl, keyExpired: false } } } }));
  const check = value => verifyNoticeCoverage(root, { roots: ['postgres/native/lib'], nativeRecords: { libiconv: value }, requireLgplSources: true, inspectNative: () => ({ architectures: [process.arch], deploymentTargets: ['13.0'] }) });
  // An ordinary local build reports the gap and goes on; only a public distribution build refuses.
  assert.deepEqual(verifyNoticeCoverage(root, { roots: ['postgres/native/lib'], nativeRecords: { libiconv: undefined }, requireLgplSources: false }), []);
  assert.deepEqual(check(record), []);
  for (const field of ['version', 'archiveUrl', 'archiveSha256', 'unmodified', 'replacementPath']) {
    assert.ok(check({ ...record, [field]: null }).some(p => p.includes('libiconv')), field);
  }
  assert.ok(check({ ...record, archiveSha256: 'invalid' }).length);
  assert.ok(check(undefined).length);
});

test('LGPL notices describe staged bytes and state unknown source for provider fallbacks', async t => {
  const root = mkdtempSync(join(tmpdir(), 'notice-lgpl-provenance-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = join(root, 'provider'); mkdirSync(pkg);
  const pins = JSON.parse(readFileSync(new URL('./notices/native.json', import.meta.url))).components;
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@embedded-postgres/fixture', version: '18.4.0-beta.17', license: 'MIT', author: 'Fixture' }));
  writeFileSync(join(pkg, 'LICENSE'), 'MIT License\nCopyright Fixture\nPermission is hereby granted, free of charge, to any person obtaining a copy.');
  const inventory = createNoticeInventory(); inventory.includePackage(pkg);
  let entries = await inventory.write(root);
  let notice = entries.find(e => e.id === 'postgres-native:libiconv');
  assert.equal(notice.version, 'unknown');
  assert.match(readFileSync(join(root, 'notices', notice.file), 'utf8'), /Corresponding source: unknown/);
  const recordPath = 'postgres/native/lgpl-build.json'; mkdirSync(join(root, 'postgres/native'), { recursive: true });
  // Shaped like the build's own record: there `file` is the library, not the notice text.
  writeFileSync(join(root, recordPath), JSON.stringify({ libraries: { libiconv: { ...pins.libiconv, file: 'libiconv.2.dylib' }, libintl: { ...pins.libintl, file: 'libintl.8.dylib' } } }));
  inventory.coverIds(recordPath, ['@embedded-postgres/fixture@18.4.0-beta.17']);
  entries = await inventory.write(root); notice = entries.find(e => e.id === 'postgres-native:libiconv');
  assert.equal(notice.version, pins.libiconv.version);
  assert.match(readFileSync(join(root, 'notices', notice.file), 'utf8'), /Unmodified source: true/);
});
