import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pieceDigest, pieceFiles } from '../src/pieces/digest.ts';

/** The one digest algorithm (scripts/manifests.mjs and the platform's loader use it): files on disk, never git. */
describe('a piece\'s digest', () => {
  it('covers every file of the piece but its own digest field, dependencies and build output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'backbone-digest-'));
    try {
      mkdirSync(join(dir, 'src'));
      mkdirSync(join(dir, 'node_modules/x'), { recursive: true });
      mkdirSync(join(dir, 'dist'));
      writeFileSync(join(dir, 'src/tools.ts'), "export const DESCRIPTION = 'Propose an effect.';\n");
      writeFileSync(join(dir, 'backbone.module.json'), JSON.stringify({ id: 'a/b', digest: 'sha256:1' }));
      writeFileSync(join(dir, 'node_modules/x/index.js'), '1');
      writeFileSync(join(dir, 'dist/out.js'), '1');
      assert.deepEqual(pieceFiles(dir), ['backbone.module.json', 'src/tools.ts']);
      const first = pieceDigest(dir);
      assert.match(first, /^sha256:[0-9a-f]{64}$/);
      writeFileSync(join(dir, 'backbone.module.json'), JSON.stringify({ id: 'a/b', digest: 'sha256:2' }));
      writeFileSync(join(dir, 'dist/out.js'), '2');
      assert.equal(pieceDigest(dir), first);
      writeFileSync(join(dir, 'src/tools.ts'), "export const DESCRIPTION = 'Propose an effect. Send it twice.';\n");
      assert.notEqual(pieceDigest(dir), first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a symbolic link anywhere in a piece, to a file or to a folder: its content would go unhashed', () => {
    for (const make of [
      (dir: string, outside: string) => symlinkSync(join(outside, 'code.ts'), join(dir, 'src/linked.ts')),
      (dir: string, outside: string) => symlinkSync(outside, join(dir, 'src/linked')),
    ]) {
      const dir = mkdtempSync(join(tmpdir(), 'backbone-digest-'));
      const outside = mkdtempSync(join(tmpdir(), 'backbone-digest-outside-'));
      try {
        mkdirSync(join(dir, 'src'));
        writeFileSync(join(dir, 'src/tools.ts'), 'export {};\n');
        writeFileSync(join(outside, 'code.ts'), "console.log('not hashed');\n");
        make(dir, outside);
        assert.throws(() => pieceFiles(dir), /symbolic link/);
        assert.throws(() => pieceDigest(dir), /symbolic link/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    }
  });
});
