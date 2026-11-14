import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retireDirectory, removeRetiredTree } from '../src/storage.ts';

for (const route of ['batch', 'fallback']) test(`${route} metadata repair preserves an outside link target's mode and ACL without relying on an immutable flag`, async () => {
  if (process.platform !== 'darwin') return;
  const root = await fs.mkdtemp(join(tmpdir(), 'acp-repair-links-')), tree = join(root, 'session'), target = join(root, 'outside-acl'), locked = join(root, 'outside-locked');
  await fs.mkdir(tree); await fs.writeFile(target, 'outside content'); await fs.writeFile(locked, 'outside locked'); await fs.writeFile(join(tree, 'a-trigger'), 'repair required');
  const run = (command: string, args: string[]) => { const result = cp.spawnSync(command, args, { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout; };
  run('/bin/chmod', ['0400', target]); run('/bin/chmod', ['+a', 'everyone deny write', target]);
  run('/usr/bin/chflags', ['uchg', locked, join(tree, 'a-trigger')]);
  await fs.symlink(locked, join(tree, 'zz-locked-link')); await fs.symlink(target, join(tree, 'zz-mode-acl-link'));
  const acl = () => run('/bin/ls', ['-lde', target]).split('\n').slice(1).join('\n');
  const originalACL = acl(); assert.match(originalACL, /deny write/); assert.equal((await fs.stat(target)).mode & 0o777, 0o400);
  assert.doesNotMatch(run('/bin/ls', ['-lO', target]), /uchg/);
  const readdir = fs.readdir, spawn = cp.spawn; let forced = false, find = false;
  fs.readdir = (async (...args: Parameters<typeof readdir>) => { if (route === 'fallback' && String(args[0]).includes('.retired-') && (args[1] as { withFileTypes?: boolean })?.withFileTypes) { forced = true; throw Object.assign(new Error('Force relative traversal'), { code: 'ENAMETOOLONG' }); } return readdir(...args); }) as typeof readdir;
  cp.spawn = ((...args: Parameters<typeof spawn>) => { if (args[0] === '/usr/bin/find') find = true; return spawn(...args); }) as typeof spawn;
  syncBuiltinESMExports();
  try {
    await retireDirectory(tree);
    assert.equal((await fs.stat(target)).mode & 0o777, 0o400, 'repair must exclude links from the owner-mode step');
    assert.equal(acl(), originalACL, 'repair must exclude links from the path-ACL step');
    assert.equal(await fs.readFile(target, 'utf8'), 'outside content'); assert.match(run('/bin/ls', ['-lO', locked]), /uchg/);
    assert.equal(forced, route === 'fallback'); assert.equal(find, route === 'fallback');
    assert.ok((await fs.readdir(root)).every(name => !name.startsWith('.retired-')));
  } finally { fs.readdir = readdir; cp.spawn = spawn; syncBuiltinESMExports(); cp.spawnSync('/usr/bin/chflags', ['-R', '0', root]); cp.spawnSync('/bin/chmod', ['-N', target]); await removeRetiredTree(root); }
});
