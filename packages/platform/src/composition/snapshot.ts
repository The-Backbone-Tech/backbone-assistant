// Running a checked piece's code. The composition copies the piece's files into a snapshot named by
// its digest (<data home>/pieces/<sha256>/, read-only), reads each snapshot file once, derives the
// digest from those bytes and checks it against the registration, and imports only from there.
// A module hook then serves every file of the snapshot from those captured bytes (never a second
// read), resolves each path a piece imports canonically and refuses one that is not a checked file
// (a parent or absolute path, an unchecked file, a link swapped in), and refuses any URL scheme but
// file: and node: for every load a piece's import graph triggers (no data:, no http(s):). Each digest
// has its own folder, so an upgrade in place gets new module URLs, never a cached module.
// Dependencies (a piece's node_modules) stay where the piece came from and outside the digest: a
// package name imported from a snapshot resolves as it would from the checked folder.
//
// This is defence in depth against tampering at rest, not a sandbox: code running in this process
// can undo any check made in it (docs/architecture.md, "Pieces in the host's process").
import { randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { digestOfFiles, pieceFiles, readManifest, readPiece } from '../pieces/digest.ts';
import { type PieceOnDisk, PieceRefused } from './pieces.ts';
import { assertHomeWriteAdmission } from './home-lock.ts';

interface Snapshot {
  /** Each checked file's URL and the bytes that were read once, hashed, and are served. */
  files: Map<string, Buffer>;
  /** The checked folder it was made from (URL), where its dependencies are resolved from. */
  source: string;
  /** Whether its package.json makes .js and .ts files ES modules. */
  esm: boolean;
}
const snapshots = new Map<string, Snapshot>();
/** Every module URL a piece's import graph reached: the scheme rule holds for all of them. */
const graph = new Set<string>();

const rootOf = (url: string) => [...snapshots.keys()].find((root) => url.startsWith(root));
const ALLOWED = /^(file|node):/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** The real path of a file URL, as a URL; null when it does not resolve. */
function canonical(url: string): string | null {
  try {
    return pathToFileURL(realpathSync(fileURLToPath(url))).href;
  } catch {
    return null;
  }
}

/** A checked file of `root`: in the inventory, and its canonical path is itself (no link swapped in). */
function checkedFile(root: string, url: string): boolean {
  return snapshots.get(root)!.files.has(url) && canonical(url) === url;
}

function formatOf(root: string, url: string): string {
  const esm = snapshots.get(root)!.esm;
  if (url.endsWith('.mjs') || (esm && url.endsWith('.js'))) return 'module';
  if (url.endsWith('.mts') || (esm && url.endsWith('.ts'))) return 'module-typescript';
  if (url.endsWith('.json')) return 'json';
  throw new PieceRefused(`${url} is not an ES module or JSON file; a piece loads only those.`);
}

let hooked = false;
function guard() {
  if (hooked) return;
  hooked = true;
  registerHooks({
    resolve(specifier, context, next) {
      const parent = context.parentURL;
      const root = parent ? rootOf(parent) : undefined;
      const forPiece = !!parent && (!!root || graph.has(parent));
      const refuse = () => new PieceRefused(`A piece imports ${specifier}, outside its checked files; it is not loaded.`);
      if (forPiece && SCHEME.test(specifier) && !ALLOWED.test(specifier)) {
        throw new PieceRefused(`A piece imports ${specifier.slice(0, 40)}: the ${specifier.split(':')[0]}: scheme is refused; only file: and node: modules load.`);
      }
      if (root && /^(\.|\/|file:)/.test(specifier)) {
        // A path from a piece's own file: canonical, and a checked file, or nothing. No lookup follows.
        const url = new URL(specifier, parent).href;
        if (!checkedFile(root, url)) throw refuse();
        graph.add(url);
        return { url, format: formatOf(root, url), shortCircuit: true };
      }
      // A package name is a dependency, found from the checked folder the snapshot was made from.
      const bare = root && !specifier.startsWith('node:');
      const result = next(specifier, bare ? { ...context, parentURL: snapshots.get(root)!.source + parent!.slice(root.length) } : context);
      if (forPiece) {
        if (!ALLOWED.test(result.url)) throw new PieceRefused(`A piece's import resolves to ${result.url.slice(0, 40)}: only file: and node: modules load.`);
        if (result.url.startsWith('file:')) {
          const real = canonical(result.url) ?? result.url;
          // Nor may a name lead into a snapshot's unchecked files, or back to a source folder's own files.
          const into = rootOf(real);
          if (into && !checkedFile(into, real)) throw refuse();
          for (const snap of snapshots.values()) {
            if (real.startsWith(snap.source) && !real.startsWith(`${snap.source}node_modules/`)) throw refuse();
          }
        }
        graph.add(result.url);
      }
      return result;
    },
    load(url, context, next) {
      const root = rootOf(url);
      if (!root) {
        if (graph.has(url) && !ALLOWED.test(url)) throw new PieceRefused(`${url.slice(0, 40)} is not a file: or node: module; it is not loaded.`);
        return next(url, context);
      }
      const bytes = snapshots.get(root)!.files.get(url);
      if (!bytes) throw new PieceRefused(`${url} is outside its piece's checked files; it is not loaded.`);
      // The bytes that were read once and hashed, never a second read of the file.
      return { format: formatOf(root, url), source: bytes, shortCircuit: true };
    },
  });
}

/** Make a folder and everything in it read-only (files 0444, folders 0555), deepest first. */
function freeze(dir: string) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = lstatSync(p);
    if (s.isSymbolicLink()) continue;
    if (s.isDirectory()) freeze(p);
    else chmodSync(p, 0o444);
  }
  chmodSync(dir, 0o555);
}

/** Make a data home's snapshots writable again, so the home can be removed. */
export function releaseSnapshots(home: string) {
  if (existsSync(join(home, 'pieces'))) thaw(join(home, 'pieces'));
}

function thaw(dir: string) {
  chmodSync(dir, 0o755);
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = lstatSync(p);
    if (s.isDirectory()) thaw(p);
    else if (!s.isSymbolicLink()) chmodSync(p, 0o644);
  }
}

/**
 * The piece's snapshot in `home`, made from its checked folder if it does not exist yet, then
 * checked itself: its files must digest to the piece's digest. Records the bytes' hashes the
 * import hook holds every later load to.
 */
export function snapshotPiece(piece: PieceOnDisk, home: string): PieceOnDisk {
  const hex = piece.digest.slice('sha256:'.length);
  const named = join(home, 'pieces', hex);
  // Recover abandoned copies of this piece only; never follow a staging-root link.
  const stagingName = new RegExp(`^\\.${hex}\\.\\d+\\.[0-9a-f]{8}$`);
  for (const name of existsSync(join(home, 'pieces')) ? readdirSync(join(home, 'pieces')) : []) {
    if (!stagingName.test(name)) continue;
    const stale = join(home, 'pieces', name), stat = lstatSync(stale, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || stat.mtimeMs >= Date.now() - 60 * 60 * 1000) continue;
    assertHomeWriteAdmission(home, join(home, 'pieces'));
    thaw(stale);
    rmSync(stale, { recursive: true, force: true });
  }
  let renameError: unknown;
  if (!existsSync(named)) {
    const staging = join(home, 'pieces', `.${hex}.${process.pid}.${randomUUID().slice(0, 8)}`);
    assertHomeWriteAdmission(home, join(home, 'pieces'));
    mkdirSync(staging, { recursive: true });
    try {
      for (const f of pieceFiles(piece.dir)) {
        mkdirSync(dirname(join(staging, f)), { recursive: true });
        copyFileSync(join(piece.dir, f), join(staging, f));
      }
      // macOS 15 refuses to rename a 0555 directory. Publish the complete writable tree
      // atomically; every reader checks its content and freezes it before importing it.
      try {
        renameSync(staging, named);
      } catch (error) {
        renameError = error;
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  // Modules load by their real path, so the snapshot is known by its real path too. Each file is
  // read once: the digest and the loader's bytes both come from that one read.
  let root: string, captured: ReturnType<typeof readPiece>, digest: string;
  try {
    if (!lstatSync(named).isDirectory()) throw new PieceRefused(`The snapshot at ${named} is not a real directory; it is not loaded.`);
    root = realpathSync(named);
    captured = readPiece(root);
    digest = digestOfFiles(captured);
    if (digest !== piece.digest) {
      throw new PieceRefused(`The snapshot of ${piece.manifest.id} in ${root} is not its registered content (${digest}, not ${piece.digest}); it is not loaded.`);
    }
  } catch (error) {
    // A competing publisher won only if its destination is readable and has the expected
    // digest. Otherwise retain the original rename failure, including its real error code.
    if (renameError instanceof Error) renameError.cause = error;
    throw renameError ?? error;
  }
  // Also finishes permissions if a previous publisher stopped immediately after its rename.
  assertHomeWriteAdmission(home, join(home, 'pieces'));
  freeze(root);
  const pkg = captured.find((f) => f.path === 'package.json');
  snapshots.set(pathToFileURL(`${root}${sep}`).href, {
    files: new Map(captured.map((f) => [pathToFileURL(join(root, f.path)).href, f.bytes])),
    source: pathToFileURL(`${realpathSync(piece.dir)}${sep}`).href,
    esm: pkg ? (JSON.parse(pkg.bytes.toString('utf8')) as { type?: string }).type === 'module' : false,
  });
  return { dir: root, manifest: readManifest(root), digest };
}

/**
 * Import a snapshot's entry: its package.json's export, which must resolve to one of its checked
 * files. Everything the entry loads from the snapshot is held to the checked bytes.
 */
export async function importPiece<T>(snapshot: PieceOnDisk): Promise<T> {
  const root = pathToFileURL(`${realpathSync(snapshot.dir)}${sep}`).href;
  const snap = snapshots.get(root);
  if (!snap) throw new PieceRefused(`${snapshot.dir} is not a checked snapshot; a piece is imported only from one.`);
  guard();
  // The entry comes from the captured package.json, and must be a checked file, canonically.
  const captured = snap.files.get(`${root}package.json`);
  const pkg = (captured ? JSON.parse(captured.toString('utf8')) : {}) as { exports?: { '.'?: string } | string; main?: string };
  const entry = (typeof pkg.exports === 'string' ? pkg.exports : pkg.exports?.['.']) ?? pkg.main;
  const url = entry ? new URL(entry, root).href : '';
  if (!entry || !url.startsWith(root) || !checkedFile(root, url)) {
    throw new PieceRefused(`${snapshot.manifest.id} names an entry (${entry ?? 'none'}) that is not one of its checked files; it is not loaded.`);
  }
  return (await import(url)) as T;
}
