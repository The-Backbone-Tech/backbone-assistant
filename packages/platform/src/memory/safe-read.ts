// Reading the person's files without being led elsewhere. A read names a root folder; the file must
// be inside that root's real location at every level, reached through no linked folder, a single
// link to its data (a hard link could alias a file anywhere), and read from the handle that was
// checked, not opened again. Places that hold credentials are refused, except the one named root a
// person's own agent keeps its memories or skills in.
//
// Writing under the data home's skills folder follows the same anchors (writeUnder, moveUnder,
// removeUnder): every folder from that root down is a plain folder, created here if missing, at
// exactly its expected real location under the root's real location, checked again after the write
// or rename. Anything else fails closed, before or after: a linked folder reaches nothing outside.
import { isUtf8 } from 'node:buffer';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { writeAtomic } from '../stub/fsx.ts';
import { credentialLocations } from '../ports/harness.ts';

const inside = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
const real = (path: string) => { try { return realpathSync(path); } catch { return null; } };

/** The credential places under a home folder, as real paths where they exist. */
export function credentialPlaces(userHome: string, env: Record<string, string | undefined> = process.env): string[] {
  return credentialLocations(userHome, env).flatMap((at) => [at, real(at)].filter((x): x is string => !!x));
}

/** Whether a path lies in a credential place, unless that place holds the named root itself. */
export function inCredentialPlace(path: string, userHome: string, allowedRoot?: string, env: Record<string, string | undefined> = process.env): boolean {
  const target = real(path) ?? path;
  const rootReal = allowedRoot ? real(allowedRoot) : null;
  return credentialPlaces(userHome, env).some((place) => inside(target, place) && !(rootReal && inside(rootReal, place) && inside(target, rootReal)));
}

/** A folder that is itself a real folder, not a link, and whose real location is inside the root. */
function plainDir(path: string, rootReal: string): boolean {
  try {
    const s = lstatSync(path);
    if (!s.isDirectory() || s.isSymbolicLink()) return false;
    const r = real(path);
    return !!r && inside(r, rootReal);
  } catch { return false; }
}

export interface Root { path: string; real: string; dev: number; ino: number }

/** A root to read under: an existing folder, not a link. Null when it is missing or linked. */
export function openRoot(path: string): Root | null {
  try {
    const s = lstatSync(path);
    if (!s.isDirectory() || s.isSymbolicLink()) return null;
    const r = real(path);
    return r ? { path, real: r, dev: s.dev, ino: s.ino } : null;
  } catch { return null; }
}

/**
 * A named root anchored to a base folder (the person's home, or the data home): every folder from the
 * base down is a real folder, not a link, and the root's real location is exactly the base's real
 * location with those names under it. A linked `.codex` or `.claude` above a root reaches nothing.
 */
export function anchoredRoot(base: string, names: string[]): Root | null {
  const baseReal = real(base);
  if (!baseReal) return null;
  let at = base;
  for (const name of names) {
    at = join(at, name);
    try { const s = lstatSync(at); if (!s.isDirectory() || s.isSymbolicLink()) return null; } catch { return null; }
  }
  const root = openRoot(at);
  return root && root.real === join(baseReal, ...names) ? root : null;
}

/** The root is still the folder it was when opened: a swapped or relinked folder fails closed. */
function stillRoot(root: Root): boolean {
  try { const s = lstatSync(root.path); return !s.isSymbolicLink() && s.dev === root.dev && s.ino === root.ino && real(root.path) === root.real; } catch { return false; }
}

/** Every folder from the root down to `path` is a plain folder inside the root. */
function walkable(root: Root, path: string): boolean {
  const rel = relative(root.path, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false;
  const parts = rel.split(sep);
  let at = root.path;
  for (const part of parts.slice(0, -1)) {
    at = join(at, part);
    if (!plainDir(at, root.real)) return false;
  }
  return true;
}

/** A file's text from the checked handle; null unless it is a plain single-link file inside the root.
 * strictUtf8 also rejects lossy decoding, so a verified text copy preserves the original bytes. */
export function readInside(root: Root, path: string, maxBytes: number, strictUtf8 = false): string | null {
  if (!walkable(root, path)) return null;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > maxBytes) return null;
    const at = real(path);
    if (!at || !inside(at, root.real)) return null;
    // lstat, not stat: the real target is a plain file, and a stat that follows links is one more call a swap can steer.
    const there = lstatSync(at);
    if (there.ino !== opened.ino || there.dev !== opened.dev) return null;
    const bytes = readFileSync(fd);
    if (strictUtf8 && !isUtf8(bytes)) return null;
    const text = bytes.toString('utf8');
    // Node has no openat: after reading, the root and the file must still be where they were checked. The
    // open handle (fstat) must be the file the realpath now names, inside the root. A same-user process that
    // swaps an ancestor folder between single calls can still win this race (docs/contracts/skills.md).
    const after = real(path);
    const held = fstatSync(fd);
    const named = after ? lstatSync(after) : null;
    if (!stillRoot(root) || !after || !inside(after, root.real) || !named || named.ino !== held.ino || named.dev !== held.dev || held.ino !== opened.ino || held.dev !== opened.dev || !walkable(root, path)) return null;
    return text;
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}

/** Plain folders directly under a folder inside the root, by name, following no link. */
export function foldersIn(root: Root, dir: string): string[] {
  if (dir !== root.path && (!walkable(root, join(dir, 'x')) || !plainDir(dir, root.real))) return [];
  try { return readdirSync(dir).sort().filter((name) => plainDir(join(dir, name), root.real)); } catch { return []; }
}

/** Markdown files under a folder inside the root, a few levels deep, following no link. */
export function markdownIn(root: Root, dir = root.path, depth = 3): string[] {
  if (depth < 0 || (dir !== root.path && !plainDir(dir, root.real))) return [];
  let names: string[];
  try { names = readdirSync(dir).sort(); } catch { return []; }
  return names.flatMap((name) => {
    const path = join(dir, name);
    if (plainDir(path, root.real)) return markdownIn(root, path, depth - 1);
    return /\.md$/i.test(name) ? [path] : [];
  });
}

// ---- Writing under an anchored root ------------------------------------------------------------

const UNSAFE = 'That skills folder is not a plain folder in the data home (a link, or moved), so nothing was written.';
const missing = (path: string) => { try { lstatSync(path); return false; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return true; throw e; } };

/** The data home's skills folder, made if missing: a plain folder at exactly <home>/skills. Throws otherwise. */
export function skillsRoot(home: string): Root {
  const at = join(home, 'skills');
  if (missing(at)) { try { mkdirSync(at); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; } }
  const root = anchoredRoot(home, ['skills']);
  if (!root) throw new Error(UNSAFE);
  return root;
}

/** A folder under the root by its names, each a plain folder at exactly its expected real location; made when `make`. Throws otherwise. */
export function plainUnder(root: Root, names: readonly string[], make = false): string {
  let at = root.path;
  let expected = root.real;
  for (const name of names) {
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes(sep) || name.includes('\0')) throw new Error(UNSAFE);
    at = join(at, name);
    expected = join(expected, name);
    if (make && missing(at)) { try { mkdirSync(at); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; } }
    const s = lstatSync(at);
    if (!s.isDirectory() || s.isSymbolicLink() || real(at) !== expected) throw new Error(UNSAFE);
  }
  if (!stillRoot(root)) throw new Error(UNSAFE);
  return at;
}

/** Write a file under the root: into a plain folder, over no link or hard link, checked again after. */
export function writeUnder(root: Root, names: readonly string[], file: string, text: string): string {
  const dir = plainUnder(root, names, true);
  const path = join(dir, file);
  if (file.includes('/') || file.includes(sep) || file === '..' || file === '.') throw new Error(UNSAFE);
  if (!missing(path)) { const s = lstatSync(path); if (!s.isFile() || s.nlink !== 1) throw new Error(UNSAFE); }
  writeAtomic(path, text);
  plainUnder(root, names);
  const after = lstatSync(path);
  if (!after.isFile() || after.isSymbolicLink() || real(path) !== join(root.real, ...names, file)) throw new Error(UNSAFE);
  return path;
}

/** Move a folder from one place under the root to another, both plain and anchored, to a name not taken; checked again after. */
export function moveUnder(root: Root, from: readonly string[], to: readonly string[]): string {
  const source = plainUnder(root, from);
  const parent = plainUnder(root, to.slice(0, -1), true);
  const target = join(parent, to.at(-1) ?? '');
  if (!to.length || !missing(target)) throw new Error(UNSAFE);
  plainUnder(root, to.slice(0, -1));
  renameSync(source, target);
  return plainUnder(root, to);
}

/**
 * Remove a folder or file under the root. Its parents must be plain; a link at the end is removed as a
 * link, never followed. `refused` when a parent is not plain or the removal failed: the caller keeps
 * whatever record would let a later pass try again.
 */
export function removeUnder(root: Root, names: readonly string[]): 'removed' | 'absent' | 'refused' {
  if (!names.length) return 'refused';
  // A missing parent means nothing is there; a parent that is there must be plain.
  for (let i = 1; i < names.length; i++) if (missing(join(root.path, ...names.slice(0, i)))) return 'absent';
  try { plainUnder(root, names.slice(0, -1)); } catch { return 'refused'; }
  const at = join(root.path, ...names);
  try {
    if (missing(at)) return 'absent';
    rmSync(at, { recursive: true, force: true });
    return missing(at) ? 'removed' : 'refused';
  } catch { return 'refused'; }
}
