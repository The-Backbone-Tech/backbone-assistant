// Capture source when compiling, never infer a shipped revision from the packaging checkout.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

export function sourceIdentity(cwd = process.cwd()) {
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const root = git('rev-parse', '--show-toplevel');
    const revision = git('rev-parse', 'HEAD');
    const dirty = !!git('status', '--porcelain', '--untracked-files=normal');
    const paths = [...new Set(git('-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean))].sort();
    const hash = createHash('sha256');
    for (const path of paths) {
      hash.update(path + '\0');
      try {
        const file = join(root, path), stat = lstatSync(file);
        hash.update(stat.isSymbolicLink() ? 'link\0' + readlinkSync(file) : stat.isFile() ? readFileSync(file) : 'directory');
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
        hash.update('deleted');
      }
      hash.update('\0');
    }
    return { revision, dirty, gitSourceHash: hash.digest('hex') };
  } catch { return { revision: null, dirty: null, gitSourceHash: null }; }
}

interface BrandConfig { name: string; appId: string; light: string; dark: string; icon?: string }
export function buildConfiguration(brand: BrandConfig, version: string) {
  return { version, brand: { name: brand.name, appId: brand.appId, light: brand.light, dark: brand.dark },
    iconHash: brand.icon ? createHash('sha256').update(readFileSync(brand.icon)).digest('hex') : null };
}

export function assertBuildConfiguration(compiled: { configuration: unknown }, current: unknown) {
  if (JSON.stringify(compiled.configuration) !== JSON.stringify(current)) throw new Error('Version or brand changed after compilation; build again before packaging.');
}

export function buildIdentity(source: ReturnType<typeof sourceIdentity>, configuration: ReturnType<typeof buildConfiguration>) {
  return { ...source, id: randomUUID(), builtAt: new Date().toISOString(), version: configuration.version, configuration };
}
