import { createHash } from 'node:crypto';
import { resolveExecutable, verifyExecutable } from '@backbone-next/platform/executable-identity';
import type { AgentOptions } from './transport.ts';
import { AcpRefusal } from './refusal.ts';

const argumentsHash = (options: AgentOptions) => createHash('sha256').update(JSON.stringify(options.args ?? [])).digest('hex');
/** A programmatic factory call is an acceptance; persisted homes must supply their saved identity. */
export function bindAgentExecutable(options: AgentOptions): void {
  options.executable ??= resolveExecutable(options.command);
  if (options.command !== options.executable.path && options.executable.path !== resolveExecutable(options.command).path) throw new AcpRefusal('The ACP executable changed. Resolve and accept it again.');
  options.command = options.executable.path;
  options.acceptedArguments ??= argumentsHash(options);
}
export function verifyAgentExecutable(options: AgentOptions): void {
  try {
    bindAgentExecutable(options);
    if (options.command !== options.executable!.path || options.acceptedArguments !== argumentsHash(options)) throw new Error('Changed arguments');
    verifyExecutable(options.executable!);
  } catch { throw new AcpRefusal('The ACP executable or arguments changed or are unsafe. Resolve and accept them again in Settings.'); }
}
