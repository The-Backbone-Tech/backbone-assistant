// A piece's content digest (docs/repo-design.md, Manifests). One algorithm, shared by the manifest
// check (scripts/manifests.mjs) and by the platform when it loads a piece: both read the files on
// disk, never git, so a branch or tag name can never stand in for content.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MANIFEST = 'backbone.module.json';

/** Never part of a piece's content: dependencies, build and test output, local noise (as the repository's .gitignore). */
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'coverage', '.pg-data', 'evidence', '.git']);
const skippedFile = (name: string) => name === '.DS_Store' || name.endsWith('.log');

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

/** The manifest's own bytes as digested: its JSON without the digest field, in a stable form. */
function manifestBytes(text: string): string {
  const { digest: _omit, ...rest } = JSON.parse(text) as Record<string, unknown>;
  return JSON.stringify(rest);
}

/** Every file a piece's digest covers, as paths relative to `dir` with `/`, sorted. A symbolic link is refused: what it points at would go unhashed. */
export function pieceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (SKIPPED_DIRS.has(entry.name) && (entry.isDirectory() || entry.isSymbolicLink())) continue;
      if (entry.isSymbolicLink()) throw new Error(`${join(dir, path)} is a symbolic link; a piece's content holds no links, so nothing it runs goes unhashed.`);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(path);
      } else if (skippedFile(entry.name)) continue;
      else if (!entry.isFile()) throw new Error(`${join(dir, path)} is not a regular file; a piece's content is regular files only.`);
      else out.push(path);
    }
  };
  walk('');
  return out.sort();
}

/** A piece's content as one read of each file: what both its digest and a loader's per-file hashes come from. */
export interface PieceFile {
  path: string;
  bytes: Buffer;
}

/** Read each file of a piece exactly once. */
export function readPiece(dir: string): PieceFile[] {
  return pieceFiles(dir).map((path) => ({ path, bytes: readFileSync(join(dir, path)) }));
}

/**
 * sha256 over each file's relative path and the sha256 of its bytes, in path order. The manifest
 * counts without its digest field, so it can carry its own. Tool and skill descriptions are files
 * like any other.
 */
export function digestOfFiles(files: PieceFile[]): string {
  const lines = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(({ path, bytes }) => `${path}\0${sha256(path === MANIFEST ? manifestBytes(bytes.toString('utf8')) : bytes)}\n`);
  return `sha256:${sha256(lines.join(''))}`;
}

/** The digest of a piece's folder, as it is on disk now. */
export function pieceDigest(dir: string): string {
  return digestOfFiles(readPiece(dir));
}

/** What a piece declares about itself (schemas/backbone.module.schema.json), as far as the core records it. */
export interface PieceManifest {
  manifest: 1;
  id: string;
  kind: 'core' | 'platform' | 'module' | 'surface';
  version: string;
  capabilities: { planes: string[]; effectClasses: number[]; operations: string[]; network: string[]; secrets: 'none' | 'surrogate'; nativeTools?: 'none' | 'account' };
  digest: string;
  [field: string]: unknown;
}

export function readManifest(dir: string): PieceManifest {
  return JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')) as PieceManifest;
}
