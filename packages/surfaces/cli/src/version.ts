// What `backbone --version` prints: the product version the app shows plus the source revision.
// A packed command carries bin/build.json written by the packer. A source checkout has none, so it
// reads the shared product version and asks Git for the current revision. It never throws.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export interface BuildRecord { version: string; revision: string | null; dirty: boolean | null }

export function formatVersion(build: BuildRecord, source = false): string {
  const parts: string[] = [];
  if (source) parts.push('source checkout');
  if (build.revision) parts.push(build.revision.slice(0, 12));
  if (build.dirty) parts.push('uncommitted changes');
  return parts.length ? `${build.version} (${parts.join(', ')})` : build.version;
}

const readJson = (url: URL): Record<string, unknown> | null => {
  try { return JSON.parse(readFileSync(url, 'utf8')) as Record<string, unknown>; } catch { return null; }
};

export function versionLine(
  packed = new URL('../../../../bin/build.json', import.meta.url),
  product = new URL('../../../../scripts/lib/product.json', import.meta.url),
  cwd = new URL('.', import.meta.url).pathname,
): string {
  const record = readJson(packed);
  if (record && typeof record.version === 'string') {
    return formatVersion({ version: record.version, revision: typeof record.revision === 'string' ? record.revision : null, dirty: typeof record.dirty === 'boolean' ? record.dirty : null });
  }
  const version = readJson(product)?.version;
  const build: BuildRecord = { version: typeof version === 'string' ? version : 'unknown version', revision: null, dirty: null };
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    build.revision = git('rev-parse', 'HEAD');
    build.dirty = !!git('status', '--porcelain', '--untracked-files=normal');
  } catch { /* no Git here: report the version alone */ }
  return formatVersion(build, true);
}
