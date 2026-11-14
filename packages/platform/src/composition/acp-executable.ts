import { createHash } from 'node:crypto';
import type { AcpAgentConfiguration, AcpAgentDraft, AcpExecutableAcceptance, AcpPrepared } from '../api-acp.ts';
import { resolveExecutable, verifyExecutable, verifyExecutableAccess } from '../executable-identity.ts';
import { acpConfiguration } from './harnesses.ts';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const draftOf = (c: AcpAgentDraft): AcpAgentDraft => ({ agent: c.agent, command: c.command, args: c.args ?? [], environment: c.environment ?? 'restricted-writes', environmentVariables: c.environmentVariables ?? [], ...(c.machineClient ? { machineClient: c.machineClient } : {}) });
export function prepareAcpConfiguration(home: string, draft: AcpAgentDraft, env: NodeJS.ProcessEnv = process.env): AcpPrepared {
  const checked = acpConfiguration(home, { ...draft, acceptsProcessVisibility: true }, {}, true);
  if (checked.blocked) throw new Error(checked.blocked);
  const executable = resolveExecutable(draft.command, env);
  const configuration = draftOf({ ...draft, command: executable.path });
  const machineExecutable = draft.machineClient ? resolveExecutable(env.CLAUDE_CODE_EXECUTABLE ?? 'claude', env) : undefined;
  return { configuration, acceptance: { executable, ...(machineExecutable ? { machineExecutable } : {}), configurationSha256: digest({ configuration, executable, machineExecutable }) } };
}
export function verifyAcpAcceptance(c: AcpAgentConfiguration): void {
  const a = c.acceptance;
  if (!a || c.acceptsProcessVisibility !== true || (c.environment === 'person-rights' && c.acceptsPersonRights !== true)) throw new Error('Resolve the executable and accept its rights in Settings before using ACP.');
  const executable = verifyExecutable(a.executable), machineExecutable = a.machineExecutable && verifyExecutable(a.machineExecutable);
  if (c.command !== executable.path || (!!c.machineClient !== !!machineExecutable) || a.configurationSha256 !== digest({ configuration: draftOf(c), executable, machineExecutable })) throw new Error('The accepted executable, arguments or rights changed. Resolve and accept them again in Settings.');
}
export async function verifyAcpExecutableAccess(acceptance?: AcpExecutableAcceptance): Promise<void> {
  if (!acceptance) throw new Error('Resolve and accept the executable before saving ACP.');
  await verifyExecutableAccess(acceptance.executable);
  if (acceptance.machineExecutable) await verifyExecutableAccess(acceptance.machineExecutable);
}
