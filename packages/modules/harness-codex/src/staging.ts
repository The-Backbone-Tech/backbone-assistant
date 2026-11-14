// Staging is never a canonical file store. Read only through ToolHost; propose imports only after
// the complete proposal set has passed validation. Capture bytes into host-owned immutable strings;
// terminating the original process group does not prove every detached descendant is dead.
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, realpath, writeFile, symlink, rm } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import { join, resolve } from 'node:path';
import type { ToolFile, ToolHost, TurnRequest } from '@backbone-next/platform/ports';
import { filesystemOverride } from './native.ts';
import { readOnlyHostBoundary, verifyReadOnlyIsolation, type SandboxCommand } from './readonly-proof.ts';

const MAX_FILES = 200;
const MAX_BYTES = 10_000_000;
const MAX_FILE_BYTES = 2_000_000;
export function safeName(name: unknown): string {
  if (typeof name !== 'string' || !name || name.length > 500 || name.includes('\\') || name.includes(':') || /[\x00-\x1f\x7f]/.test(name) || name.normalize('NFC') !== name) throw new Error('Unsafe staged file name.');
  const parts = name.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || p.startsWith('.') || /^(AGENTS(?:\.override)?\.md|CLAUDE\.md)$/iu.test(p.normalize('NFKC')) || /[. ]$/.test(p))) throw new Error('Unsafe staged path or native instruction/configuration file.');
  return name;
}
function utf8(bytes: Buffer) {
  if (bytes.length > MAX_FILE_BYTES || bytes.includes(0)) throw new Error('Staged output is not a bounded UTF-8 text file.');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new Error('Staged output is not UTF-8 text.'); }
}
/** Only the autoload restriction is mapped; traversal and other source syntax still refuse. */
function sourceName(name: string): { name: string; inspection: boolean } {
  if (typeof name !== 'string') return { name: safeName(name), inspection: false };
  const parts = name.split('/');
  const reserved = (part: string) => part.startsWith('.') || /^(AGENTS(?:\.override)?\.md|CLAUDE\.md)$/iu.test(part.normalize('NFKC'));
  if (!parts.some(reserved)) return { name: safeName(name), inspection: false };
  if (parts.some(part => part === '.' || part === '..')) throw new Error('Unsafe staged source traversal.');
  // Neutralise only the leading character, retaining all controls, separators, lengths and suffixes
  // for safeName's syntax validation. Unlike a letter, '_' cannot compose with a following
  // combining mark and accidentally make a valid NFC source fail validation. The original name
  // never becomes a filesystem target; compatibility normalisation is only for classification.
  safeName(parts.map(part => reserved(part) ? '_' + part.slice(1) : part).join('/'));
  return { name, inspection: true };
}
export type StagedSource = ToolFile & { inspectionPath?: string };
export async function stageSources(root: string, host: ToolHost, request: TurnRequest, signal: AbortSignal): Promise<{ original: Map<string, string>; inspection: Map<string, string>; sources: { name: string; version: number }[]; sourceFiles: StagedSource[] }> {
  const files = await host.list();
  if (!Array.isArray(files) || files.length > MAX_FILES) throw new Error('The staged project has too many source files.');
  const plan = files.map(file => ({ file, ...sourceName(file.name) }));
  const roots = new Set(files.map(file => file.name.split('/')[0].toLowerCase()));
  // A per-attempt namespace avoids reserving any logical source name in the person's project.
  let view: string;
  do { view = '.backbone-source-data-' + randomBytes(16).toString('hex'); } while (roots.has(view));
  const names = new Set<string>(), original = new Map<string, string>(), inspection = new Map<string, string>();
  const sourceFiles: StagedSource[] = [], map: { name: string; version: number; class: ToolFile['class']; path: string }[] = [];
  let total = 0;
  for (const [index, item] of plan.entries()) {
    if (signal.aborted) throw new Error('Staging stopped.');
    const { file, name } = item, folded = name.toLowerCase();
    if (names.has(folded)) throw new Error('Colliding staged source names.'); names.add(folded);
    const source = await host.read(name, { purpose: 'staging' });
    if (!source || source.name !== name || source.version !== file.version || typeof source.text !== 'string') throw new Error('A staged source changed or could not be read.');
    if (!['original', 'working', 'accepted'].includes(file.class) || source.class !== file.class) throw new Error('A staged source class changed or could not be read.');
    const bytes = Buffer.from(source.text, 'utf8'); utf8(bytes); total += bytes.length;
    if (total > MAX_BYTES) throw new Error('The staged project exceeds its text limit.');
    const stagedName = item.inspection ? `${view}/${String(index + 1).padStart(3, '0')}.txt` : name;
    const path = join(root, stagedName);
    await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    if (item.inspection) {
      inspection.set(stagedName, source.text);
      map.push({ name, version: file.version, class: file.class, path: stagedName });
      sourceFiles.push({ ...file, inspectionPath: stagedName });
    } else { original.set(name, source.text); sourceFiles.push({ ...file }); }
  }
  if (request.attachments.some(name => !files.some(file => file.name === name))) throw new Error('An attached source is not granted by ToolHost.');
  if (map.length) {
    const name = `${view}/manifest.json`, body = JSON.stringify({ version: 1, files: map }, null, 2) + '\n';
    total += Buffer.byteLength(body); utf8(Buffer.from(body));
    if (total > MAX_BYTES) throw new Error('The source inspection map exceeds the staged text limit.');
    await writeFile(join(root, name), body, { flag: 'wx', mode: 0o600 }); inspection.set(name, body);
  }
  // Conditional source identity and withdrawal checks retain the actual logical names and versions.
  return { original, inspection, sources: files.map(({ name, version }) => ({ name, version })), sourceFiles };
}
/**
 * Finished: a later command left it unchanged. The file a command last touched may be half made. Accepted
 * limit: if a later command changes a checkpointed file and a kill comes before its completion event, the
 * earlier stable bytes are what lands, as `unsure`.
 */
export function stableFiles<T extends { name: string; body: string }>(previous: ReadonlyMap<string, string>, proposals: readonly T[]): T[] {
  return proposals.filter((file) => previous.get(file.name) === file.body);
}
/**
 * What may be recovered from a turn cut short. Every snapshot replaces the last, so bytes that changed
 * or a snapshot refused leave nothing stale. Matching snapshots suggest a file is done; they do not prove it.
 */
export class StagedCheckpoints<T extends { name: string; body: string }> {
  private seen = new Map<string, string>();
  async take(proposals: () => Promise<readonly T[]>, save: (files: T[]) => Promise<void>) {
    let finished: T[] = [];
    try {
      const files = await proposals();
      finished = stableFiles(this.seen, files);
      this.seen = new Map(files.map((file) => [file.name, file.body]));
    } catch { this.seen = new Map(); }
    await save(finished);
  }
}
/** The last check before inference. Past it a withdrawal cannot reach the request. */
export async function confirmSources(host: ToolHost, sources: { name: string }[]) {
  const present = new Set((await host.list()).map((file) => file.name));
  if (sources.some((source) => !present.has(source.name))) throw new Error('A staged source was withdrawn before the model request. Nothing was sent.');
}
export async function proposedFiles(original: Map<string, string>, snapshot: unknown, inspection: ReadonlyMap<string, string> = new Map()): Promise<readonly { name: string; body: string; existing: boolean }[]> {
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray((snapshot as { files?: unknown }).files)) throw new Error('Native staged snapshot was invalid.');
  const data = (snapshot as { inspection?: unknown }).inspection ?? [];
  if (!Array.isArray(data) || inspection.size > MAX_FILES + 1 || data.length !== inspection.size) throw new Error('Native inspection data is missing or changed.');
  const dataNames = new Set<string>(); let inspectionBytes = 0;
  for (const value of data) {
    if (!value || typeof value !== 'object') throw new Error('Native inspection snapshot is invalid.');
    const file = value as { name?: unknown; base64?: unknown };
    if (typeof file.name !== 'string' || !inspection.has(file.name) || dataNames.has(file.name) || typeof file.base64 !== 'string' || file.base64.length > MAX_FILE_BYTES * 1.4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.base64)) throw new Error('Native inspection data is unowned, duplicated or invalid.');
    dataNames.add(file.name);
    const bytes = Buffer.from(file.base64, 'base64'); inspectionBytes += bytes.length;
    if (inspectionBytes > MAX_BYTES || utf8(bytes) !== inspection.get(file.name)) throw new Error('Native inspection data was modified. No output was imported.');
  }
  const files = (snapshot as { files: unknown[] }).files;
  if (files.length > MAX_FILES) throw new Error('Too many staged output files.');
  const output: { name: string; body: string; existing: boolean }[] = [], seen = new Set<string>(), present = new Set<string>(); let total = inspectionBytes;
  for (const value of files) {
    if (!value || typeof value !== 'object') throw new Error('Native staged snapshot entry was invalid.');
    const file = value as { name?: unknown; base64?: unknown };
    const name = safeName(file.name), folded = name.toLowerCase();
    if (seen.has(folded) || typeof file.base64 !== 'string' || file.base64.length > MAX_FILE_BYTES * 1.4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.base64)) throw new Error('Native staged snapshot contains colliding names or invalid bytes.');
    seen.add(folded); present.add(name);
    const bytes = Buffer.from(file.base64, 'base64'); total += bytes.length;
    if (total > MAX_BYTES) throw new Error('Staged outputs exceed their text limit.');
    const body = utf8(bytes);
    if (original.get(name) !== body) output.push(Object.freeze({ name, body, existing: original.has(name) }));
  }
  if ([...original.keys()].some((name) => !present.has(name))) throw new Error('Native deletion is not supported by the document import contract.');
  return Object.freeze(output);
}
/** The same executable probe for macOS and Linux; no inference, account or outside endpoint. */
const SANDBOX_PROBE = String.raw`
const fs = require('node:fs'), net = require('node:net'), cp = require('node:child_process');
const [inside, outside, writeInside, writeOutside, secret, link, port, temp, varTemp] = process.argv.slice(1);
const check = fn => { try { fn(); return 'allowed'; } catch (e) {
  if (['EACCES', 'EPERM', 'ENOENT', 'EROFS', 'ENOTDIR'].includes(e.code)) return 'denied';
  throw e;
} };
const read = path => check(() => { if (fs.readFileSync(path, 'utf8') !== 'owned canary') throw Error('wrong canary'); });
const result = { inside_read: read(inside), outside_read: read(outside),
  inside_write: check(() => fs.writeFileSync(writeInside, 'x')),
  outside_write: check(() => fs.writeFileSync(writeOutside, 'x')),
  denied_read: read(secret), symlink_read: read(link),
  alias_read: read('/proc/self/root' + secret),
  temp_read: read(temp), temp_write: check(() => fs.writeFileSync(temp, 'x')),
  var_temp_read: read(varTemp), var_temp_write: check(() => fs.writeFileSync(varTemp, 'x')),
  child_inside_read: cp.spawnSync('/bin/cat', [inside], { stdio: 'ignore' }).status === 0 ? 'allowed' : 'denied',
  child_read: cp.spawnSync('/bin/cat', [secret], { stdio: 'ignore' }).status === 0 ? 'allowed' : 'denied' };
const socket = net.connect({ host: '127.0.0.1', port: Number(port) });
let finished = false;
const finish = value => {
  if (finished) return; finished = true; socket.destroy(); result.network = value;
  // Do not rely on Node's stdio socket classification under the native Linux seccomp policy.
  const data = Buffer.from(JSON.stringify(result) + '\n'); let offset = 0;
  while (offset < data.length) {
    const written = fs.writeSync(1, data, offset, data.length - offset);
    if (written <= 0) throw Error('probe output refused');
    offset += written;
  }
};
socket.once('connect', () => finish('allowed'));
socket.once('error', e => finish(['EACCES','EPERM','ENETUNREACH','ECONNREFUSED'].includes(e.code) ? 'denied' : 'unknown'));
socket.setTimeout(2000, () => finish('unknown'));
`;
/** Proves filesystem, descendant/alias read denial and command networking before any source/model. */
export async function verifySandbox(command: SandboxCommand, work: string, stage: string, environment: 'full' | 'contained' | 'bare' | 'readOnly' = 'contained', node = process.execPath, platform: NodeJS.Platform = process.platform, extraDenies: readonly string[] = []) {
  const outside = join(work, 'outside-canary'), inside = join(stage, 'inside-canary'), denied = join(work, 'denied'), secret = join(denied, 'canary'), link = join(stage, 'denied-link');
  await writeFile(outside, 'owned canary', { mode: 0o600 });
  await writeFile(inside, 'owned canary', { mode: 0o600 });
  await mkdir(denied, { mode: 0o700 }); await writeFile(secret, 'owned canary', { mode: 0o600 });
  await symlink(secret, link);
  const scratch: string[] = [];
  let connections = 0;
  const server = createServer(socket => { connections++; socket.end(); });
  try {
    // Some native backends add implicit scratch grants. Prove those cannot expose host siblings.
    for (const parent of ['/tmp', '/var/tmp']) {
      const root = await realpath(await mkdtemp(join(parent, 'backbone-native-probe-'))); scratch.push(root);
      await writeFile(join(root, 'canary'), 'owned canary', { mode: 0o600 });
    }
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = (server.address() as { port: number }).port;
    // A failed positive control is not evidence of denied command networking.
    await new Promise<void>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1');
      socket.once('end', resolve); socket.once('error', reject);
    });
    const baseline = connections;
    const linuxReadOnly = platform === 'linux' && environment === 'readOnly';
    const assertHost = linuxReadOnly ? await readOnlyHostBoundary(work, stage, scratch) : undefined;
    const sandbox = ['sandbox', '-C', stage, '-P', 'backbone-native-staged', '-c', filesystemOverride(environment, [...extraDenies, denied]), '-c', 'permissions.backbone-native-staged.network.enabled=false'];
    const raw = await command([...sandbox, '--', node, '--openssl-config=/dev/null', '-e', SANDBOX_PROBE, inside, outside, join(stage, 'inside-write-canary'), join(work, 'outside-write-canary'), secret, link, String(port), ...scratch.map(root => join(root, 'canary'))]);
    let result: Record<string, unknown>;
    try { const parsed = JSON.parse(raw); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error(); result = parsed; }
    catch { throw new Error('Native sandbox canary did not return a valid result.'); }
    const expected = { inside_read: 'allowed', inside_write: environment === 'readOnly' ? 'denied' : 'allowed', outside_read: environment === 'full' ? 'allowed' : 'denied', outside_write: 'denied', denied_read: 'denied', symlink_read: 'denied', child_inside_read: 'allowed', child_read: 'denied', alias_read: 'denied', network: 'denied', temp_read: environment === 'full' ? 'allowed' : 'denied', temp_write: 'denied', var_temp_read: environment === 'full' ? 'allowed' : 'denied', var_temp_write: 'denied' };
    if (Object.keys(result).some(key => !Object.hasOwn(expected, key))) throw new Error('Native sandbox canary returned unexpected properties.');
    const privateWrites = new Set(linuxReadOnly ? ['outside_write', 'temp_write', 'var_temp_write'] : []);
    const failed = Object.entries(expected).filter(([key, value]) => privateWrites.has(key) ? !(typeof result[key] === 'string' && ['allowed', 'denied'].includes(result[key])) : result[key] !== value).map(([key]) => key);
    if (connections !== baseline && !failed.includes('network')) failed.push('network');
    if (failed.length) throw new Error(`Native staged sandbox was not established (${failed.join(', ')}).`);
    if (assertHost) {
      await assertHost();
      await verifyReadOnlyIsolation(command, sandbox, work, stage, scratch, node, assertHost, ['outside_write', 'temp_write', 'var_temp_write'].map(key => result[key] === 'allowed'));
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    // All probe paths belong to this attempt, never to a data home or credential store.
    for (const path of [inside, link, join(stage, 'inside-write-canary')]) await rm(path, { force: true });
    for (const root of scratch) await rm(root, { recursive: true, force: true });
  }
}
