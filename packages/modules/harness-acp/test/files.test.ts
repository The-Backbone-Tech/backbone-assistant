import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, link, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { directoryIdentity } from '../src/directories.ts';
import { scratchFile } from '../src/files.ts';

test('client scratch reads/writes refuse aliases, linked files and oversized data', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'acp-files-')));
  const identity = directoryIdentity(root);
  try {
    await scratchFile(identity, join(root, 'normal'), 'one\ntwo');
    assert.equal(await scratchFile(identity, join(root, 'normal')), 'one\ntwo');
    await symlink(join(root, 'normal'), join(root, 'symlink'));
    await assert.rejects(scratchFile(identity, join(root, 'symlink')), /linked/);
    await link(join(root, 'normal'), join(root, 'hardlink'));
    await assert.rejects(scratchFile(identity, join(root, 'hardlink'), 'overwrite'), /linked/);
    await assert.rejects(scratchFile(identity, join(root, '..', 'outside'), 'escape'), /inside/);
    await assert.rejects(scratchFile(identity, join(root, 'huge'), 'x'.repeat(1_000_001)), /size limit/);
    await writeFile(join(root, 'too-large'), 'x'.repeat(1_000_001));
    await assert.rejects(scratchFile(identity, join(root, 'too-large')), /too large/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('client file paths cannot escape through a symlinked parent and dot-dot', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'acp-file-escape-')));
  const work = join(root, 'work'), outside = join(root, 'outside');
  await mkdir(work); await mkdir(join(outside, 'sub'), { recursive: true });
  await writeFile(join(outside, 'settings.json'), 'unchanged');
  await symlink(join(outside, 'sub'), join(work, 'd'));
  const workIdentity = directoryIdentity(work);
  try {
    const attack = work + '/d/../settings.json';
    await assert.rejects(scratchFile(workIdentity, attack), /inside/);
    await assert.rejects(scratchFile(workIdentity, attack, 'overwritten'), /inside/);
    for (const path of [join(outside, 'settings.json'), work + '/nested/file', join(work, '.hidden')]) {
      await assert.rejects(scratchFile(workIdentity, path, 'escape'), /inside/);
    }
    assert.equal(await readFile(join(outside, 'settings.json'), 'utf8'), 'unchanged');
    await scratchFile(workIdentity, join(work, 'plain.txt'), 'permitted');
    assert.equal(await scratchFile(workIdentity, join(work, 'plain.txt')), 'permitted');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a scratch file growing after the metadata check is still read with a fixed byte bound', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'acp-file-growth-'))), path = join(root, 'growing');
  await writeFile(path, 'small');
  const { open } = await import('node:fs/promises');
  const handle = await open(path, 'r'), inode = (await handle.stat()).ino;
  const prototype = Object.getPrototypeOf(handle), original = prototype.stat;
  let grew = false; const identity = directoryIdentity(root);
  try {
    prototype.stat = async function (...args: unknown[]) {
      const info = await original.apply(this, args);
      if (info.ino === inode && !grew) { grew = true; await writeFile(path, 'x'.repeat(1_000_001)); }
      return info;
    };
    await assert.rejects(scratchFile(identity, path), /too large/); assert.equal(grew, true);
  } finally { prototype.stat = original; await handle.close(); await rm(root, { recursive: true, force: true }); }
});
