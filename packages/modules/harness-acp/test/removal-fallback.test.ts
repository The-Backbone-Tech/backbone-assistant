import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { removeRetiredTree } from '../src/storage.ts';

test('system rm is required when repaired entries still cannot be removed through the Node traversal', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'acp-rm-fallback-')), leaf = join(root, 'plain'); await fs.writeFile(leaf, 'owned fixture');
  const unlink = fs.unlink, spawn = cp.spawn; let rmCalls = 0;
  fs.unlink = (async (path: Parameters<typeof unlink>[0]) => { if (String(path) === leaf) throw Object.assign(new Error('Injected Node unlink refusal'), { code: 'EPERM' }); return unlink(path); }) as typeof unlink;
  cp.spawn = ((...args: Parameters<typeof spawn>) => { if (args[0] === '/bin/rm') rmCalls++; return spawn(...args); }) as typeof spawn;
  syncBuiltinESMExports();
  try { await removeRetiredTree(root); assert.equal(rmCalls, 1); await assert.rejects(fs.access(root)); }
  finally { fs.unlink = unlink; cp.spawn = spawn; syncBuiltinESMExports(); await fs.rm(root, { recursive: true, force: true }); }
});
