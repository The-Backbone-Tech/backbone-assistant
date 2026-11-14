import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { workspaceProcess } from './runtime.ts';
import { systemEnvironment } from './volume.ts';
export const WORKSPACE_PYTHON = process.platform === 'linux' ? '/usr/bin/python3' : '/Library/Developer/CommandLineTools/usr/bin/python3';
export interface ProcessIdentity { pid: number; uid: number; start: string }
export function processOperation(mode: string, ...args: string[]): Promise<string> {
  if (process.platform === 'linux') return new Promise((resolve, reject) => execFile(WORKSPACE_PYTHON, ['-I', '-S', '-c', readFileSync(workspaceProcess('linux'), 'utf8'), mode, ...args], { env: systemEnvironment, timeout: 10_000, maxBuffer: 65_536 }, (error, stdout) => error ? reject(new Error(`Linux workspace process ${mode} could not be confirmed.`)) : resolve(stdout.trim())));
  // Electron reads its archive, but the system Python cannot traverse app.asar. Feed only
  // the shipped trusted helper to stdin; its arguments and isolated environment stay the same.
  return new Promise((resolve, reject) => {
    const source = readFileSync(workspaceProcess('processes'));
    let inputError: Error | undefined;
    const child = execFile(WORKSPACE_PYTHON, ['-I', '-S', '-', mode, ...args], { env: systemEnvironment, timeout: 10_000, maxBuffer: 65_536 }, (error, stdout) => error || inputError ? reject(new Error(`Workspace process ${mode} could not be confirmed.`)) : resolve(stdout.trim()));
    child.stdin!.on('error', error => { inputError = error; });
    child.stdin!.end(source);
  });
}
export const processIdentity = async (pid: number): Promise<ProcessIdentity | null> => JSON.parse(await processOperation('identity', String(pid)));
export const stopSandbox = async (permit: string, refuse: string): Promise<void> => { await processOperation('stop', permit, refuse); };
