// Reuse the app's packager receipt and source identity; no second packaging implementation.
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { sourceIdentity } from '../packages/surfaces/app/scripts/build-identity.ts';

const appRoot = root => join(root, 'packages/surfaces/app');

export function prepareInstalled(root) {
  // The suite must produce both receipts itself, even when an earlier build is on disk.
  for (const file of ['dist/build.json', 'dist/package/build.json']) rmSync(join(appRoot(root), file), { force: true });
}

export async function installedResult(root, commit, result) {
  try {
    const app = appRoot(root);
    const info = JSON.parse(readFileSync(join(app, 'dist/package/build.json'), 'utf8'));
    const compiled = JSON.parse(readFileSync(join(app, 'dist/build.json'), 'utf8'));
    const source = sourceIdentity(root);
    if (info.compiled?.revision !== commit || info.compiled.dirty !== false || typeof info.compiled.id !== 'string' || !info.compiled.id ||
        !isDeepStrictEqual(info.compiled, compiled) ||
        !/^[a-f0-9]{64}$/.test(info.compiled.gitSourceHash || '') || info.sourceChangedAfterBuild !== false ||
        source.revision !== commit || source.dirty !== false || source.gitSourceHash !== info.compiled.gitSourceHash) {
      throw new Error('Packaged app does not identify the clean, unchanged gate commit.');
    }
    const dmg = resolve(app, info.dmg), inside = relative(join(app, 'dist/package'), dmg);
    if (isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`) || !dmg.endsWith('.dmg')) throw new Error('DMG must be in the app packaging output.');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(dmg)) hash.update(chunk);
    const sha256 = hash.digest('hex');
    if (sha256 !== info.sha256) throw new Error('Packaged DMG does not match its SHA-256 receipt.');
    return { ...result, packagedApp: { commit, buildId: info.compiled.id, dmg: relative(root, dmg), sha256 } };
  } catch (error) {
    // Keep timeouts, signals and test failures visible; uncertain packaging cannot turn a zero exit green.
    return { ...result, exitCode: result.exitCode === 0 ? 1 : result.exitCode, installedEvidenceError: error.message };
  }
}
