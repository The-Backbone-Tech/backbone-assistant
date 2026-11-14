import { spawn } from 'node:child_process';

/** Fixed Host utilities only; kill their whole owned process group on expiry and await reaping. */
export function cleanupCommand(command: string, args: string[], parent: string, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: parent, detached: true, stdio: 'ignore', env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' } });
    let expired = false, exited = false;
    const timer = setTimeout(() => {
      expired = true;
      if (!exited && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { exited = true; clearTimeout(timer); });
    child.once('close', code => { clearTimeout(timer); if (!expired && code === 0) resolve(); else reject(new Error('ACP cleanup utility failed or exceeded its time limit.')); });
  });
}
