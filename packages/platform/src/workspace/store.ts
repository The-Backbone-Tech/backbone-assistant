import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rename, lstat, readdir, open, rmdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { canonicalHome } from '../doors/protocol.ts';
import { workspaceProcess } from './runtime.ts';
import { workspaceScratchParent } from './shared.ts';
import { workspaceCommand, WORKSPACE_RUNTIME_READS } from './policy.ts';
import { WorkspaceRefusal, type WorkspaceRefusalCode } from './result.ts';
import { assertLinuxWorkspace, LINUX_RUNTIME_READS } from './linux-policy.ts';
import { recoverRunning, runningAlive } from './running.ts';
import { detach, markRetiring, removeFolder, retireFolder, sweepGarbage, syncDirectory, system, systemEnvironment, reportCleanup } from './volume.ts';
export { workspaceCommand } from './policy.ts';

export const MAX_WORKSPACE_INPUT = 10_000_000;
export interface WorkspaceSource { name: string; version: number; materialId: string; withdrawals: number; input?: string }
export interface WorkspaceRecord { createdAt: number; expiresAt: number; sources: WorkspaceSource[]; folder: string }
export type WorkspaceCleanupStage = 'stop' | 'drain' | 'detach' | 'unlink';
export interface WorkspaceResult {
  code: number | null; stdout: string; stderr: string; reason?: string;
  refused?: WorkspaceRefusalCode;
  /** Fixed stage only; OS errors, paths and command data are never included. */
  cleanupStage?: WorkspaceCleanupStage;
  /** macOS polled-memory supervisor times; an absent later stage never confirms cleanup. */
  memoryStop?: { detectedAtMs: number; stoppedAtMs?: number; detachedAtMs?: number };
}
export interface WorkspaceRun { command: string; inputs: { name: string; bytes: Buffer }[]; signal?: AbortSignal }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const queues = new Map<string, Promise<unknown>>();
class InvalidRecord extends Error {}

/** One workspace operation at a time per home, including sweeps and removal. No data-home lock
 * is held here. Production has one admitted Host per home; .running also fences old detached workers. */
export class WorkspaceStore {
  directory: string;
  private readonly owner: string;
  private readonly key: string;
  constructor(owner: string, options: { root?: string } = {}) {
    this.owner = owner;
    this.directory = join(options.root ?? workspaceScratchParent(), hash(owner));
    this.key = canonicalHome(this.directory);
  }
  private async initialize() {
    if (isAbsolute(this.owner)) {
      const home = canonicalHome(this.owner), candidate = canonicalHome(this.directory);
      const contains = (parent: string, child: string) => parent === child || child.startsWith(parent + '/');
      const runtimeReads = process.platform === 'linux' ? LINUX_RUNTIME_READS : WORKSPACE_RUNTIME_READS;
      if (runtimeReads.some(path => contains(path, home) || contains(home, path)) || contains(home, candidate) || contains(candidate, home)) throw new WorkspaceRefusal('This data-home location overlaps the qualified workspace runtime; execution is refused.');
    }
    for (const path of [join(this.directory, '..'), this.directory]) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o700) throw new WorkspaceRefusal('Workspace storage must be private, owned and not linked.');
    }
    this.directory = realpathSync(this.directory);
  }
  private async serialized<T>(action: () => Promise<T>): Promise<T> {
    const prior = queues.get(this.key) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(action); queues.set(this.key, next);
    try { return await next; } finally { if (queues.get(this.key) === next) queues.delete(this.key); }
  }
  private async prune() {
    await rmdir(this.directory).catch(error => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; });
  }
  private async load(folder: string): Promise<WorkspaceRecord | null> {
    try {
      const info = await lstat(folder); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Replaced workspace.');
      const size = (await lstat(join(folder, 'record.json'))).size;
      if (size > 262_144) throw new InvalidRecord();
      let record: WorkspaceRecord;
      try { record = JSON.parse(await readFile(join(folder, 'record.json'), 'utf8')); } catch (error) { if (error instanceof SyntaxError) throw new InvalidRecord(); throw error; }
      if (!record || !Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= record.createdAt || !Array.isArray(record.sources) || record.sources.length > 128 || record.sources.some(source => !source || typeof source.name !== 'string' || typeof source.materialId !== 'string' || !Number.isSafeInteger(source.version) || source.version < 1 || !Number.isSafeInteger(source.withdrawals) || source.withdrawals < 0 || (source.input !== undefined && !/^[A-Za-z0-9_-]+\.[a-z0-9]+$/.test(source.input)))) throw new InvalidRecord();
      return { ...record, folder };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !existsSync(folder)) return null;
      if (error instanceof InvalidRecord || (error as NodeJS.ErrnoException).code === 'ENOENT') {
        await this.retire(folder); return null;
      }
      throw error;
    }
  }
  inspect(thread: string): Promise<WorkspaceRecord | null> { return this.load(join(this.directory, hash(thread))); }
  private async retire(folder: string) {
    // Record the deletion before recovery: a missing supervisor runtime must leave
    // a pending retirement for the next sweep, never turn deletion into idle scratch.
    if (!await markRetiring(folder)) return;
    await recoverRunning(folder);
    const retired = await retireFolder(folder); if (retired) await removeFolder(retired);
  }
  private async allocate(thread: string): Promise<WorkspaceRecord> {
    const folder = join(this.directory, hash(thread)), pending = join(this.directory, `.creating-${process.pid}-${randomUUID()}`);
    await mkdir(pending, { mode: 0o700 }); await syncDirectory(this.directory);
    const createdAt = Date.now(), record: WorkspaceRecord = { folder, createdAt, expiresAt: createdAt + 86_400_000, sources: [] };
    try {
      await this.save({ ...record, folder: pending });
      if (process.platform !== 'linux') await system('/usr/bin/hdiutil', ['create', '-size', '32m', '-fs', 'HFS+', '-type', 'UDIF', '-volname', 'Workspace', join(pending, 'volume.dmg')]);
      await rename(pending, folder); await syncDirectory(this.directory); return record;
    } catch (error) { await removeFolder(pending); throw error; }
  }
  async save(record: WorkspaceRecord) {
    const body = JSON.stringify({ createdAt: record.createdAt, expiresAt: record.expiresAt, sources: record.sources });
    if (record.sources.length > 128 || Buffer.byteLength(body) > 262_144) throw new WorkspaceRefusal('Workspace source metadata limit reached (128 sources, 256 KiB).');
    const file = await open(join(record.folder, '.record-new'), 'w', 0o600);
    try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
    await rename(join(record.folder, '.record-new'), join(record.folder, 'record.json')); await syncDirectory(record.folder);
  }
  use<T>(thread: string, action: (record: WorkspaceRecord) => Promise<T>): Promise<T> {
    return this.serialized(async () => {
      if (process.platform === 'linux') await assertLinuxWorkspace(this.owner); else workspaceCommand('/tmp/qualification');
      await this.initialize(); await sweepGarbage(this.directory);
      const folder = join(this.directory, hash(thread));
      if (existsSync(join(folder, '.running'))) { await recoverRunning(folder); await detach(folder); }
      let record = await this.inspect(thread);
      if (record && (record.expiresAt <= Date.now() || existsSync(join(folder, '.retiring')))) { await this.retire(folder); record = null; }
      record ??= await this.allocate(thread);
      return action(record);
    });
  }
  run(thread: string, request: WorkspaceRun): Promise<WorkspaceResult> { return this.use(thread, record => this.execute(record, request)); }
  async execute(record: WorkspaceRecord, request: WorkspaceRun): Promise<WorkspaceResult> {
    if (typeof request.command !== 'string' || request.command.length > 32_000) throw new WorkspaceRefusal('Workspace command must be at most 32000 characters.');
    request.signal?.throwIfAborted(); if (Date.now() >= record.expiresAt) throw new WorkspaceRefusal('Workspace expired.');
    for (const input of request.inputs) if (!/^[A-Za-z0-9_-]+\.[a-z0-9]+$/.test(input.name) || input.bytes.length > MAX_WORKSPACE_INPUT) throw new WorkspaceRefusal('Invalid or oversized workspace input.');
    return new Promise((resolve, reject) => {
      // A Host process-group kill must not kill the supervisor or its timeout/cleanup logic.
      const worker = spawn(process.execPath, [workspaceProcess(process.platform === 'linux' ? 'linux-worker' : 'worker'), record.folder], { detached: true, env: { ...systemEnvironment, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      let result: WorkspaceResult | undefined;
      const abort = () => { if (worker.connected) worker.disconnect(); };
      const unconfirmed = (detail: string) => {
        request.signal?.removeEventListener('abort', abort);
        abort(); reject(new Error(detail));
      };
      request.signal?.addEventListener('abort', abort, { once: true });
      worker.on('message', message => { result = message as WorkspaceResult; });
      worker.on('error', () => unconfirmed('Workspace supervisor could not start; no command result was confirmed.'));
      worker.once('exit', () => {
        request.signal?.removeEventListener('abort', abort);
        if (request.signal?.aborted) resolve({ code: null, stdout: '', stderr: '', reason: 'stopped' });
        else if (result) resolve(result); else reject(new Error('Workspace supervisor ended without a result; scratch may be incomplete.'));
      });
      worker.send({ command: request.command, inputs: request.inputs.map(input => ({ name: input.name, base64: input.bytes.toString('base64') })), expiresAt: record.expiresAt }, error => { if (error) unconfirmed('Workspace supervisor admission could not be delivered; no command result was confirmed.'); });
      if (request.signal?.aborted) abort();
    });
  }
  remove(thread: string) {
    return this.serialized(async () => { if (!existsSync(this.directory)) return; await this.retire(join(this.directory, hash(thread))); await this.prune(); });
  }
  sweep(now = Date.now()) {
    return this.serialized(async () => {
      if (!existsSync(this.directory)) return;
      await this.initialize(); await sweepGarbage(this.directory);
      for (const name of await readdir(this.directory)) {
        if (!/^[a-f0-9]{64}$/.test(name)) continue;
        const folder = join(this.directory, name);
        try {
          if (await runningAlive(folder)) continue;
          if (existsSync(join(folder, '.running'))) { await recoverRunning(folder); await detach(folder); }
          const record = await this.load(folder);
          if (record && (record.expiresAt <= now || existsSync(join(folder, '.retiring')))) await this.retire(folder);
        } catch (error) {
          reportCleanup(name, error);
        }
      }
      await this.prune();
    });
  }
}
