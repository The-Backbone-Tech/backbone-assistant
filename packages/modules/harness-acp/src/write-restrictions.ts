import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import {auditScratchParent} from '@backbone-next/platform/audit-scratch';
import { AcpRefusal } from './refusal.ts';
import { workspaceScratchParent } from '@backbone-next/platform/workspace-policy';
import { BASE_POLICY, NETWORK_POLICY } from './seatbelt-policy.ts';
import { credentialLocations, unsupportedCredentialDirs } from '@backbone-next/platform/ports';

export interface WriteRestrictionOptions { command: string; args: string[]; work: string; state: string; extraDenies?: string[]; environment?: 'restricted-writes' | 'person-rights'; storage?: string }
const contains = (a: string, b: string) => b === a || b.startsWith(a + sep);
const exact = (value: string) => {
  if (!isAbsolute(value) || /["\\\x00-\x1f]/.test(value)) throw new Error('Write-restriction paths must be absolute and contain no quotes, backslashes or controls.');
  return resolve(value);
};

/** Canonicalize existing ancestors even when the final denied folder does not yet exist. */
export function canonicalDeniedPath(path: string, hops = 0): string {
  if (hops > 32) throw new Error('A denied folder has too many symlink ancestors.');
  let ancestor = exact(path); const tail: string[] = [];
  for (;;) {
    try {
      const info = lstatSync(ancestor);
      if (info.isSymbolicLink()) return canonicalDeniedPath(resolve(dirname(ancestor), readlinkSync(ancestor), ...tail), hops + 1);
      return resolve(realpathSync(ancestor), ...tail);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(ancestor); if (parent === ancestor) throw error;
      tail.unshift(ancestor.slice(parent.length).replace(/^\//, '')); ancestor = parent;
    }
  }
}

/** Returns an argv, never a shell command. Refuses paths the policy cannot express safely. */
export class WriteRestrictionRefused extends AcpRefusal {}

export function writeRestrictionCommand(options: WriteRestrictionOptions, platform = process.platform, available = existsSync('/usr/bin/sandbox-exec')): string[] {
  if (options.environment !== undefined && options.environment !== 'restricted-writes' && options.environment !== 'person-rights') throw new WriteRestrictionRefused('ACP environment must be restricted-writes or person-rights.');
  if (options.environment !== 'person-rights') {
    if (platform === 'linux') throw new WriteRestrictionRefused('Linux restricted-writes execution is unavailable; no qualified write-restriction profile is available for this route.');
    if (platform !== 'darwin') throw new WriteRestrictionRefused('No supported write-restriction profile is available; restricted-writes execution is refused.');
    if (!available) throw new WriteRestrictionRefused('macOS sandbox-exec is missing; restricted-writes execution is refused.');
  }
  return candidateWriteRestrictionCommand(options);
}

/** Deny-default Seatbelt profile, also exercised directly by the OS canaries. */
export function candidateWriteRestrictionCommand(options: WriteRestrictionOptions): string[] {
  if (options.environment === 'person-rights') {
    if (options.extraDenies?.length) throw new Error('Person-rights execution cannot honor denied folders.');
    return [options.command, ...options.args];
  }
  if (!process.env.HOME || unsupportedCredentialDirs(process.env).length) throw new Error('Credential paths cannot be denied safely.');
  const work = realpathSync(exact(options.work)), state = realpathSync(exact(options.state));
  const auditParent=exact(auditScratchParent()); // Never follow a link planted at this shared path.
  const denied = [...credentialLocations(process.env.HOME, process.env), ...(options.extraDenies ?? [])].map(exact);
  const paths = [...new Set([...denied.flatMap(p => [p, canonicalDeniedPath(p)]), auditParent, workspaceScratchParent(), canonicalDeniedPath(workspaceScratchParent()), ...(process.platform==='darwin'?['/private'+auditParent]:[])])];
  if (paths.some(p => contains(p, work) || contains(work, p) || contains(p, state) || contains(state, p))) throw new Error('A write-restriction folder overlaps a denied folder.');
  if (process.platform === 'darwin') {
    if (!existsSync('/usr/bin/sandbox-exec')) throw new Error('macOS sandbox-exec is unavailable.');
    const literal = (path: string) => JSON.stringify(path);
    const storage = realpathSync(exact(options.storage ?? dirname(work)));
    if (work === storage || state === storage || !contains(storage, work) || !contains(storage, state)) throw new WriteRestrictionRefused('ACP storage folder must contain both session folders as descendants.');
    const excluded = [...paths, storage].map(p => `(subpath ${literal(p)})`).join(' ');
    // Keep file-clone for ordinary copies; Host retirement strips inherited flags and ACLs.
    const profile = [BASE_POLICY, NETWORK_POLICY, `(allow file-read* (require-not (require-any ${excluded})))`, `(allow file-read* file-write* (subpath ${literal(work)}) (subpath ${literal(state)}))`, `(deny file-write* (literal ${literal(work)}) (literal ${literal(state)}))`, '(deny file-write-flags)', '(deny file-write-acl)', '(allow network-outbound (remote ip "*:*"))'].join('\n');
    return ['/usr/bin/sandbox-exec', '-p', profile, options.command, ...options.args];
  }
  if (process.platform === 'linux') throw new Error('Linux write-restriction policy has not been qualified; restricted-writes execution is refused.');
  throw new Error('No supported write-restriction profile is available; restricted-writes execution is refused.');
}
