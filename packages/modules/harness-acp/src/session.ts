import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { client, RequestError, type InitializeResponse } from '@agentclientprotocol/sdk';
import type { HarnessEvent, TurnRequest, ToolFile, ToolHost } from '@backbone-next/platform/ports';
import { toolBridge, type ToolTurn } from './mcp.ts';
import { privateDirectory, retireDirectory, copyRetainedTree, sweepRetired } from './storage.ts';
import { machineClientIdentity } from './machine-client.ts';
import { assertDirectory, directoryIdentity, type DirectoryIdentity } from './directories.ts';
import { AcpRefusal } from './refusal.ts';
import { scratchFile } from './files.ts';
import { AgentProcess, type AgentOptions } from './transport.ts';
import { verifyAgentExecutable } from './executable.ts';
import { AcpCompactions } from './compaction.ts';

export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface ActiveTurn extends ToolTurn { request: TurnRequest; stopped: boolean; answer: string; failure?: string; push(event: HarnessEvent): void }
type Source = { name: string; materialId: string; projectId: string; version: number; withdrawals: number };
export interface SessionRecord { sessionId: string; history: string; configuration: string; context: string; sources: Source[]; unsafeReads: boolean }
export class Session {
  private compactions = new AcpCompactions();
  agent?: AgentProcess;
  active?: ActiveTurn;
  streaming = false;
  private idleTimer?: NodeJS.Timeout;
  private connecting?: Promise<void>; private idleClosing?: Promise<unknown>;
  private generation = 0; private closed = false; private cleanupFailed = false;
  sessionId?: string;
  initialized?: InitializeResponse;
  saved?: SessionRecord;
  sources: Source[] = [];
  unsafeReads = false;
  context = '';
  cleanupWarnings: string[] = [];
  bridge?: Awaited<ReturnType<typeof toolBridge>>;
  folders!: { work: DirectoryIdentity; state: DirectoryIdentity };
  assertFolders() { assertDirectory(this.folders.work); assertDirectory(this.folders.state); }
  root: string; work: string; state: string; readonly configuration: string; readonly storage: string;
  private parent!: string; private pointer?: string; private spawned = false;
  private constructor(root: string, work: string, state: string, configuration: string, storage: string) { this.storage = storage; this.root = root; this.work = work; this.state = state; this.configuration = configuration; }
  static async create(options: AgentOptions & { storageDir?: string; temporaryRoot?: string }, threadId: string): Promise<Session> {
    // Direct and factory callers must bind the same entry before choosing a storage identity.
    const bound = { ...options };
    if (bound.acceptsProcessVisibility === true) verifyAgentExecutable(bound);
    for (let attempt = 0; ; attempt++) {
      try { return await Session.allocate(bound, threadId); }
      catch (error) { if (attempt >= 7 || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  private static async allocate(options: AgentOptions & { storageDir?: string; temporaryRoot?: string }, threadId: string): Promise<Session> {
    const configuration = digest({ command: options.command, executable: options.executable, args: options.args, environment: options.environment ?? 'restricted-writes', env: options.env ?? {}, denies: options.extraDenies ?? [], machine: machineClientIdentity(options) });
    const storagePath = options.storage ?? options.storageDir ?? join(options.temporaryRoot ?? tmpdir(), `backbone-acp-private-${process.getuid?.() ?? 'user'}`);
    const storage = await privateDirectory(storagePath);
    const parent = options.storageDir ? await privateDirectory(options.storageDir) : storage;
    const anchor = options.storageDir ? await privateDirectory(join(parent, digest({ threadId, configuration }))) : parent;
    const cleanupWarnings = await sweepRetired(anchor);
    const pointer = options.storageDir ? join(anchor, 'current.json') : undefined;
    let root: string | undefined;
    if (pointer) {
      try {
        const name: unknown = JSON.parse(await readFile(pointer, 'utf8'));
        if (typeof name === 'string' && /^session-[A-Za-z0-9]+$/.test(name)) root = join(anchor, name);
      } catch {}
    }
    const retained = !!root;
    root ??= await mkdtemp(join(anchor, 'session-'));
    const canonical = await privateDirectory(root), session = new Session(canonical, join(canonical, 'work'), join(canonical, 'agent'), configuration, storage);
    session.cleanupWarnings = cleanupWarnings;
    session.parent = anchor; session.pointer = pointer; session.spawned = retained;
    await privateDirectory(session.work); await privateDirectory(session.state);
    session.folders = { work: directoryIdentity(session.work), state: directoryIdentity(session.state) };
    await session.pointToCurrent();
    try {
      const record = JSON.parse(await readFile(join(canonical, 'session.json'), 'utf8')) as SessionRecord;
      if (record.configuration === configuration && typeof record.sessionId === 'string' && record.sessionId.length <= 1000 && typeof record.history === 'string' && typeof record.context === 'string' && Array.isArray(record.sources) && record.sources.length <= 2000) { session.saved = record; session.sources = record.sources; session.unsafeReads = !!record.unsafeReads; }
    } catch {}
    return session;
  }
  private async pointToCurrent() {
    if (this.pointer) await writeFile(this.pointer, JSON.stringify(basename(this.root)), { mode: 0o600 });
  }
  /** Revoke every old path before copying retained native state into a fresh incarnation. */
  private async fresh(preserve: boolean) {
    const old = this.root, root = await mkdtemp(join(this.parent, 'session-'));
    try {
      await retireDirectory(old, async retired => {
        if (preserve) {
          for (const name of ['work', 'agent']) await copyRetainedTree(join(String(retired), name), join(root, name));
        }
      });
      this.root = root; this.work = join(root, 'work'); this.state = join(root, 'agent');
      await privateDirectory(this.work); await privateDirectory(this.state);
      this.folders = { work: directoryIdentity(this.work), state: directoryIdentity(this.state) };
      if (preserve && this.saved) await writeFile(join(root, 'session.json'), JSON.stringify(this.saved), { mode: 0o600 });
      this.spawned = false;
      await this.pointToCurrent();
    } catch (error) { await retireDirectory(root); throw error; }
  }
  abandonConnect() { this.generation++; }
  private checkGeneration(generation: number) {
    if (generation !== this.generation || this.closed) throw new Error('ACP connection was abandoned.');
  }
  connect(options: AgentOptions): Promise<void> {
    if (this.closed) return Promise.reject(new AcpRefusal('ACP session is closed.'));
    if (this.cleanupFailed) return Promise.reject(new AcpRefusal('ACP native state cleanup is unconfirmed; this session cannot start an agent until its retired state has been removed.'));
    if (this.connecting) return this.connecting;
    const connecting = this.connectOnce(options, this.generation);
    this.connecting = connecting;
    void connecting.finally(() => { if (this.connecting === connecting) this.connecting = undefined; }).catch(() => {});
    return connecting;
  }
  private async connectOnce(options: AgentOptions, generation: number): Promise<void> {
    clearTimeout(this.idleTimer);
    try {
      await this.idleClosing;
      this.checkGeneration(generation); this.assertFolders();
      if (this.agent && !this.agent.connection.signal.aborted) return;
      if (this.agent) { await this.agent.close(); this.agent = undefined; this.sessionId = undefined; }
      if (this.spawned) {
        await this.bridge?.close(); this.bridge = undefined;
        this.checkGeneration(generation);
        await this.fresh(!!this.saved);
      }
      this.checkGeneration(generation);
      this.bridge ??= await toolBridge(() => this.active, file => this.recordRead(file), () => { this.unsafeReads = true; }, this.folders.state, () => { this.checkGeneration(generation); this.assertFolders(); });
      this.checkGeneration(generation);
    const app = client({ name: 'backbone-acp' });
    const current = (id: string) => {
      try { this.assertFolders(); } catch { throw new RequestError(-32000, 'ACP session folder was replaced or changed; access refused.'); }
      const active = this.active;
      if (!active || id !== this.sessionId || active.stopped || (active.request.stillAllowed?.() ?? true) !== true) throw new RequestError(-32000, 'This turn no longer grants client access.');
      return active;
    };
    app.onRequest('fs/write_text_file', async ({ params }) => { current(params.sessionId); await scratchFile(this.folders.work, params.path, params.content); return {}; });
    app.onRequest('fs/read_text_file', async ({ params }) => {
      current(params.sessionId);
      const content = await scratchFile(this.folders.work, params.path), line = params.line ?? 1, limit = params.limit;
      if (!Number.isInteger(line) || line < 1 || (limit != null && (!Number.isInteger(limit) || limit < 1))) throw new RequestError(-32602, 'Line and limit must be positive integers.');
      return { content: content.split('\n').slice(line - 1, limit == null ? undefined : line - 1 + limit).join('\n') };
    });
    app.onRequest('*', () => { throw new RequestError(-32000, 'The Harness port grants no client terminal or extension execution.'); });
    app.onRequest('session/request_permission', ({ params }) => {
      const reason = 'The Harness port grants no approval for agent-owned operations; permission refused.';
      this.active?.push({ type: 'tool', phase: 'refused', tool: 'native_staged', id: `acp-permission-${digest(params.toolCall.toolCallId).slice(0, 20)}`, label: reason });
      const reject = this.active && !this.active.stopped && params.sessionId === this.sessionId ? params.options.find(option => option.kind === 'reject_once') : undefined;
      return { outcome: reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' }, _meta: { reason } };
    });
    app.onNotification('session/update', ({ params }) => {
      const active = this.active;
      if (active && !active.stopped && params.sessionId === this.sessionId) {
        try {
          const compaction = this.compactions.receive(params.sessionId, params.update);
          if (compaction) active.push({ type: 'compaction', compaction });
        } catch {
          active.failure = 'ACP compaction exceeded its supported limits; this turn failed and its native session cannot be reused.';
          active.writeClosed = true; active.stop?.();
          void this.agent?.close().catch(() => {});
          return;
        }
      }
      if (this.streaming && active && !active.failure && params.sessionId === this.sessionId && params.update.sessionUpdate === 'agent_message_chunk' && params.update.content.type === 'text') {
        const delta = params.update.content.text;
        if (active.answer.length + delta.length > 2_000_000) { void this.agent?.close(); return; }
        active.answer += delta; active.push({ type: 'text', delta });
      }
    });
    this.agent = await AgentProcess.create({ ...options, storage: this.storage }, this.folders.work, this.folders.state, app, () => { this.checkGeneration(generation); this.assertFolders(); });
    this.spawned = true;
    this.initialized = await this.agent.initialize();
    this.checkGeneration(generation);
    } catch (error) {
      await Promise.allSettled([this.agent?.close(), this.bridge?.close()]);
      this.agent = undefined; this.bridge = undefined; this.sessionId = undefined;
      throw error;
    }
  }
  idle(ms: number) {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.active) return;
      const agent = this.agent, bridge = this.bridge;
      this.agent = undefined; this.bridge = undefined; this.sessionId = undefined;
      this.idleClosing = Promise.all([agent?.close(), bridge?.close()]);
      void this.idleClosing.catch(() => {});
    }, ms);
    this.idleTimer.unref();
  }
  recordRead(file: (ToolFile & { text: string }) | null) {
    if (!file) return;
    if (!file.materialId || !file.projectId || file.withdrawals === undefined) { this.unsafeReads = true; return; }
    const source = { name: file.name, materialId: file.materialId, projectId: file.projectId, version: file.version, withdrawals: file.withdrawals };
    if (!this.sources.some(s => digest(s) === digest(source))) this.sources.push(source);
    if (this.sources.length > 2000) throw new Error('ACP source tracking limit exceeded.');
  }
  async recheck(tools: ToolHost) {
    if (this.unsafeReads) return false;
    for (const source of this.sources) {
      const file = await tools.read(source.name);
      if (!file || file.materialId !== source.materialId || file.projectId !== source.projectId || file.version !== source.version || file.withdrawals !== source.withdrawals) return false;
    }
    return !this.sources.length || tools.stillGranted?.(this.sources) === true;
  }
  async remember(history: TurnRequest['history']) {
    this.saved = { sessionId: this.sessionId!, history: digest(history), configuration: this.configuration, context: this.context, sources: this.sources, unsafeReads: this.unsafeReads };
    if (this.initialized?.agentCapabilities?.loadSession) await writeFile(join(this.root, 'session.json'), JSON.stringify(this.saved), { mode: 0o600 });
  }
  async invalidate() {
    this.cleanupFailed = true;
    this.abandonConnect(); clearTimeout(this.idleTimer);
    await this.connecting?.catch(() => {}); await this.idleClosing?.catch(() => {});
    const closed = await Promise.allSettled([this.agent?.close(), this.bridge?.close()]);
    this.bridge = undefined; this.agent = undefined; this.sessionId = undefined; this.saved = undefined; this.sources = []; this.unsafeReads = false;
    this.compactions = new AcpCompactions();
    // Discard native authentication and context together after Stop, failure or withdrawal.
    await this.fresh(false);
    if (closed.some(result => result.status === 'rejected')) throw new Error('ACP resource cleanup was not confirmed.');
    this.cleanupFailed = false;
  }
  private async removeEmptyStorage() {
    // Concurrent retirements can briefly keep the shared parent nonempty. Retry only
    // empty-directory removal; never recursively remove another session's state.
    for (let attempt = 0; ; attempt++) {
      try { await rmdir(this.storage); return; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY' || attempt >= 4) return;
        await delay(10 * 2 ** attempt);
      }
    }
  }
  async close(remove: boolean) {
    this.closed = true; this.abandonConnect(); clearTimeout(this.idleTimer);
    await this.connecting?.catch(() => {}); await this.idleClosing?.catch(() => {});
    const closed = await Promise.allSettled([this.agent?.close(), this.bridge?.close()]);
    this.agent = undefined; this.bridge = undefined;
    if (remove) { await retireDirectory(this.root); await this.removeEmptyStorage(); }
    if (closed.some(result => result.status === 'rejected')) throw new Error('ACP resource cleanup was not confirmed.');
  }
}
