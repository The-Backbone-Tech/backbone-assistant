import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '../src/commands.ts';

test('notices is a local read command without a data folder', t => {
  assert.equal(parse(['notices']).name, 'notices');
  const root = mkdtempSync(join(tmpdir(), 'cli-notices-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'absent');
  const result = spawnSync(process.execPath, [new URL('../src/main.ts', import.meta.url).pathname, 'notices', '--home', home], { env: { ...process.env, BACKBONE_SYSTEM_STORE_UNAVAILABLE: '1' }, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /notices.*build|build.*notices/i);
  assert.equal(existsSync(home), false);
});
