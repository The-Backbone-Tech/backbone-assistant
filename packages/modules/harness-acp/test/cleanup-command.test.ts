import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { cleanupCommand } from '../src/cleanup-command.ts';

test('a cleanup utility deadline kills its owned process group and reaps the command before returning', { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'acp-utility-deadline-')), pidFile = join(root, 'pid');
  const child = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
  const script = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
  let pid = 0;
  try {
    await assert.rejects(cleanupCommand(process.execPath, ['-e', script], root, 500), /time limit/);
    pid = Number(await readFile(pidFile, 'utf8')); assert.ok(Number.isSafeInteger(pid) && pid > 0);
    const alive = () => { try { process.kill(pid, 0); } catch { return false; } return !/Z/.test(spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout); };
    for (let i = 0; i < 100 && alive(); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(alive(), false, 'no cleanup descendant survives the expiry');
  } finally { if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} } await rm(root, { recursive: true, force: true }); }
});
