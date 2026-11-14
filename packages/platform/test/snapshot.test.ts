import { hangDetector } from '../../../scripts/lib/test-hang.ts';
// Loading a checked piece's code (src/composition/snapshot.ts), with no database: the composition
// copies the piece into a read-only snapshot named by its digest, checks the snapshot itself, and
// imports only from there; every file the import graph loads from it must be a checked file with
// the bytes that were checked. Adverse cases: bytes swapped after the check, an entry or an import
// that leaves the piece or reaches an unchecked file, and an upgrade in place within one process.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs, { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { pieceDigest } from '../src/pieces/digest.ts';
import { pieceOnDisk, PieceRefused } from '../src/composition/pieces.ts';
import { importPiece, snapshotPiece } from '../src/composition/snapshot.ts';
import { HomeWriteUnavailable } from '../src/composition/home-lock.ts';

const made: string[] = [];
after(() => {
  for (const d of made) {
    chmodTree(d);
    rmSync(d, { recursive: true, force: true });
  }
});
/** Snapshots are read-only: make a folder writable again so the test can remove it. */
function chmodTree(dir: string) {
  if (!existsSync(dir)) return;
  chmodSync(dir, 0o755);
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) chmodTree(p);
    else chmodSync(p, 0o644);
  }
}
const fresh = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};
const MARKER = join(fresh('backbone-snapshot-marker-'), 'ran.txt');
const ran = () => (existsSync(MARKER) ? readFileSync(MARKER, 'utf8').split('\n').filter(Boolean) : []);

/** A small piece with no dependencies: its entry names itself `label` and leaves it in MARKER when it runs. */
function piece(label: string, files: Record<string, string> = {}, entry = './src/index.mjs', dir = fresh('backbone-snapshot-piece-')): string {
  const all: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'demo', version: '1.0.0', type: 'module', exports: { '.': entry } }),
    'src/helper.mjs': `export const helper = ${JSON.stringify(label)};\n`,
    'src/index.mjs': `import { appendFileSync } from 'node:fs';\nimport { helper } from './helper.mjs';\nappendFileSync(${JSON.stringify(MARKER)}, helper + '\\n');\nexport const label = helper;\n`,
    ...files,
  };
  for (const [f, text] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  const manifest = { manifest: 1, id: 'io.github.someone/demo', kind: 'module', version: '1.0.0', capabilities: { planes: ['personal'], effectClasses: [], operations: [], network: [], secrets: 'none' }, digest: '' };
  writeFileSync(join(dir, 'backbone.module.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, 'backbone.module.json'), JSON.stringify({ ...manifest, digest: pieceDigest(dir) }));
  return dir;
}
const load = (dir: string, home: string) => importPiece<{ label: string }>(snapshotPiece(pieceOnDisk(dir), home));

// Hosted macOS 15 reproduction: runs 42829488204 and 42829910959 (the latter traces EACCES).
// Keep this OS probe after the fix: newer Macs can rename the same frozen directory successfully.
test('OS probe: rename a staging directory frozen like the original snapshot publisher', (t) => {
  const home = fresh('backbone-snapshot-rename-');
  const staging = join(home, '.staging');
  const destination = join(home, 'published');
  mkdirSync(join(staging, 'src'), { recursive: true });
  writeFileSync(join(staging, 'src/index.mjs'), 'export const checked = true;\n');
  chmodSync(join(staging, 'src/index.mjs'), 0o444);
  chmodSync(join(staging, 'src'), 0o555);
  chmodSync(staging, 0o555);
  assert.equal(statSync(staging).mode & 0o777, 0o555);
  try {
    renameSync(staging, destination);
  } catch (error) {
    assert.equal(process.platform, 'darwin');
    assert.equal((error as NodeJS.ErrnoException).code, 'EACCES');
    assert.equal(existsSync(destination), false);
    t.diagnostic('Frozen-directory rename: EACCES; destination absent (hosted macOS 15 defect reproduced).');
    return;
  }
  assert.equal(readFileSync(join(destination, 'src/index.mjs'), 'utf8'), 'export const checked = true;\n');
  assert.equal(existsSync(staging), false);
  t.diagnostic('Frozen-directory rename succeeded on this OS; the hosted macOS 15 defect does not reproduce here.');
});

/** Intercept the real publication boundary without adding a filesystem seam to product code. */
function interceptRename(t: TestContext, rename: typeof renameSync) {
  t.mock.method(fs, 'renameSync', rename);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

test('publication renames a complete writable tree, then freezes it before import (macOS 15 regression)', async (t) => {
  const home = fresh('backbone-snapshot-home-');
  const source = pieceOnDisk(piece('writable publication'));
  const rename = fs.renameSync;
  let renamed = false;
  interceptRename(t, (from, to) => {
    assert.equal(pieceDigest(String(from)), source.digest, 'the complete content is present before publication');
    assert.equal(existsSync(to), false, 'no partial destination is exposed');
    if (!(statSync(from).mode & 0o200)) {
      throw Object.assign(new Error('EACCES: frozen directory rename on macOS 15'), { code: 'EACCES' });
    }
    rename(from, to);
    renamed = true;
  });
  const snap = snapshotPiece(source, home);
  assert.equal(renamed, true);
  assert.equal(snap.digest, source.digest);
  for (const dir of [snap.dir, join(snap.dir, 'src')]) assert.equal(statSync(dir).mode & 0o777, 0o555);
  assert.equal(statSync(join(snap.dir, 'src/index.mjs')).mode & 0o777, 0o444);
  assert.deepEqual(readdirSync(join(home, 'pieces')), [source.digest.slice('sha256:'.length)]);
  assert.equal((await importPiece<{ label: string }>(snap)).label, 'writable publication');
});

test('a rename error with no competing destination keeps its real code and cleans staging', (t) => {
  const home = fresh('backbone-snapshot-home-');
  const source = pieceOnDisk(piece('rename denied'));
  const denied = Object.assign(new Error('EACCES: publication denied'), { code: 'EACCES' });
  interceptRename(t, () => { throw denied; });
  assert.throws(() => snapshotPiece(source, home), (error) => error === denied);
  assert.deepEqual(readdirSync(join(home, 'pieces')), []);
});

test('a competing publication is used only when its destination has the expected digest', async (t) => {
  let corrupt = false;
  const collision = Object.assign(new Error('EEXIST: competing publisher'), { code: 'EEXIST' });
  interceptRename(t, (from, to) => {
    cpSync(String(from), String(to), { recursive: true });
    if (corrupt) {
      chmodSync(join(String(to), 'src/index.mjs'), 0o644);
      writeFileSync(join(String(to), 'src/index.mjs'), 'export const label = "wrong bytes";\n');
    }
    throw collision;
  });
  for (const wrong of [false, true]) {
    corrupt = wrong;
    const home = fresh('backbone-snapshot-home-');
    const source = pieceOnDisk(piece('competing publication'));
    if (wrong) {
      assert.throws(() => snapshotPiece(source, home), (error) => error === collision);
      assert.ok(collision.cause instanceof PieceRefused, 'the original rename error retains the digest refusal as its cause');
      assert.match(collision.cause.message, /not its registered content/);
      assert.ok(collision.cause.message.includes(source.digest), 'the diagnostic names the expected digest');
    }
    else assert.equal((await importPiece<{ label: string }>(snapshotPiece(source, home))).label, 'competing publication');
    assert.deepEqual(readdirSync(join(home, 'pieces')), [source.digest.slice('sha256:'.length)], 'the loser leaves no staging tree');
  }
});

for (const kind of ['link', 'file'] as const) test(`a named snapshot root that is a ${kind} is refused before realpath or chmod`, (t) => {
  const home = fresh('backbone-snapshot-home-');
  const source = pieceOnDisk(piece('root type'));
  const destination = join(home, 'pieces', source.digest.slice('sha256:'.length));
  mkdirSync(dirname(destination));
  if (kind === 'link') symlinkSync(source.dir, destination, 'dir');
  else writeFileSync(destination, 'not a snapshot directory');
  const mode = statSync(source.dir).mode;
  const realpath = fs.realpathSync;
  let resolvedRoot = false;
  t.mock.method(fs, 'realpathSync', ((path: fs.PathLike) => {
    if (String(path) === destination) resolvedRoot = true;
    return realpath(path);
  }) as typeof fs.realpathSync);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  try {
    assert.throws(() => snapshotPiece(source, home), error => error instanceof PieceRefused && /real directory/.test(error.message));
    assert.equal(resolvedRoot, false, 'the planted root never reaches realpath');
    assert.equal(statSync(source.dir).mode, mode, 'the matching source tree is not chmodded through the link');
    assert.equal(statSync(join(source.dir, 'src/index.mjs')).mode & 0o777, 0o644);
  } finally { unlinkSync(destination); }
});

for (const target of ['home', 'pieces'] as const) {
  for (const phase of ['staging', 'existing reader', 'after rename'] as const) {
    test(`snapshot ${phase} refuses non-admitted ${target} storage before writing`, (t) => {
      const home = fresh('backbone-snapshot-home-');
      const source = pieceOnDisk(piece('admission'));
      const pieces = join(home, 'pieces');
      const destination = join(pieces, source.digest.slice('sha256:'.length));
      mkdirSync(pieces);
      if (phase === 'existing reader') cpSync(source.dir, destination, { recursive: true });
      let withdrawn = phase !== 'after rename';
      if (phase === 'after rename') {
        const rename = fs.renameSync;
        interceptRename(t, (from, to) => { rename(from, to); withdrawn = true; });
      }
      const statfs = fs.statfsSync;
      const denied = target === 'home' ? home : pieces;
      t.mock.method(fs, 'statfsSync', ((path: fs.PathLike) => {
        const actual = statfs(path);
        return withdrawn && String(path) === denied ? { ...actual, type: 0x6969 } : actual;
      }) as typeof fs.statfsSync);
      assert.throws(() => snapshotPiece(source, home), error => error instanceof HomeWriteUnavailable && error.code === 'filesystem');
      if (phase === 'staging') assert.deepEqual(readdirSync(pieces), [], 'no staging directory is created');
      else {
        assert.deepEqual(readdirSync(pieces), [source.digest.slice('sha256:'.length)]);
        assert.ok(statSync(destination).mode & 0o200, 'reader refusal leaves directory permissions unchanged');
        assert.equal(statSync(join(destination, 'src/index.mjs')).mode & 0o777, 0o644);
      }
    });
  }
}

test('the next publication removes only same-piece staging directories older than an hour', () => {
  const home = fresh('backbone-snapshot-home-');
  const source = pieceOnDisk(piece('stale staging'));
  const hex = source.digest.slice('sha256:'.length);
  const pieces = join(home, 'pieces');
  mkdirSync(pieces);
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const stale = join(pieces, `.${hex}.123.0123abcd`);
  const recent = join(pieces, `.${hex}.456.1234abcd`);
  const other = join(pieces, `.${'0'.repeat(64)}.123.0123abcd`);
  const malformed = join(pieces, `.${hex}.not-a-pid.0123abcd`);
  for (const dir of [stale, recent, other, malformed]) mkdirSync(dir);
  writeFileSync(join(stale, 'partial'), 'abandoned content');
  chmodSync(join(stale, 'partial'), 0o444);
  chmodSync(stale, 0o555);
  for (const dir of [stale, other, malformed]) utimesSync(dir, old, old);
  const outside = fresh('backbone-snapshot-stale-outside-');
  writeFileSync(join(outside, 'retained'), 'do not delete or chmod');
  utimesSync(outside, old, old);
  const link = join(pieces, `.${hex}.789.2345abcd`);
  symlinkSync(outside, link, 'dir');
  try {
    snapshotPiece(source, home);
    assert.equal(existsSync(stale), false);
    for (const dir of [recent, other, malformed]) assert.equal(existsSync(dir), true);
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'staging links are never traversed or removed');
    assert.equal(readFileSync(join(outside, 'retained'), 'utf8'), 'do not delete or chmod');
    assert.equal(statSync(outside).mode & 0o777, 0o700);
  } finally { unlinkSync(link); }
});

for (const target of ['home', 'pieces'] as const) test(`stale staging is not chmodded or removed after ${target} admission is refused`, (t) => {
  const home = fresh('backbone-snapshot-home-');
  const source = pieceOnDisk(piece('stale admission'));
  const pieces = join(home, 'pieces');
  const stale = join(pieces, `.${source.digest.slice('sha256:'.length)}.123.0123abcd`);
  mkdirSync(stale, { recursive: true, mode: 0o700 });
  writeFileSync(join(stale, 'partial'), 'retained partial bytes');
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(stale, old, old);
  const statfs = fs.statfsSync, denied = target === 'home' ? home : pieces;
  t.mock.method(fs, 'statfsSync', ((path: fs.PathLike) => {
    const actual = statfs(path);
    return String(path) === denied ? { ...actual, type: 0x6969 } : actual;
  }) as typeof fs.statfsSync);
  assert.throws(() => snapshotPiece(source, home), error => error instanceof HomeWriteUnavailable && error.code === 'filesystem');
  assert.deepEqual(readdirSync(pieces), [stale.split('/').at(-1)!]);
  assert.equal(statSync(stale).mode & 0o777, 0o700);
  assert.equal(readFileSync(join(stale, 'partial'), 'utf8'), 'retained partial bytes');
});

test('a reader verifies and freezes a complete publication left writable by a stopped publisher', async () => {
  const home = fresh('backbone-snapshot-home-');
  const source = pieceOnDisk(piece('published before stop'));
  const destination = join(home, 'pieces', source.digest.slice('sha256:'.length));
  cpSync(source.dir, destination, { recursive: true });
  assert.ok(statSync(destination).mode & 0o200);
  const snap = snapshotPiece(source, home);
  assert.equal(statSync(destination).mode & 0o777, 0o555);
  assert.equal(statSync(join(destination, 'src/index.mjs')).mode & 0o777, 0o444);
  assert.equal((await importPiece<{ label: string }>(snap)).label, 'published before stop');
});

test('the snapshot is named by its digest, read-only, checked itself, and the code imported from it', async () => {
  const home = fresh('backbone-snapshot-home-');
  const dir = piece('first');
  const snap = snapshotPiece(pieceOnDisk(dir), home);
  assert.equal(snap.dir, realpathSync(join(home, 'pieces', pieceDigest(dir).slice('sha256:'.length))));
  assert.equal(snap.digest, pieceDigest(dir));
  assert.equal(statSync(join(snap.dir, 'src/index.mjs')).mode & 0o222, 0, 'snapshot files are read-only');
  assert.equal((await importPiece<{ label: string }>(snap)).label, 'first');
  // A snapshot changed afterwards is refused when it is taken again.
  chmodSync(join(snap.dir, 'src'), 0o755);
  chmodSync(join(snap.dir, 'src/helper.mjs'), 0o644);
  writeFileSync(join(snap.dir, 'src/helper.mjs'), "export const helper = 'swapped';\n");
  assert.throws(() => snapshotPiece(pieceOnDisk(dir), home), /snapshot/);
});

test('bytes swapped after the snapshot was checked never run', async () => {
  const home = fresh('backbone-snapshot-home-');
  const snap = snapshotPiece(pieceOnDisk(piece('checked')), home);
  // Between the check and the import, someone with the person's rights swaps a file.
  chmodSync(join(snap.dir, 'src'), 0o755);
  chmodSync(join(snap.dir, 'src/index.mjs'), 0o644);
  writeFileSync(join(snap.dir, 'src/index.mjs'), `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(MARKER)}, 'swapped\\n');\nexport const label = 'swapped';\n`);
  // The loader serves the bytes it captured and hashed, never a second read of the file.
  assert.equal((await importPiece<{ label: string }>(snap)).label, 'checked');
  assert.ok(!ran().includes('swapped'));
});

test('each file is read once: a file that answers a second read differently never runs', async () => {
  const home = fresh('backbone-snapshot-home-');
  const dir = piece('once');
  const snap = snapshotPiece(pieceOnDisk(dir), home);
  const helper = join(snap.dir, 'src/helper.mjs');
  const original = readFileSync(helper, 'utf8');
  chmodSync(join(snap.dir, 'src'), 0o755);
  unlinkSync(helper);
  execFileSync('mkfifo', [helper]);
  // A writer that answers the first read with the checked bytes and every later one with others.
  const evil = `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(MARKER)}, 'second read\\n');\nexport const helper = 'second read';\n`;
  const writer = spawn(process.execPath, ['-e', `const fs = require('node:fs'); const pause = () => new Promise((r) => setTimeout(r, 300)); (async () => { fs.writeFileSync(process.argv[1], process.argv[2]); for (;;) { await pause(); fs.writeFileSync(process.argv[1], process.argv[3]); } })();`, helper, original, evil], { stdio: 'ignore' });
  try {
    const loaded = (async () => importPiece<{ label: string }>(snapshotPiece(pieceOnDisk(dir), home)))();
    await assert.rejects(hangDetector(loaded,'snapshot import after FIFO substitution',{diagnostic:()=>`writer exit=${writer.exitCode}; signal=${writer.signalCode}`}), /not a regular file/);
  } finally {
    writer.kill('SIGKILL');
  }
  assert.ok(!ran().includes('second read'));
});

test('a checked file swapped for a link after the snapshot never leads outside it', async () => {
  const home = fresh('backbone-snapshot-home-');
  const outside = fresh('backbone-snapshot-outside-');
  writeFileSync(join(outside, 'helper.mjs'), `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(MARKER)}, 'linked\\n');\nexport const helper = 'linked';\n`);
  const snap = snapshotPiece(pieceOnDisk(piece('unlinked')), home);
  chmodSync(join(snap.dir, 'src'), 0o755);
  chmodSync(join(snap.dir, 'src/helper.mjs'), 0o644);
  unlinkSync(join(snap.dir, 'src/helper.mjs'));
  symlinkSync(join(outside, 'helper.mjs'), join(snap.dir, 'src/helper.mjs'));
  await assert.rejects(importPiece(snap), /outside its checked files/);
  assert.ok(!ran().includes('linked'));
});

test('a piece loads only file: and node: modules: data: and network URLs are refused', async () => {
  const home = fresh('backbone-snapshot-home-');
  const code = encodeURIComponent(`import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(MARKER)}, 'data url\\n');`);
  for (const target of [`data:text/javascript,${code}`, 'https://example.invalid/x.mjs', 'http://127.0.0.1:9/x.mjs']) {
    const dir = piece('scheme', { 'src/index.mjs': `await import(${JSON.stringify(target)});\nexport const label = 'scheme';\n` });
    await assert.rejects(load(dir, home), /scheme/, target);
  }
  assert.ok(!ran().includes('data url'));
});

test('an entry outside the piece, or outside its checked files, is refused before anything runs', async () => {
  const home = fresh('backbone-snapshot-home-');
  const outside = fresh('backbone-snapshot-outside-');
  writeFileSync(join(outside, 'outside.mjs'), `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(MARKER)}, 'outside\\n');\n`);
  for (const entry of [`./../${outside.split('/').pop()}/outside.mjs`, './node_modules/evil/index.mjs', './dist/evil.mjs', '../outside.mjs']) {
    const dir = piece('entry', {}, entry);
    for (const hidden of ['node_modules/evil/index.mjs', 'dist/evil.mjs']) {
      mkdirSync(dirname(join(dir, hidden)), { recursive: true });
      writeFileSync(join(dir, hidden), `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(MARKER)}, 'hidden\\n');\n`);
    }
    await assert.rejects(load(dir, home), /entry/, entry);
  }
  assert.deepEqual(ran().filter((r) => r === 'outside' || r === 'hidden'), []);
});

test('an import that leaves the piece or reaches an unchecked file inside it is refused', async () => {
  const home = fresh('backbone-snapshot-home-');
  const outside = fresh('backbone-snapshot-outside-');
  writeFileSync(join(outside, 'outside.mjs'), `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(MARKER)}, 'outside\\n');\nexport const x = 1;\n`);
  const escaping = piece('escaping', { 'src/index.mjs': `import { x } from ${JSON.stringify(join(outside, 'outside.mjs'))};\nexport const label = 'escaping' + x;\n` });
  await assert.rejects(load(escaping, home), /outside its checked files/);
  const relative = piece('relative', { 'src/index.mjs': `export const label = 'relative';\nawait import('../../${outside.split('/').pop()}/outside.mjs');\n` });
  await assert.rejects(load(relative, home), /outside its checked files/);
  const unchecked = piece('unchecked', { 'src/index.mjs': `import { x } from '../dist/x.mjs';\nexport const label = 'unchecked' + x;\n` });
  mkdirSync(join(unchecked, 'dist'));
  writeFileSync(join(unchecked, 'dist/x.mjs'), `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(MARKER)}, 'outside\\n');\nexport const x = 1;\n`);
  await assert.rejects(load(unchecked, home), /outside its checked files/);
  // A "#" import names a file of the folder the snapshot was made from, never checked at load: refused.
  const hash = piece('hash', {
    'package.json': JSON.stringify({ name: 'demo', version: '1.0.0', type: 'module', exports: { '.': './src/index.mjs' }, imports: { '#x': './src/x.mjs' } }),
    'src/x.mjs': 'export const x = 1;\n',
    'src/index.mjs': `import { x } from '#x';\nexport const label = 'hash' + x;\n`,
  });
  await assert.rejects(load(hash, home), /outside its checked files/);
  assert.ok(!ran().includes('outside'));
});

test('an upgrade in place, in the same process, runs the new code: each digest has its own module URLs', async () => {
  const home = fresh('backbone-snapshot-home-');
  const dir = piece('version A');
  assert.equal((await load(dir, home)).label, 'version A');
  piece('version B', {}, './src/index.mjs', dir);
  assert.equal((await load(dir, home)).label, 'version B');
  assert.equal((await load(piece('version A', {}, './src/index.mjs', dir), home)).label, 'version A');
});
