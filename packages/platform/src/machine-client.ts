// Node-only diagnostic port shared by the machine-client harness and doctor. Never returns CLI text.
import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { inspectExecutable, installedExecutablePath, verifyExecutable, verifyExecutableAccess } from './executable-identity.ts';
import type { AcpExecutableIdentity, AcpModelSettings, MachineClientState } from './api-acp.ts';

/** No provider key, OAuth token or ambient authentication variable is passed to the client. */
export function claudeMachineEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (!env.HOME?.startsWith('/')) throw new Error('Claude machine sign-in needs an absolute machine home.');
  const config = env.CLAUDE_CONFIG_DIR ?? join(env.HOME, '.claude');
  if (!isAbsolute(config)) throw new Error('Claude machine configuration needs an absolute directory.');
  let executable = env.CLAUDE_CODE_EXECUTABLE ?? 'claude';
  if (!isAbsolute(executable)) {
    if (/[\/\\]/.test(executable)) throw new Error('Use an absolute Claude executable path or a command on PATH.');
    for (const folder of (env.PATH ?? '/usr/bin:/bin').split(delimiter).filter(isAbsolute)) {
      const candidate = join(folder, executable);
      try { accessSync(candidate, constants.X_OK); if (statSync(candidate).isFile()) { executable = candidate; break; } } catch { /* Try the next installed command. */ }
    }
  }
  return { PATH: installedExecutablePath(env), LANG: 'en_US.UTF-8', HOME: env.HOME,
    CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_EXECUTABLE: executable };
}

/** Official CLI status, asynchronous and bounded. Raw output never leaves this function. */
export async function claudeMachineState(env: NodeJS.ProcessEnv = process.env, expected?: AcpExecutableIdentity): Promise<MachineClientState> {
  const result = (state: MachineClientState['state']): MachineClientState => ({ client: 'claude', state, source: 'claude auth status --json' });
  let machine: Record<string, string>;
  try {
    machine = claudeMachineEnvironment(env);
    if (!isAbsolute(machine.CLAUDE_CODE_EXECUTABLE)) return result('absent');
    const identity = expected ? verifyExecutable(expected) : inspectExecutable(machine.CLAUDE_CODE_EXECUTABLE);
    if (identity.path !== inspectExecutable(machine.CLAUDE_CODE_EXECUTABLE).path) return result('error');
    await verifyExecutableAccess(identity);
    machine.CLAUDE_CODE_EXECUTABLE = identity.path;
  } catch (error) { return result((error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'absent' : 'error'); }
  return new Promise<MachineClientState>(resolve => {
    const child = execFile(machine.CLAUDE_CODE_EXECUTABLE, ['auth', 'status', '--json'], {
      env: machine, cwd: machine.HOME, encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024,
    }, (error, stdout) => {
      if (error && (error.killed || error.signal || typeof error.code !== 'number')) return resolve(result(error.code === 'ENOENT' ? 'absent' : 'error'));
      const code = error?.code ?? 0;
      try {
        const status = JSON.parse(stdout);
        if (status?.loggedIn === false && status.authMethod === 'none' && code === 1) return resolve(result('signed-out'));
        if (status?.loggedIn === true && status.authMethod === 'claude.ai' && code === 0) return resolve(result('signed-in'));
        if (typeof status?.loggedIn === 'boolean' && ['api_key', 'api_key_helper', 'oauth_token', 'third_party'].includes(status.authMethod)) return resolve(result('different-auth'));
      } catch { /* Unparseable output is never a login claim. */ }
      resolve(result('error'));
    });
    child.stdin?.end();
  }).catch(() => result('error'));
}

/** One selected Host's cache. Reads are pure; startup and the person's explicit refresh action update it. */
export class MachineClientStatusCache {
  private value: MachineClientState = { client: 'claude', state: 'checking', source: 'claude auth status --json' };
  private pending?: Promise<MachineClientState>;
  private readonly env: NodeJS.ProcessEnv;
  private readonly expected?: AcpExecutableIdentity;
  constructor(env: NodeJS.ProcessEnv, expected?: AcpExecutableIdentity) { this.env = env; this.expected = expected; void this.refresh(); }
  read(): MachineClientState { return { ...this.value }; }
  refresh(): Promise<MachineClientState> {
    return this.pending ??= claudeMachineState(this.env, this.expected).then(value => { this.value = value; return this.read(); }).finally(() => { this.pending = undefined; });
  }
}

export async function selectedMachineClientCheck(settings: AcpModelSettings, env: NodeJS.ProcessEnv = process.env) {
  if (settings.machineClient !== 'claude') return null;
  const result = settings.machineClientState ?? await claudeMachineState(env);
  return { name: 'engine-client', status: result.state === 'signed-in' ? 'ok' as const : 'warn' as const,
    detail: `claude: ${result.state}`, source: result.source };
}
