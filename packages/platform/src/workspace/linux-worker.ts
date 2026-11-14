// Disposable IPC bridge. Python supervises the namespace and survives a Host disconnect;
// if this bridge itself is killed, PR_SET_PDEATHSIG closes the entire child namespace.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { workspaceProcess } from './runtime.ts';
import { processIdentity, stopSandbox, WORKSPACE_PYTHON } from './processes.ts';
import { systemEnvironment } from './volume.ts';

const folder = process.argv[2]!;
let started = false, disconnected = false;
let cancel = () => {};
process.on('disconnect', () => { disconnected = true; cancel(); });
process.once('message', async (message: { command: string; inputs: { name: string; base64: string }[]; expiresAt: number }) => {
  if (started) return; started = true;
  const token = randomUUID(), permit = join(folder, `.permit-${token}`), refuse = join(folder, `.refuse-${token}`);
  let ownsRunning = false, result: unknown;
  try {
    const identity = await processIdentity(process.pid);
    if (!identity) throw new Error('Linux supervisor identity unavailable.');
    await writeFile(join(folder, '.running'), JSON.stringify({ ...identity, token, deadline: Math.min(message.expiresAt, Date.now() + 30_000) }), { mode: 0o600, flag: 'wx' });
    ownsRunning = true;
    await writeFile(permit, '', { mode: 0o600, flag: 'wx' }); await writeFile(refuse, '', { mode: 0o600, flag: 'wx' });
    if (disconnected) throw new Error('host disconnected');
    result = await new Promise((resolve, reject) => {
      const child = execFile(WORKSPACE_PYTHON, ['-I', '-S', '-c', readFileSync(workspaceProcess('linux'), 'utf8'), 'run', folder, token, String(process.pid)], { env: systemEnvironment, maxBuffer: 1024 * 1024, timeout: 60_000 }, (error, stdout) => {
        if (error) reject(new Error('Linux workspace supervisor failed; scratch cannot be reused.'));
        else { try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Linux workspace result could not be confirmed.')); } }
      });
      child.stdin!.on('error', () => {});
      // Keep stdin open: EOF is cancellation, including an interrupted Host.
      cancel = () => child.stdin!.end();
      child.stdin!.write(JSON.stringify(message) + '\n');
      if (disconnected) cancel();
    });
  } catch (error) {
    if (ownsRunning) await writeFile(join(folder, '.retiring'), '', { mode: 0o600 });
    result = { code: null, stdout: '', stderr: '', reason: error instanceof Error ? error.message : 'Linux execution could not be confirmed' };
  } finally {
    if (ownsRunning) {
      try {
        await stopSandbox(permit, refuse);
        for (const path of [permit, refuse, join(folder, '.running')]) await unlink(path);
      } catch { result = { code: null, stdout: '', stderr: '', reason: 'Linux workspace cleanup unconfirmed; scratch cannot be reused' }; await writeFile(join(folder, '.retiring'), '', { mode: 0o600 }); }
    }
    if (process.connected) await new Promise<void>(resolve => process.send!(result, () => resolve()));
    if (process.connected) process.disconnect!();
  }
});
