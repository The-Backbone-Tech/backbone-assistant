import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WORKSPACE_WRAPPER, workspaceSetup } from '../src/workspace/launch.ts';
import { processOperation } from '../src/workspace/processes.ts';

test('the trusted setup pipe distinguishes rejected limits from a user command exiting 125 and is closed before that command', async t => {
  if (process.platform !== 'darwin') return;
  const root = await mkdtemp(join(tmpdir(), 'workspace-launch-')), marker = join(root, 'ran');
  t.after(() => rm(root, { recursive: true, force: true }));
  const limit = (await processOperation('headroom')).trim();
  const quoted = "'" + marker.replaceAll("'", "'\\''") + "'";
  for (const [headroom, expected] of [['not-a-limit', 'limits'], [limit, 'ready']]) {
    const child = spawn('/bin/bash', ['--noprofile', '--norc', '-c', WORKSPACE_WRAPPER, 'workspace', headroom!, `printf ran > ${quoted}; printf forged >&3; exit 125`], { stdio: ['pipe', 'ignore', 'ignore', 'pipe'] });
    let status = '';
    child.stdio[3]!.on('data', (bytes: Buffer) => { status += bytes.toString(); });
    const closed = once(child, 'close'); child.stdin!.end('run\n');
    const [code] = await closed;
    assert.equal(code, 125);
    assert.equal(status.trim(), expected);
    assert.equal(workspaceSetup(status), expected === 'ready' ? undefined : 'setup');
    if (expected === 'limits') await assert.rejects(readFile(marker));
    else assert.equal(await readFile(marker, 'utf8'), 'ran');
  }
  assert.equal(workspaceSetup('admission\n'), 'admission');
  assert.equal(workspaceSetup(''), 'unconfirmed');
});
