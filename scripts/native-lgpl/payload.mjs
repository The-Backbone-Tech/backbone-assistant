// Shared by both packers and notice coverage. Packaging never fetches or compiles.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertArchitectures, capture, inspectMachO } from './build-support.mjs';
export const defaultBuildRoot = fileURLToPath(new URL('../../dist/native-lgpl/output/', import.meta.url));
export const nativeSources = JSON.parse(readFileSync(new URL('../notices/native.json', import.meta.url))).components;
export const libraryFiles = { libiconv: 'libiconv.2.dylib', libintl: 'libintl.8.dylib' };
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const fingerprints = { libiconv: '9001B85AF9E1B83DF1BDA942F5BE8B267C6A406D', libintl: 'E0FFBD975397F77A32AB76ECB6301D9E1BBEAC08' };
export const recipeDigest = () => digest(['build.mjs', 'build-support.mjs'].map(file => readFileSync(new URL(file, import.meta.url))).join('\n'));
export const publicCliBundle = (env = process.env) => env.BACKBONE_PUBLIC_DISTRIBUTION === '1';
export function assertLibraryFolder(root) {
  root = resolve(root);
  const lib = join(root, 'lib'), allowed = Object.values(libraryFiles).map(file => join(lib, file));
  for (const name of readdirSync(lib).filter(name => /^(?:libiconv|libintl)/.test(name))) {
    const file = join(lib, name), stat = lstatSync(file);
    if (allowed.includes(file) && stat.isFile()) continue;
    if (stat.isSymbolicLink() && allowed.includes(realpathSync(file))) continue;
    throw new Error(`Unexpected LGPL library file: ${name}.`);
  }
}
function hasUserPath(value) {
  if (typeof value === 'string' || Buffer.isBuffer(value)) return /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)/i.test(value.toString());
  return value && typeof value === 'object' && Object.values(value).some(hasUserPath);
}
export function verifyArchive(bytes, source) {
  if (digest(bytes) !== source.archiveSha256) throw new Error(`Source archive SHA-256 mismatch: ${source.archiveUrl}`);
}
export function validateBuild(root, { recordFile = 'build.json', records = nativeSources, names = Object.keys(libraryFiles), required = process.env.BACKBONE_PUBLIC_DISTRIBUTION === '1', inspect = inspectMachO } = {}) {
  const record = JSON.parse(readFileSync(join(root, recordFile), 'utf8'));
  if (record.schema !== 1 || record.platform !== process.platform || !record.architectures?.includes(process.arch) || record.arch !== (record.architectures.length === 1 ? record.architectures[0] : 'universal')) throw new Error('LGPL build platform or architecture mismatch.');
  if (hasUserPath(record)) throw new Error('LGPL build record contains an absolute user path.');
  if (required && record.recipeSha256 !== recipeDigest()) throw new Error('LGPL build recipe mismatch; rebuild the current recipe.');
  if (required) for (const name of Object.keys(libraryFiles)) {
    const signature = record.libraries?.[name]?.signature;
    if (signature?.verified !== true || signature.fingerprint !== fingerprints[name] || typeof signature.keyExpired !== 'boolean') throw new Error(`Missing verified GNU signature for ${name}.`);
  }
  assertLibraryFolder(root);
  for (const name of names) {
    const item = record.libraries?.[name], pin = records[name];
    if (!item || !pin || ['version', 'archiveUrl', 'archiveSha256', 'unmodified'].some(key => item[key] !== pin[key]) || pin.unmodified !== true) throw new Error(`LGPL build source mismatch for ${name}.`);
    if (item.file !== libraryFiles[name] || !/^[a-f0-9]{64}$/.test(item.dylibSha256 ?? '')) throw new Error(`Invalid LGPL library digest record for ${name}.`);
    const file = join(root, 'lib', item.file);
    const bytes = readFileSync(file);
    if (hasUserPath(bytes)) throw new Error(`LGPL library contains an absolute user path: ${name}.`);
    if (!lstatSync(file).isFile() || digest(bytes) !== item.dylibSha256) throw new Error(`LGPL library digest mismatch for ${name}.`);
    if (required && (!pin.providerSha256 || item.dylibSha256 === pin.providerSha256)) throw new Error(`LGPL library matches provider originals or lacks a provider digest for ${name}.`);
    const actual = inspect(file);
    if (JSON.stringify(item.architectures) !== JSON.stringify(actual.architectures) || JSON.stringify(item.deploymentTargets) !== JSON.stringify(actual.deploymentTargets)) throw new Error(`LGPL binary architecture or deployment record mismatch for ${name}.`);
    assertArchitectures(actual.architectures, record.architectures ?? []);
    assertArchitectures(record.architectures ?? [], actual.architectures);
  }
  return record;
}
export function stageNativeLgpl(root, { buildRoot = defaultBuildRoot, required = process.env.BACKBONE_PUBLIC_DISTRIBUTION === '1', inspect = inspectMachO, binaryArchitectures = file => capture('lipo', ['-archs', file]).split(/\s+/) } = {}) {
  if (!existsSync(join(buildRoot, 'build.json'))) {
    if (required) throw new Error('Build the pinned GNU libraries first: node scripts/native-lgpl/build.mjs');
    return false;
  }
  root = realpathSync(root);
  const record = validateBuild(buildRoot, { required, inspect });
  assertLibraryFolder(root);
  if (existsSync(join(root, 'bin'))) for (const file of readdirSync(join(root, 'bin'))) {
    const path = join(root, 'bin', file);
    if (lstatSync(path).isFile()) assertArchitectures(record.architectures, binaryArchitectures(path));
  }
  if (required) for (const file of Object.values(libraryFiles)) {
    if (digest(readFileSync(join(root, 'lib', file))) === digest(readFileSync(join(buildRoot, 'lib', file)))) throw new Error(`LGPL replacement equals provider bytes: ${file}.`);
  }
  for (const name of Object.keys(libraryFiles)) {
    const item = record.libraries[name];
    copyFileSync(join(buildRoot, 'lib', item.file), join(root, 'lib', item.file));
  }
  writeFileSync(join(root, 'lgpl-build.json'), JSON.stringify(record, null, 2) + '\n');
  return true;
}
