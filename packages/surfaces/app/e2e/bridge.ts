// Starts the HTTP bridge on a data home and resolves with its URL.
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { appDir } from './journey';

export async function startBridge(home: string, env: NodeJS.ProcessEnv = {}): Promise<{ url: string; proc: ChildProcess }> {
  const proc = spawn(process.execPath, [join(appDir, 'server', 'bridge.ts')], { env: { ...process.env, ...env, BACKBONE_HOME: home, PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
  const url = await new Promise<string>((resolve, reject) => {
    proc.stdout!.on('data', (b: Buffer) => {
      const m = /on (http:\/\/\S+)/.exec(b.toString());
      if (m) resolve(m[1]);
    });
    proc.on('exit', (code) => reject(new Error(`bridge exited ${code}`)));
  });
  return { url, proc };
}

export function stopBridge(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    proc.once('exit', () => resolve());
    proc.kill('SIGTERM');
  });
}
