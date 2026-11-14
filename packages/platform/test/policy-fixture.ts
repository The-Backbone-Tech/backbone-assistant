// Disposable managed-machine filesystem; no production path or environment override exists.
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { join } from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { hostname } from 'node:os';
import type { TestContext } from 'node:test';
import { freshDir } from './helpers.ts';
import { policyPaths } from '../src/policy/source.ts';
import { verifyPolicy, type VerifiedPolicy } from '../src/policy/verify.ts';

export const pair = generateKeyPairSync('ed25519');
export const now = Date.parse('2026-11-10T00:00:00Z');
export const document = (requirements: object = {}, defaults: object = {}, metadata: object = {}) => ({ id: 'test-company', version: 2, requirements, defaults, ...metadata });
export function signed(value = document(), floor = 2) {
  const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  const signature = sign(null, bytes, pair.privateKey);
  const trustObject = { keys: [pair.publicKey.export({ type: 'spki', format: 'pem' })], deployment: { id: 'test-company', version: floor, sha256: createHash('sha256').update(bytes).digest('hex') }, organisation: 'test-org' };
  return { bytes, signature, trust: Buffer.from(JSON.stringify(trustObject)), machine: hostname(), now };
}
export function verified(requirements: object = {}, defaults: object = {}) {
  const result = verifyPolicy(signed(document(requirements, defaults)));
  if (result.status !== 'verified') throw new Error(JSON.stringify(result));
  return result.policy;
}
// Pure decision tests may exercise a future consumer without claiming verification succeeded.
export const decisionFixture = (requirements: object = {}, defaults: object = {}): VerifiedPolicy => ({ ...document(), requirements, defaults, warnings: [] });
export function systemFixture(t: TestContext, value = document()) {
  const root = freshDir('managed-policy-'), paths = policyPaths();
  const mapping = new Map([paths.policy, paths.signature, paths.trust].map(path => [path, join(root, path.split(/[\\/]/).at(-1)!)]));
  const initial = signed(value);
  fs.writeFileSync(mapping.get(paths.policy)!, initial.bytes);
  fs.writeFileSync(mapping.get(paths.signature)!, initial.signature);
  fs.writeFileSync(mapping.get(paths.trust)!, initial.trust);
  const lstat = fs.lstatSync.bind(fs), open = fs.openSync.bind(fs), fstat = fs.fstatSync.bind(fs), exec = childProcess.execFileSync.bind(childProcess);
  const descriptors = new Set<number>();
  const close = fs.closeSync.bind(fs);
  t.mock.method(fs, 'closeSync', (fd: number) => { descriptors.delete(fd); close(fd); });
  t.mock.method(fs, 'lstatSync', (path: string, ...args: unknown[]) => {
    if (mapping.has(String(path))) return Object.assign(lstat(mapping.get(String(path))!), { uid: 0, mode: 0o100644 });
    if ([paths.root, '/Library/Application Support', '/Library', '/etc', '/'].includes(String(path))) return Object.assign(lstat(root), { uid: 0, mode: 0o40755 });
    return lstat(path, ...args as []);
  });
  t.mock.method(fs, 'openSync', (path: string, ...args: unknown[]) => {
    if (mapping.has(String(path))) { const fd = open(mapping.get(String(path))!, ...args as [number]); descriptors.add(fd); return fd; }
    return open(path, ...args as [number]);
  });
  t.mock.method(fs, 'fstatSync', (fd: number, ...args: unknown[]) => descriptors.has(fd) ? Object.assign(fstat(fd), { uid: 0, mode: 0o100644 }) : fstat(fd, ...args as []));
  t.mock.method(childProcess, 'execFileSync', (file: string, args: string[], ...options: unknown[]) => file === '/bin/ls' && ['-lde'].includes(args[0]) ? 'protected path without ACL\n' : exec(file, args, ...options as []));
  return { paths, mapping, remove: (path: string) => fs.unlinkSync(mapping.get(path)!), tamper: () => fs.appendFileSync(mapping.get(paths.policy)!, ' '), update: (next: ReturnType<typeof document>) => {
    const input = signed(next); fs.writeFileSync(mapping.get(paths.policy)!, input.bytes); fs.writeFileSync(mapping.get(paths.signature)!, input.signature); fs.writeFileSync(mapping.get(paths.trust)!, input.trust);
  } };
}
