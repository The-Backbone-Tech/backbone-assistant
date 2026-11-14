import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('an unavailable workspace worker is refused without crashing the Host controller', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-worker-refusal-'));
  try {
    const unavailable = join(root, 'not-executable');
    await writeFile(unavailable, 'not an executable', { mode: 0o600 });
    const child = spawn(process.execPath, [new URL('./workspace-worker-refusal.ts', import.meta.url).pathname, root, unavailable], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 0, stderr); assert.match(stdout, /controller survived an unconfirmed launch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
