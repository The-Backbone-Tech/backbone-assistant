// Fixed system discovery: user environment and home paths cannot select trust or policy.
import fs from 'node:fs';
import { join, parse } from 'node:path';
import { hostname } from 'node:os';
import { createProtectedReader, openPolicyFile } from './secure-files.ts';
import { verifyPolicy, refuse, refusal, type PolicyResult, type VerifiedPolicy } from './verify.ts';

export function policyPaths(platform: NodeJS.Platform = process.platform) {
  const root = platform === 'darwin' ? '/Library/Application Support/backbone' : platform === 'win32' ? 'C:/ProgramData/backbone' : '/etc/backbone';
  return { root, policy: join(root, 'managed-policy.json'), signature: join(root, 'managed-policy.json.sig'), trust: join(root, 'policy-trust.json') };
}
function present(path: string): boolean {
  try { fs.lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
let cached: { key: string; result: PolicyResult } | undefined;
function atCurrentTime(result: PolicyResult): PolicyResult {
  if (result.status === 'verified' && result.policy.notAfter && Date.now() >= Date.parse(result.policy.notAfter)) return { status: 'refused', code: 'expired', detail: 'Managed policy refused (expired): the signed policy has expired.' };
  return result;
}
/** Read-only, process-local cache; every call rechecks ctime/size, ancestors and expiry. */
export function policyFor(_home: string): PolicyResult {
  const paths = policyPaths(), files = [paths.policy, paths.signature, paths.trust];
  try {
    const found = files.map(present);
    if (!found.some(Boolean)) return { status: 'none' };
    if (!found.every(Boolean)) refuse('missing', 'policy, detached signature and protected trust are all required.');
    const reader = createProtectedReader(parse(paths.root).root, 0);
    const machine = hostname(), key = `${process.platform}:${machine}:${reader.fingerprint(files)}`;
    if (cached?.key === key) return atCurrentTime(cached.result);
    const result = verifyPolicy({ bytes: reader.read(paths.policy), signature: reader.read(paths.signature), trust: reader.read(paths.trust), machine, now: Date.now() });
    if (key !== `${process.platform}:${hostname()}:${reader.fingerprint(files)}`) refuse('io', 'system policy changed while it was being verified; retry before starting work.');
    cached = { key, result: Object.freeze(result) };
    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code && (!(error instanceof Error) || error.name !== 'PolicyRefused')) return { status: 'refused', code: 'io', detail: 'Managed policy refused (io): system policy could not be read securely.' };
    return refusal(error);
  }
}
/** Inspect a candidate; never installs it or makes it effective. Trust still comes from the system. */
export function verifyPolicyFile(file: string): PolicyResult {
  const paths = policyPaths();
  try { return verifyPolicy({ bytes: openPolicyFile(file), signature: openPolicyFile(`${file}.sig`), trust: createProtectedReader(parse(paths.root).root, 0).read(paths.trust), machine: hostname(), now: Date.now() }); }
  catch (error) { return { status: 'refused', code: 'io', detail: 'Managed policy refused (io): candidate, signature or protected system trust could not be read.' }; }
}
export function governedPolicy(home: string): VerifiedPolicy | undefined { return requirePolicy(policyFor(home)); }
export function requirePolicy(result: PolicyResult): VerifiedPolicy | undefined {
  if (result.status === 'refused') refuse(result.code, result.detail);
  return result.status === 'verified' ? result.policy : undefined;
}
