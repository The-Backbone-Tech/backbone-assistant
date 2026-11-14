// Qualification of the direction owner's Linux read-only host-immutability property.
// This observes the maintained sandbox; it implements no filesystem enforcement.
import { lstat, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

export type SandboxCommand = (args: string[], observe?: (output: string) => void) => Promise<string>;
const refuse = () => new Error('Native Linux read-only isolation was not established.');

/** Inventory all owned outside trees, including unexpected entries, bytes and node identity. */
export async function readOnlyHostBoundary(work: string, stage: string, scratch: string[]) {
  async function inventory() {
    const entries: unknown[] = [];
    async function walk(path: string) {
      if (path === stage) return;
      const stat = await lstat(path);
      entries.push([path, stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs,
        stat.isFile() ? (await readFile(path)).toString('base64') : null]);
      if (stat.isDirectory()) for (const name of (await readdir(path)).sort()) await walk(join(path, name));
      else if (!stat.isFile()) throw refuse();
    }
    for (const root of [work, ...scratch]) await walk(root);
    return JSON.stringify(entries);
  }
  const before = await inventory();
  return async () => { try { if (await inventory() !== before) throw refuse(); } catch { throw refuse(); } };
}

const ISOLATION_PROGRAM = String.raw`
// backbone-readonly-isolation-v1
const fs = require('node:fs');
const spec = JSON.parse(process.argv[1]);
const emit = value => {
  const bytes = Buffer.from(JSON.stringify(value) + '\n'); let offset = 0;
  while (offset < bytes.length) { const n = fs.writeSync(1, bytes, offset, bytes.length - offset); if (n <= 0) throw Error('output'); offset += n; }
};
const namespace = fs.readlinkSync('/proc/self/ns/mnt');
const inside = fs.readFileSync(spec.inside, 'utf8') === 'owned canary';
if (!inside) throw Error('inside control');
if (spec.phase === 'read') {
  const private_reads = spec.readTargets.map(path => {
    try { fs.lstatSync(path); return 'visible'; }
    catch (error) { if (['ENOENT','ENOTDIR'].includes(error.code)) return 'absent'; throw error; }
  });
  emit({ inside_read: 'allowed', namespace, private_reads });
} else {
  const writes = spec.targets.map(path => {
    try { fs.writeFileSync(path, spec.token); if (fs.readFileSync(path, 'utf8') !== spec.token) throw Error('private control'); return 'allowed'; }
    catch (error) { if (['EACCES','EPERM','ENOENT','EROFS','ENOTDIR'].includes(error.code)) return 'denied'; throw error; }
  });
  emit({ ready: true, namespace, writes });
  const deadline = Date.now() + 10000;
  const wait = () => {
    try { if (fs.readFileSync(spec.release, 'utf8') === spec.token) { emit({ released: true }); return; } }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (Date.now() > deadline) throw Error('release timeout');
    setTimeout(wait, 10);
  };
  wait();
}
`;

/** A concurrent fresh namespace and a later invocation must both lack the writer's private data. */
export async function verifyReadOnlyIsolation(command: SandboxCommand, sandbox: string[], work: string, stage: string, scratch: string[], node: string, assertHost: () => Promise<void>, requiredWrites: boolean[]) {
  const token = randomBytes(16).toString('hex'), release = join(stage, '.backbone-probe-release-' + token);
  const targets = [join(work, 'outside-private-' + token), ...scratch.map(root => join(root, 'private-' + token))];
  const readTargets = [...targets, join(work, 'outside-write-canary')];
  const spec = { targets, readTargets, release, token, inside: join(stage, 'inside-canary') };
  const args = (phase: string) => [...sandbox, '--', node, '--openssl-config=/dev/null', '-e', ISOLATION_PROGRAM, JSON.stringify({ ...spec, phase })];
  let ready!: (value: Record<string, unknown>) => void, failed!: (error: Error) => void;
  const readiness = new Promise<Record<string, unknown>>((resolve, reject) => { ready = resolve; failed = reject; });
  const writer = command(args('write'), output => {
    const line = output.split('\n')[0];
    if (!output.includes('\n')) return;
    try { ready(JSON.parse(line)); } catch { failed(refuse()); }
  });
  // Attach both outcomes immediately; an early exit cannot count as concurrent isolation.
  let exited = false;
  void writer.then(() => { exited = true; failed(refuse()); }, () => { exited = true; failed(refuse()); });
  const timer = setTimeout(() => failed(refuse()), 10000);
  async function observer(expectedNamespace?: unknown) {
    const result = JSON.parse(await command(args('read')));
    if (!result || typeof result !== 'object' || Object.keys(result).sort().join(',') !== 'inside_read,namespace,private_reads' || result.inside_read !== 'allowed' || (typeof result.namespace !== 'string' || !/^mnt:\[\d+\]$/.test(result.namespace)) ||
      (expectedNamespace !== undefined && result.namespace === expectedNamespace) ||
      !Array.isArray(result.private_reads) || result.private_reads.length !== readTargets.length ||
      result.private_reads.some((value: unknown) => value !== 'absent')) throw refuse();
  }
  try {
    const proof = await readiness;
    const writes = proof?.writes;
    if (!proof || typeof proof !== 'object' || Object.keys(proof).sort().join(',') !== 'namespace,ready,writes' || proof.ready !== true || (typeof proof.namespace !== 'string' || !/^mnt:\[\d+\]$/.test(proof.namespace)) ||
      !Array.isArray(writes) || writes.length !== targets.length ||
      writes.some(value => typeof value !== 'string' || !['allowed', 'denied'].includes(value)) ||
      requiredWrites.some((required, index) => required && writes[index] !== 'allowed') || exited) throw refuse();
    await assertHost();
    await observer(proof.namespace);
    if (exited) throw refuse();
    await assertHost();
    await writeFile(release, token, { flag: 'wx', mode: 0o600 });
    const lines = (await writer).trim().split('\n');
    if (lines.length !== 2 || lines[0] !== JSON.stringify(proof) || lines[1] !== JSON.stringify({ released: true })) throw refuse();
    await assertHost();
    await observer();
    await assertHost();
  } catch { throw refuse(); }
  finally {
    clearTimeout(timer);
    // A failed release write still joins the bounded writer and attempts marker cleanup.
    let cleanupFailed = false;
    try { if (!exited) await writeFile(release, token, { mode: 0o600 }); }
    catch { cleanupFailed = true; }
    try { await writer.catch(() => {}); }
    finally { try { await rm(release, { force: true }); } catch { cleanupFailed = true; } }
    if (cleanupFailed) throw refuse();
  }
}
