import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { retireDirectory, removeRetiredTree } from '../src/storage.ts';

test('relative find repair clears flags, owner mode and ACLs on entries named -RL and -- before unlinking', async () => {
  if (process.platform !== 'darwin') return;
  const root = await fs.mkdtemp(join(tmpdir(), 'acp-repair-dashes-')), tree = join(root, 'session'); await fs.mkdir(tree);
  const run = (command: string, args: string[]) => { const result = cp.spawnSync(command, args, { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout; };
  for (const name of ['-RL', '--']) { const folder = join(tree, name === '-RL' ? 'one' : 'two'); await fs.mkdir(folder); const path = join(folder, name); await fs.writeFile(path, 'owned'); run('/bin/chmod', ['0400', path]); run('/bin/chmod', ['+a', 'everyone deny delete', path]); run('/usr/bin/chflags', ['uchg', path]); }
  const readdir = fs.readdir, unlink = fs.unlink; let forced = false; const repaired = new Set<string>();
  fs.readdir = (async (...args: Parameters<typeof readdir>) => { if (String(args[0]).includes('.retired-') && (args[1] as { withFileTypes?: boolean })?.withFileTypes) { forced = true; throw Object.assign(new Error('Force relative traversal'), { code: 'ENAMETOOLONG' }); } return readdir(...args); }) as typeof readdir;
  fs.unlink = (async (path: Parameters<typeof unlink>[0]) => {
    if (String(path).includes('.retired-') && ['-RL', '--'].includes(basename(String(path))) && !run('/bin/ls', ['-lO', String(path)]).includes('uchg')) {
      assert.equal((await fs.stat(path)).mode & 0o600, 0o600, 'the relative owner-mode command must treat the name as an operand');
      assert.doesNotMatch(run('/bin/ls', ['-lde', String(path)]), /deny delete/, 'the relative ACL command must treat the name as an operand'); repaired.add(basename(String(path)));
    }
    return unlink(path);
  }) as typeof unlink;
  syncBuiltinESMExports();
  try { await retireDirectory(tree); assert.equal(forced, true); assert.deepEqual([...repaired].sort(), ['--', '-RL']); assert.deepEqual(await fs.readdir(root), []); }
  finally { fs.readdir = readdir; fs.unlink = unlink; syncBuiltinESMExports(); await removeRetiredTree(root); }
});
