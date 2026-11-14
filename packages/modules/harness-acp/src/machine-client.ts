import type { AcpExecutableIdentity } from '@backbone-next/platform';
import { claudeMachineEnvironment, claudeMachineState } from '@backbone-next/platform/machine-client';
import { inspectExecutable, verifyExecutable } from '@backbone-next/platform/executable-identity';
import { AcpRefusal } from './refusal.ts';

/** Only this explicit mode reaches machine-owned Claude configuration and login services. */
export function machineClientIdentity(options: { machineExecutable?: AcpExecutableIdentity; machineClient?: 'claude'; machineClientEnvironment?: Record<string, string>; environment?: string; env?: Record<string, string> }): Record<string, string> | undefined {
  if (options.machineClient === undefined) return undefined;
  if (options.machineClient !== 'claude' || options.environment !== 'person-rights') throw new AcpRefusal('Claude machine sign-in requires explicit person-rights.');
  if (Object.keys(options.env ?? {}).some(name => !['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_EXECUTABLE'].includes(name))) throw new AcpRefusal('Claude machine sign-in accepts only its configuration directory and installed executable settings.');
  return claudeMachineEnvironment(options.machineClientEnvironment ?? {
    HOME: process.env.HOME, PATH: process.env.PATH,
    CLAUDE_CONFIG_DIR: options.env?.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR,
    CLAUDE_CODE_EXECUTABLE: options.env?.CLAUDE_CODE_EXECUTABLE ?? process.env.CLAUDE_CODE_EXECUTABLE,
  });
}

export async function machineClientEnvironment(options: Parameters<typeof machineClientIdentity>[0]): Promise<Record<string, string> | undefined> {
  const machine = machineClientIdentity(options);
  if (!machine) return undefined;
  const verifyAccepted = () => {
    if (options.machineExecutable) {
      try { verifyExecutable(options.machineExecutable); }
      catch { throw new AcpRefusal('The selected Claude executable changed or is unsafe. Resolve and accept it again.'); }
    }
  };
  verifyAccepted();
  if (machine.CLAUDE_CODE_EXECUTABLE.startsWith('/')) {
    try {
      options.machineExecutable ??= inspectExecutable(machine.CLAUDE_CODE_EXECUTABLE);
      if (inspectExecutable(machine.CLAUDE_CODE_EXECUTABLE).path !== options.machineExecutable.path) throw new AcpRefusal('The selected Claude executable changed. Resolve and accept it again.');
      machine.CLAUDE_CODE_EXECUTABLE = options.machineExecutable.path;
    } catch (error) { if (error instanceof AcpRefusal) throw error; /* The bounded probe returns the safe absent/error class. */ }
  }
  const status = machine.CLAUDE_CODE_EXECUTABLE.startsWith('/') ? await claudeMachineState(machine, options.machineExecutable) : { state: 'absent', source: 'claude auth status --json' };
  verifyAccepted();
  if (status.state !== 'signed-in') throw new AcpRefusal(`Claude machine client: ${status.state} (source: ${status.source}). Sign in with claude auth login outside the app. No model request was started.`);
  return machine;
}
