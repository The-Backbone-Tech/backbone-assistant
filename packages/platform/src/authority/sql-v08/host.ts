// One thread on the v0.8 kernel behind the Host contract: the same `call`, Gateway, turn code and
// material store as composition/host.ts, in a composition of its own, because that host is written
// against the older core. Synthetic and separate: nothing in the normal route reaches this, and it
// answers only the methods one thread needs. Two kernels never hold live truth for one home.
import { randomUUID } from 'node:crypto';
import { existsSync, chmodSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Args, Method, Project, Receipt, Result, Thread, Turn } from '../../api.ts';
import { assertHomeWriteAdmission, HomeWriteUnavailable, withHomeLock } from '../../composition/home-lock.ts';
import { claimHomeKernel } from '../../composition/home-kernel.ts';
import { readJson, sha256, writeAtomic, writeJson } from '../../stub/fsx.ts';
import { HARNESS_LABEL, runTurn } from '../../stub/harness.ts';
import { isText, MaterialStore } from '../../stub/material.ts';
import { custodyRun, saveThreadProjection, settleUnproposedWrites } from '../../composition/thread-custody.ts';
import { recoveredStatus } from '../../composition/harness-turn.ts';
import { projectRecoveredWrites, writtenVersion, type StoredWrite } from '../../composition/recovered-writes.ts';
import type { Host } from '../../composition/host.ts';
import { ownHome } from '../../composition/home-owner.ts';
import { holdWorkspaceDoor, type DoorHold } from './door-hold.ts';
import { argsDigest, argsOf, createDocumentDoor, originalKey, originalOf, type V08WritePoint } from './document-door.ts';
import { openSqlV08PersonalRuntime } from './transport.ts';
import type { ContractTerms, EffectAttempt, PersonalInstallation, PromotionObserved, RunHandle, SqlOutcome, SqlPool, SqlV08PersonalRuntime, TrustedPersonalSessionOwner } from './types.ts';

export interface V08HostOptions {
  home: string;
  appPool: SqlPool;
  observerPool: SqlPool;
  binding: PersonalInstallation;
  /** The person's session owner (session-owner.ts). Nothing here defaults to a fixture. */
  sessions: TrustedPersonalSessionOwner;
  writeDelayMs?: number;
  /** How long one call to the kernel may take before its outcome counts as unknown. */
  sqlTimeoutMs?: number;
  /** A dispatcher's claim. A killed one's write stays open this long before it can be called UNKNOWN. */
  dispatchLeaseMs?: number;
  /** Tests hold a write at a point. */
  pause?(point: V08WritePoint): Promise<void>;
}
/** What was confirmed: this attempt, and the digest of the words the effect showed. */
export interface UnknownConfirmation { attempt: string; statementSha256: string }
export interface PromotionUnknown { intent: string; snapshot: string; statement: string }
export type V08Host = Pick<Host, 'call'> & {
  /** A confirmation that a write with no bytes at the source did not happen, of the exact statement shown. */
  settleUnknown(input: { threadId: string; attempt: string; confirmation?: UnknownConfirmation }): Promise<Receipt<{ outcome: 'REFUSED' }>>;
  /** A person's word on a held write, of the exact statement shown. The turn waits for it. */
  decideHeld(input: { threadId: string; attempt: string; decision: 'accept' | 'deny'; confirmation?: UnknownConfirmation }): Promise<Receipt<{ outcome: 'ACCEPTED' | 'REFUSED' }>>;
  /** Promotions whose landing is UNKNOWN, each with the statement a settlement must confirm. */
  promotionUnknowns(): Promise<Receipt<readonly PromotionUnknown[]>>;
  /** The owner's settlement of one snapshot's UNKNOWN, once its checker is gone. Nothing is resent. */
  settlePromotionUnknown(input: PromotionUnknown & { observed: PromotionObserved; confirmation?: UnknownConfirmation }): Promise<Receipt<{ outcome: PromotionObserved; detail: string }>>;
  close(): Promise<void>;
};

type StoredProject = Project & { dir: string };
type StoredThread = Omit<Thread, 'card'> & { clientKeys: string[]; plane?: string; task?: string };
type CrashPoint = V08WritePoint | 'turn.finished' | 'recover.projected';
const now = () => new Date().toISOString();
const refused = <T>(reason: 'NOT_FOUND' | 'NOT_AVAILABLE' | 'INVALID', detail: string): Receipt<T> => ({ ok: false, reason, detail, outcome: 'REFUSED' });
const DAY = 86_400_000;
const UNSURE = 'This turn stopped and the record of its writes could not be read, so whether it wrote anything is unsure. Nothing was sent again.';
const NOT_WRITTEN = 'This turn stopped before its write reached the record, so nothing was written. Send it again to continue.';
const PENDING = ['attempted', 'claimed', 'dispatching'];
const NOT_STARTED = 'This turn could not start, so nothing was sent.';
const NOT_CLOSED = 'The close of this turn\'s run is not confirmed, so it may still be open. The next start closes it.';
const LOST = 'This host lost its hold on the workspace, so it has stopped acting.';
const CLOSE_TRIES = 3;
const UNREADABLE = 'The record of this write cannot say what to look for, so it stays held.';
/** What the person is asked, in the session owner's own surface, before a write's UNKNOWN is settled. */
const notWrittenQuestion = (target: string, statement: string) => `${statement}\n\nConfirm that ${target} was not written? Nothing will be resent.`;
const heldQuestion = (q: { statement: string; decision: 'accept' | 'deny'; project: string; name: string; body: string; sha256: string }) =>
  `${q.statement}\n\n${q.decision === 'accept' ? 'Let this write go ahead?' : 'Refuse this write?'} Project ${q.project}, file ${q.name}, ${Buffer.byteLength(q.body)} bytes, content sha256 ${q.sha256}.${q.decision === 'accept' ? `\n\nThe content, in full:\n${q.body}` : ''}`;
const notFound = (name: string) => `${name} was not found at the source, but that cannot prove it never landed. It stays held and will not be resent. If you know it was not written, confirm that to release it.`;
const STATUS: Record<string, string> = { executed: 'succeeded' };
/** An attempt recovery could not end is reported as what it is: not settled, and still held. */
const unresolved = (row: EffectAttempt): string => (PENDING.includes(row.status) ? 'unknown' : row.status);
/** True once the run is known closed. False: it may still be running, and restart closes it. */
type Close = (status?: 'finished' | 'cancelled') => Promise<boolean>;
const committed = <T>(outcome: SqlOutcome<T>, what: string): T => {
  if (outcome.status !== 'committed') throw new Error(`${what}: ${outcome.status}`);
  return outcome.value;
};

export async function createV08Host(options: V08HostOptions): Promise<V08Host> {
  const { home, binding } = options;
  const leaseMs = options.dispatchLeaseMs ?? 30_000;
  const settleWaitMs = leaseMs + 2_000;
  const writeDelayMs = options.writeDelayMs ?? 0;
  const pause = options.pause ?? (async () => {});
  const crash = (point: CrashPoint) => { if (process.env.BACKBONE_CRASH_AT === point) process.kill(process.pid, 'SIGKILL'); };
  const opened = await openSqlV08PersonalRuntime({ appPool: options.appPool, observerPool: options.observerPool, binding, sessions: options.sessions, timeoutMs: options.sqlTimeoutMs });
  if (opened.status !== 'ready') throw new Error(`The v0.8 kernel did not open (${opened.status}).`);
  const runtime: SqlV08PersonalRuntime = opened.runtime;
  /** Only an owner that declares a human answers may have its word reported as the person's. */
  const attested = options.sessions.attests === 'person';
  const database = committed(await runtime.door.database(), 'database');
  mkdirSync(home, { recursive: true });
  const releaseHome = await ownHome(home);
  let hold: DoorHold;
  try { hold = await holdWorkspaceDoor(options.observerPool, binding.workspaceId); }
  catch (error) { await releaseHome(); throw error; }
  const release = async () => { hold.release(); await releaseHome(); };
  const projectsPath = join(home, 'projects.json');
  const threads = new Map<string, StoredThread>();
  let projects: StoredProject[];
  try {
    await withHomeLock(home, async () => claimHomeKernel(home, { kernel: 'v0.8', database, workspace: binding.workspaceId }));
    mkdirSync(join(home, 'threads'), { recursive: true });
    projects = readJson<StoredProject[]>(projectsPath, []);
    for (const f of readdirSync(join(home, 'threads')).filter((name) => name.endsWith('.json'))) {
      const t = readJson<StoredThread>(join(home, 'threads', f), null as unknown as StoredThread);
      threads.set(t.summary.id, t);
    }
  } catch (error) { await release(); throw error; }
  const projectDir = (id: string) => join(home, 'projects', projects.find((p) => p.id === id)?.dir ?? id);
  const material = new MaterialStore(home, {}, (entry, bytes) => {
    crash('write.projecting');
    const target = join(projectDir(entry.projectId), entry.name);
    if (existsSync(target)) chmodSync(target, 0o644);
    writeAtomic(target, bytes);
  }, (entry) => join(projectDir(entry.projectId), entry.name));

  const running = new Map<string, { controller: AbortController; close: Close }>();
  /** Held writes a live turn is waiting on. */
  const deciding = new Map<string, (word: 'accepted' | 'denied') => void>();
  hold.lost.addEventListener('abort', () => { for (const live of running.values()) live.controller.abort(); }, { once: true });
  const inflight = new Set<Promise<unknown>>();
  let closed = false;
  const saveThread = async (t: StoredThread) => { t.summary.updatedAt = now(); await saveThreadProjection(home, t); };

  /** Each thread is one task under one contract; a turn is one run. Run secrets stay in this process. */
  const mustHold = () => { if (hold.lost.aborted) throw new Error(LOST); };
  async function formContract(thread: StoredThread) {
    const plane = committed(await runtime.person.createPlane(thread.summary.title), 'plane');
    const task = committed(await runtime.person.createTask(plane, thread.summary.title), 'task');
    const terms: ContractTerms = { purpose: task, data: ['project-material'], tools: ['workspace'], destinations: ['write_document'], models: ['stub'], budget: 1_000, ceiling: 2, ttlMs: 30 * DAY, checker: false };
    committed(await runtime.person.formContract(plane, terms), 'contract');
    thread.plane = plane;
    thread.task = task;
  }

  /**
   * Finished is asked of the kernel, which refuses a run with anything open; that run is cancelled.
   * A close with no answer may have committed, so the run is read before it is tried again.
   */
  function closer({ run, fence }: RunHandle): Close {
    let closing: Promise<boolean> | undefined;
    const attempt = async (wanted: 'finished' | 'cancelled') => {
      let status = wanted;
      for (let tries = 0; tries < CLOSE_TRIES; tries++) {
        if (tries) await new Promise((r) => setTimeout(r, 100));
        const closed = await runtime.door.closeRun(run, fence, status);
        if (closed.status === 'committed') return true;
        if (closed.status === 'denied' && status === 'finished') { status = 'cancelled'; continue; }
        const state = await runtime.door.readRun(run);
        if (state.status === 'committed' && state.value && state.value.status !== 'running') return true;
      }
      return false;
    };
    return (status = 'cancelled') => (closing ??= attempt(status).then((done) => { if (!done) closing = undefined; return done; }));
  }

  function carry(thread: StoredThread, turn: Turn, handle: RunHandle, controller: AbortController, close: Close) {
    const projectId = thread.summary.projectId;
    const p = (async () => {
      try {
        const decision = (attempt: string, signal: AbortSignal) => new Promise<'accepted' | 'denied' | 'stopped'>((resolve) => {
          if (signal.aborted) return resolve('stopped');
          deciding.set(attempt, resolve);
          signal.addEventListener('abort', () => { deciding.delete(attempt); resolve('stopped'); }, { once: true });
        });
        const gateway = createDocumentDoor({ decision, home, door: runtime.door, handle, threadId: thread.summary.id, turnId: turn.id, projectId, material, leaseMs, writeDelayMs, signal: controller.signal, crash, pause, closeRun: async () => { if (!(await close())) throw new Error('the run could not be closed'); }, held: () => hold.held() });
        await runTurn({ material, projectId, gateway, writeDelayMs: 0, signal: controller.signal }, turn, turn.user.attachments.flatMap((a) => material.load(a.materialId) ?? []));
        if (turn.status === 'done') turn.completed = true;
      } catch (error) {
        turn.status = 'stopped';
        turn.answer = { text: `The turn failed: ${String(error)}`, files: [] };
      } finally {
        await saveThread(thread).catch(() => {});
        crash('turn.finished');
        // Finished means the turn did all it said. Either close fences any late attempt.
        if (!(await close(turn.status === 'done' && !controller.signal.aborted && turn.effects.every((e) => e.outcome === 'DONE') ? 'finished' : 'cancelled'))) {
          turn.status = 'stopped';
          turn.answer = { text: `${turn.answer?.text ?? ''} ${NOT_CLOSED}`.trim(), files: turn.answer?.files ?? [] };
        }
        turn.work.endedAt = now();
        running.delete(thread.summary.id);
        thread.summary.running = false;
        await saveThread(thread).catch(() => {});
      }
    })().finally(() => inflight.delete(p));
    inflight.add(p);
  }

  /** Every run this thread's custody names, read as it stands: an unreadable entry still names one. */
  function custodyRuns(thread: StoredThread): string[] {
    const stored = readJson<{ writeCustody?: { writes?: Record<string, { run?: unknown }> } }>(join(home, 'threads', `${thread.summary.id}.json`), {});
    return Object.values(stored.writeCustody?.writes ?? {}).flatMap((write) => (typeof write?.run === 'string' ? [write.run] : []));
  }

  /** The file names of a turn's writes, from the private custody written before any attempt. */
  function custodied(thread: StoredThread, turn: Turn): string[] {
    const stored = readJson<{ writeCustody?: { writes?: Record<string, unknown> } }>(join(home, 'threads', `${thread.summary.id}.json`), {});
    return Object.keys(stored.writeCustody?.writes ?? {}).filter((key) => key.startsWith(`${turn.id}:`)).map((key) => key.slice(turn.id.length + 1));
  }

  /**
   * The folder holds the current version, so that is what is finished, whichever version recovery
   * proved: a later one answers for the folder. False: the file there is no version of this
   * document, so it is someone's. It is never replaced, it goes to the person, and the write stays UNKNOWN.
   */
  function finishProjection(args: StoredWrite['args'], projectId: string): boolean {
    const entry = material.load(args.document_id);
    if (!entry) return false;
    const current = entry.versions.find((v) => v.n === entry.current);
    const target = join(projectDir(projectId), entry.name);
    if (existsSync(target)) {
      const seen = sha256(readFileSync(target));
      if (seen === current?.sha256) return true;
      if (!entry.versions.some((v) => v.sha256 === seen)) {
        if (!entry.folderConflict) material.mark(entry.id, { hidden: entry.hidden, folderConflict: true });
        return false;
      }
      chmodSync(target, 0o644);
    }
    writeAtomic(target, material.bytes(entry.id, entry.current));
    return true;
  }

  /**
   * Say what is true of a turn, from attempts recovery has already settled. Nothing here sends: only
   * exact bytes found at the source reconcile an UNKNOWN. Unreadable custody proves nothing, so the
   * task's own attempts stand, and only valid custody showing no attempt says nothing was written.
   */
  async function recoverTurn(thread: StoredThread, turn: Turn, rows: readonly EffectAttempt[], ended: ReadonlySet<string>) {
    const projectId = thread.summary.projectId;
    const threadId = thread.summary.id;
    let run: string | null = null;
    try { run = await custodyRun(home, threadId, turn.id, projectId); } catch { /* Unreadable: unsure below. */ }
    const writes: StoredWrite[] = [];
    const conflicts = new Set<string>();
    const absent = new Set<string>();
    const names = custodied(thread, turn);
    for (const name of names) {
      const row = rows.find((r) => originalKey(turn.id, name) === r.key);
      if (!row) continue;
      const target = await originalOf(home, threadId, turn.id, projectId, row, name);
      // Custody that no longer matches its digests proves nothing, so the row stands as it is.
      const args = target ? argsOf(target) : { document_id: '', title: name, content_sha256: '', base_version: null };
      let status = unresolved(row);
      const landed = target && (status === 'unknown' ? writtenVersion(material, args, projectId) : status === 'executed') ? await withHomeLock(home, async () => finishProjection(args, projectId)) : null;
      crash('recover.projected');
      if (landed === false) { status = 'unknown'; conflicts.add(row.id); }
      // Only now: the hold lifts when the person can open the file, and a kill before this keeps it.
      else if (landed && row.status === 'unknown') { mustHold(); committed(await runtime.door.reconcile(row.id, 'executed', args.content_sha256), 'reconcile'); status = 'executed'; }
      if (!target && status === 'executed') status = 'unknown';
      if (target && landed === null && row.status === 'unknown') absent.add(row.id);
      writes.push({ id: row.id, status: STATUS[status] ?? status, key: row.key, run: row.run, args });
    }
    // Any other attempt of this turn's run is evidence, though custody cannot say what it was.
    const known = new Set(names.map((name) => originalKey(turn.id, name)));
    for (const row of rows.filter((r) => r.run === run && !known.has(r.key))) {
      writes.push({ id: row.id, status: ['failed', 'denied'].includes(row.status) ? row.status : 'unknown', key: row.key, run: row.run, args: { document_id: '', title: 'an unnamed file', content_sha256: '', base_version: null } });
    }
    const result = projectRecoveredWrites(writes, material, projectId);
    for (const effect of result.effects) if (conflicts.has(effect.key)) effect.detail = `A different file is in the folder at ${effect.target}, so this write is UNKNOWN. That file was kept, and nothing will be resent.`;
    for (const effect of result.effects) if (absent.has(effect.key)) effect.detail = notFound(effect.target);
    turn.effects = result.effects;
    if (!writes.length) {
      // Only a run the kernel shows closed proves no attempt can still follow.
      const proved = run !== null && ended.has(run);
      if (run !== null && proved) await settleUnproposedWrites(home, threadId, run, turn.id, projectId);
      turn.answer = { text: proved ? NOT_WRITTEN : UNSURE, files: [] };
      turn.status = 'stopped';
    } else {
      turn.status = recoveredStatus(turn, result.effects, result.files.length);
      turn.answer = { text: turn.completed ? result.detail : `This work was interrupted. ${result.detail}`, files: result.files };
    }
    turn.work.endedAt = now();
  }

  /**
   * Nothing of this process holds a run yet, and the owner lock proves no other process does, so a
   * live run is a dead one's and closes first. Then every open attempt of this home's runs settles,
   * found by its state in SQL and not by how its turn ended: not begun is denied, begun lapses to UNKNOWN.
   */
  async function settleAttempts() {
    const tasks = new Set([...threads.values()].flatMap((thread) => thread.task ?? []));
    // Custody names a run even when a thread lost its task.
    const named = new Set([...threads.values()].flatMap((thread) => custodyRuns(thread)));
    const known = committed(await runtime.door.allRuns(), 'runs').filter((run) => tasks.has(run.task) || named.has(run.id));
    mustHold();
    // The door closes it, so a dead process's run needs no person there.
    for (const run of known.filter((r) => r.status === 'running')) committed(await runtime.door.closeRun(run.id, run.fence, 'cancelled'), 'close');
    const mine = new Set(known.map((run) => run.id));
    // A lease lapses within leaseMs. What is still open after that stays held and is reported.
    const deadline = Date.now() + settleWaitMs;
    for (;;) {
      mustHold();
      const rows = committed(await runtime.door.attemptsOf([...mine]), 'attempts');
      const open = rows.filter((row) => PENDING.includes(row.status));
      if (!open.length || Date.now() >= deadline) return { rows, ended: mine };
      committed(await runtime.door.sweep(), 'sweep');
      // The close ended what was waiting. The sweep ends a claim once it lapses, and needs no claim of its own.
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async function recover() {
    const { rows, ended } = await settleAttempts();
    for (const thread of threads.values()) {
      const named = (turn: Turn) => custodied(thread, turn).map((name) => originalKey(turn.id, name));
      const uncertain = (turn: Turn) => turn.effects.some((effect) => effect.outcome === 'UNKNOWN') || rows.some((row) => (row.status === 'unknown' || PENDING.includes(row.status)) && named(turn).includes(row.key));
      for (const turn of thread.turns.filter((t) => t.status === 'running' || uncertain(t))) await recoverTurn(thread, turn, rows, ended);
      thread.summary.running = false;
      await saveThread(thread);
    }
  }
  // A failed recovery leaves the turn running and says so: an unreachable kernel cannot prove nothing was written.
  const recovering = recover().catch(async () => {
    for (const thread of threads.values()) {
      const open = thread.turns.filter((t) => t.status === 'running');
      for (const turn of open) turn.answer = { text: UNSURE, files: [] };
      if (open.length) await saveThread(thread).catch(() => {});
    }
  });

  const handlers: { [M in Method]?: (a: Args<M>) => Promise<Result<M>> | Result<M> } = {
    'projects.create': ({ name, kind, clientKey }) => {
      if (clientKey !== undefined) return refused('NOT_AVAILABLE', 'Durable project creation is not supported by this Host.');
      let madeFolder = false;
      return withHomeLock<Receipt<Project>>(home, async () => {
        const id = randomUUID();
        const stored: StoredProject = { id, name: name.trim(), kind, createdAt: now(), dir: id };
        assertHomeWriteAdmission(home, join(home, 'projects'));
        mkdirSync(join(home, 'projects', stored.dir), { recursive: true });
        madeFolder = true;
        const next = [...projects, stored];
        assertHomeWriteAdmission(home);
        writeJson(projectsPath, next);
        projects = next;
        const { dir: _dir, ...project } = stored;
        return { ok: true, value: project };
      }).catch(error => {
        if (!(error instanceof HomeWriteUnavailable)) throw error;
        return { ok: false, reason: 'NOT_AVAILABLE', outcome: madeFolder ? 'UNKNOWN' : 'REFUSED', detail: madeFolder
          ? 'Project creation lost write admission after it began. Inspect the project folder and project list before another attempt.'
          : 'Project creation has no write admission. This request created nothing.' };
      });
    },
    'threads.list': () => [...threads.values()].map((t) => t.summary),
    'threads.get': ({ id }) => {
      const t = threads.get(id);
      if (!t) return refused('NOT_FOUND', `No thread ${id}.`);
      return { ok: true, value: { summary: t.summary, turns: t.turns, sideTurns: t.sideTurns, card: { project: '', changes: { added: 0, removed: 0, files: 0 }, subagents: { active: 0, done: 0 }, sources: [] } } };
    },
    'turns.send': async ({ threadId, projectId, text, attachments, settings, clientKey }) => {
      let launch: (() => void) | undefined;
      await recovering;
      const result = await withHomeLock<Result<'turns.send'>>(home, async () => {
        if (!projects.some((p) => p.id === projectId)) return refused('NOT_FOUND', 'No such project.');
        let t = threadId ? threads.get(threadId) : undefined;
        if (threadId && !t) return refused('NOT_FOUND', `No thread ${threadId}.`);
        if (!t) {
          const id = randomUUID();
          t = { summary: { id, projectId, title: text.trim().split('\n')[0].slice(0, 60) || 'New thread', pinned: false, unread: false, archived: false, running: false, updatedAt: now() }, turns: [], sideTurns: [], clientKeys: [] };
          threads.set(id, t);
        }
        const thread = t;
        const prior = thread.turns.find((_, i) => thread.clientKeys[i] === clientKey);
        if (prior) return { ok: true, value: { threadId: thread.summary.id, turnId: prior.id } };
        if (thread.summary.running) return refused('NOT_AVAILABLE', 'A turn is already running in this thread; stop it or wait.');
        if (closed) return refused('NOT_AVAILABLE', 'This host is closing.');
        if (!thread.task) {
          try { await formContract(thread); }
          catch {
            if (!thread.turns.length) threads.delete(thread.summary.id);
            return refused('NOT_AVAILABLE', NOT_STARTED);
          }
        }
        const entries = attachments.flatMap((id) => material.load(id) ?? []);
        const turn: Turn = { id: randomUUID(), side: false, user: { text, attachments: entries.map((e) => ({ materialId: e.id, name: e.name, version: e.current })), settings, at: now() }, work: { startedAt: now(), steps: [], harness: HARNESS_LABEL }, effects: [], status: 'running' };
        thread.turns.push(turn);
        thread.clientKeys.push(clientKey);
        thread.summary.running = true;
        await saveThread(thread);
        let handle: RunHandle | undefined;
        try {
          handle = committed(await runtime.person.admitRun({ plane: thread.plane!, task: thread.task! }), 'run');
          committed(await runtime.observer.observeExecution(handle, { model: 'stub', pin: 'stub', family: 'stub', provider: 'none', region: 'this-computer', harness: sha256(HARNESS_LABEL) }), 'execution');
        } catch {
          // A run this cannot see closes at the next start, with the rest of the task's.
          if (handle) await closer(handle)().catch(() => {});
          turn.status = 'stopped';
          turn.answer = { text: NOT_STARTED, files: [] };
          turn.work.endedAt = now();
          thread.summary.running = false;
          await saveThread(thread);
          return refused('NOT_AVAILABLE', NOT_STARTED);
        }
        const admitted = handle;
        const controller = new AbortController();
        if (closed || hold.lost.aborted) controller.abort();
        const close = closer(admitted);
        running.set(thread.summary.id, { controller, close });
        launch = () => carry(thread, turn, admitted, controller, close);
        return { ok: true, value: { threadId: thread.summary.id, turnId: turn.id } };
      });
      launch?.();
      return result;
    },
    'turns.stop': async ({ threadId }) => {
      const live = running.get(threadId);
      // The closed run is the durable Stop: nothing on this path resumes a turn, so nothing else need bind.
      live?.controller.abort();
      return { ok: true, value: { stopped: !!live && await live.close() } };
    },
    'material.list': ({ projectId, includeHidden }) => withHomeLock(home, async () => material.list(projectId, includeHidden)),
    'material.read': ({ id, version }) => withHomeLock(home, async () => {
      const entry = material.load(id);
      if (!entry) return refused('NOT_FOUND', `No material ${id}.`);
      const bytes = material.bytes(id, version ?? entry.current);
      return { ok: true, value: isText(entry) ? { entry, text: Buffer.from(bytes).toString('utf8') } : { entry, base64: Buffer.from(bytes).toString('base64') } };
    }),
  };

  /**
   * The honest end of an UNKNOWN with no bytes: absence at the source cannot prove the write never
   * landed, since a restored home looks the same, so restart never lifts it. Only a confirmation of
   * the exact statement shown can. This records `failed` after the door's own look, and sends nothing.
   * The record says who confirmed it: the person, or a fixture when the presence is scripted.
   */
  async function settleUnknown({ threadId, attempt, confirmation }: Parameters<V08Host['settleUnknown']>[0]): Promise<Receipt<{ outcome: 'REFUSED' }>> {
    await recovering;
    mustHold();
    const thread = threads.get(threadId);
    const turn = thread?.turns.find((t) => t.effects.some((effect) => effect.key === attempt));
    const effect = turn?.effects.find((e) => e.key === attempt);
    if (!thread || !turn || !effect) return refused('NOT_FOUND', `No write ${attempt} in that thread.`);
    const projectId = thread.summary.projectId;
    let run: string | null = null;
    try { run = await custodyRun(home, threadId, turn.id, projectId); } catch { /* Unreadable: refused below. */ }
    if (!run) return refused('NOT_AVAILABLE', UNREADABLE);
    const rows = await runtime.door.attempts(run);
    const row = rows.status === 'committed' ? rows.value.find((r) => r.id === attempt) : undefined;
    const state = await runtime.door.readRun(run);
    if (!row || state.status !== 'committed' || !state.value || state.value.status === 'running' || !['unknown', 'failed'].includes(row.status)) return refused('NOT_AVAILABLE', 'This write is not an UNKNOWN of a closed run.');
    const statement = effect.outcome === 'UNKNOWN' ? effect.detail : undefined;
    if (!confirms(confirmation, attempt, statement)) return refused('NOT_AVAILABLE', 'This needs a confirmation of this write and of the exact statement shown.');
    // The same confirmation gives the same digest, so a reconciliation of this one can be told from any other failure.
    const observation = sha256(JSON.stringify({ attempt, statement: confirmation!.statementSha256, session: binding.personId, attests: options.sessions.attests ?? 'fixture' }));
    const reproject = async () => {
      await recoverTurn(thread, turn, committed(await runtime.door.attempts(run), 'attempts'), new Set([run]));
      return turn.effects.find((e) => e.key === attempt);
    };
    if (row.status === 'failed' && row.reconciliation !== observation) {
      await reproject();
      await saveThread(thread);
      return refused('NOT_AVAILABLE', 'This write already failed, and not by this confirmation.');
    }
    if (row.status === 'unknown') {
      const name = custodied(thread, turn).find((n) => originalKey(turn.id, n) === row.key);
      const target = name ? await originalOf(home, threadId, turn.id, projectId, row, name).catch(() => null) : null;
      if (!target) return refused('NOT_AVAILABLE', UNREADABLE);
      const args = argsOf(target);
      const found = await withHomeLock(home, async () => {
        const folder = join(projectDir(projectId), target.name);
        return !!writtenVersion(material, args, projectId) || (existsSync(folder) && sha256(readFileSync(folder)) === args.content_sha256);
      });
      if (found) return refused('NOT_AVAILABLE', `${target.name} was found at the source, so it cannot be called not written.`);
      // Asked last, right before the door's call: SQL takes this from the door, so nothing else ties the two.
      const person = await runtime.person.confirm('settle-unknown', notWrittenQuestion(effect.target, statement!));
      if (person.status !== 'committed' || person.value !== binding.personId) return refused('NOT_AVAILABLE', 'This was not confirmed, so nothing changed.');
      mustHold();
      const settled = await runtime.door.reconcile(attempt, 'failed', observation);
      if (settled.status !== 'committed') return { ok: false, reason: 'NOT_AVAILABLE', detail: 'This has no confirmed receipt. The same confirmation can be given again: nothing is resent.', outcome: 'UNKNOWN' };
    }
    const shown = await reproject();
    if (shown && row.status === 'failed') shown.detail = `${shown.target} was already recorded as not written by a confirmation with these same words. It was not resent, and it can be sent again.`;
    else if (shown) shown.detail = attested ? `You confirmed ${shown.target} was not written. It was not resent, and it can be sent again.` : `The fixture session confirmed ${shown.target} was not written. This is not a person's word. It was not resent, and it can be sent again.`;
    await saveThread(thread);
    return { ok: true, value: { outcome: 'REFUSED' } };
  }

  const confirms = (confirmation: UnknownConfirmation | undefined, id: string, statement: string | undefined) =>
    statement !== undefined && confirmation?.attempt === id && confirmation.statementSha256 === sha256(statement);

  /** A person's word on a held write. The kernel takes it from a person session, and names the digests shown. */
  async function decideHeld({ threadId, attempt, decision, confirmation }: Parameters<V08Host['decideHeld']>[0]): Promise<Receipt<{ outcome: 'ACCEPTED' | 'REFUSED' }>> {
    await recovering;
    mustHold();
    const thread = threads.get(threadId);
    const turn = thread?.turns.find((t) => t.effects.some((effect) => effect.key === attempt));
    const effect = turn?.effects.find((e) => e.key === attempt);
    const answer = deciding.get(attempt);
    if (!thread || !turn || !effect || !answer) return refused('NOT_FOUND', `No held write ${attempt} is waiting in that thread.`);
    if (!confirms(confirmation, attempt, effect.detail)) return refused('NOT_AVAILABLE', 'This needs a confirmation of this write and of the exact statement shown.');
    const projectId = thread.summary.projectId;
    const run = await custodyRun(home, threadId, turn.id, projectId).catch(() => null);
    const before = run ? await runtime.door.attempts(run) : null;
    const row = before?.status === 'committed' ? before.value.find((r) => r.id === attempt) : undefined;
    if (!run || !row) return refused('NOT_AVAILABLE', UNREADABLE);
    // An acceptance shows the person the content this row releases, in full: custody's original, refused unless it is the row's.
    const name = custodied(thread, turn).find((n) => originalKey(turn.id, n) === row.key);
    const target = name ? await originalOf(home, threadId, turn.id, projectId, row, name).catch(() => null) : null;
    if (!target || argsDigest(target) !== row.args) return refused('NOT_AVAILABLE', UNREADABLE);
    const project = projects.find((p) => p.id === projectId)?.name ?? projectId;
    const question = heldQuestion({ statement: effect.detail!, decision, project, name: target.name, body: target.body, sha256: argsOf(target).content_sha256 });
    const said = decision === 'accept' ? await runtime.person.acceptAttempt(attempt, row.target, row.args, question) : await runtime.person.denyAttempt(attempt, question);
    if (said.status === 'denied' && said.code === 'personal-session-required') return refused('NOT_AVAILABLE', 'This was not confirmed, so the write stays held.');
    // A lost acknowledgement may have committed, so the row answers. Only a person's word moves it out of held.
    const after = await runtime.door.attempts(run);
    const now = after.status === 'committed' ? after.value.find((r) => r.id === attempt)?.status : undefined;
    if (now === 'denied') { answer('denied'); deciding.delete(attempt); return { ok: true, value: { outcome: 'REFUSED' } }; }
    if (decision === 'accept' && now === 'attempted') { answer('accepted'); deciding.delete(attempt); return { ok: true, value: { outcome: 'ACCEPTED' } }; }
    if (now === 'held' && said.status === 'denied') return refused('NOT_AVAILABLE', 'The kernel refused this: only the owner of the run\'s contract can accept it, on a live run.');
    return { ok: false, reason: 'NOT_AVAILABLE', detail: 'This has no confirmed receipt. The write stays held, and it can be answered again.', outcome: 'UNKNOWN' };
  }

  const promotionStatement = (intent: string, snapshot: string) => `Promotion ${intent}, snapshot ${snapshot}: its landing may or may not have happened, so its outcome is UNKNOWN and its target stays held.`;
  async function promotionUnknowns(): Promise<Receipt<readonly PromotionUnknown[]>> {
    await recovering;
    mustHold();
    const records = await runtime.door.crossingRecords();
    if (records.status !== 'committed') return refused('NOT_AVAILABLE', 'The landing records could not be read.');
    return { ok: true, value: records.value.filter((r) => r.disposition === 'outcome-unknown').map(({ intent, snapshot }) => ({ intent, snapshot, statement: promotionStatement(intent, snapshot) })) };
  }

  /**
   * Past a dead checker only the owner of the maker's contract can settle this, and SQL cannot check
   * what they say. Their digest stays on the row, and the receipt says who said it.
   */
  async function settlePromotionUnknown({ intent, snapshot, observed, confirmation }: Parameters<V08Host['settlePromotionUnknown']>[0]): Promise<Receipt<{ outcome: PromotionObserved; detail: string }>> {
    await recovering;
    mustHold();
    const statement = promotionStatement(intent, snapshot);
    if (!confirms(confirmation, snapshot, statement)) return refused('NOT_AVAILABLE', 'This needs a confirmation of this snapshot and of the exact statement shown.');
    const records = await runtime.door.crossingRecords();
    const record = records.status === 'committed' ? records.value.find((r) => r.intent === intent && r.snapshot === snapshot) : undefined;
    if (!record) return refused('NOT_FOUND', 'No landing record for that snapshot.');
    // The same word gives the same digest, so its lost acknowledgement can be told from anything else.
    // Who answered is part of the digest, so a fixture's settlement never reads as a person's.
    const observation = sha256(JSON.stringify({ snapshot, observed, statement: confirmation!.statementSha256, session: binding.personId, attests: options.sessions.attests ?? 'fixture' }));
    const receipt = { ok: true as const, value: { outcome: observed, detail: attested ? `You stated this landing was ${observed}. SQL cannot check it. Nothing was resent.` : `The fixture session stated this landing was ${observed}. This is not a person's word, and SQL cannot check it. Nothing was resent.` } };
    if (record.disposition === observed && record.reconciliation === observation) return { ok: true, value: { outcome: observed, detail: `This landing was already recorded as ${observed} by a confirmation with these same words. Nothing was resent.` } };
    if (record.disposition !== 'outcome-unknown') return refused('NOT_AVAILABLE', 'This landing is already settled, and not by this confirmation.');
    const settled = await runtime.person.reconcilePromotionAsOwner(intent, snapshot, observed, observation);
    if (settled.status === 'denied') return refused('NOT_AVAILABLE', 'The kernel refused this: the named checker may still be live, or this outcome does not fit this snapshot.');
    if (settled.status !== 'committed') return { ok: false, reason: 'NOT_AVAILABLE', detail: 'This has no confirmed receipt. The same confirmation can be given again: nothing is resent.', outcome: 'UNKNOWN' };
    return receipt;
  }

  /** Counted from its first line, so close waits for a call that can still write. */
  const counted = <T>(work: () => Promise<T>): Promise<T> => {
    const call = (async () => work())();
    const held = call.catch(() => {}).finally(() => inflight.delete(held));
    inflight.add(held);
    return call;
  };

  return {
    call: (async (method: Method, args: never) => {
      if (closed) return refused('NOT_AVAILABLE', 'This host is closed.');
      if (hold.lost.aborted) return refused('NOT_AVAILABLE', LOST);
      const handler = handlers[method] as ((a: never) => Promise<unknown>) | undefined;
      if (!handler) return refused('NOT_AVAILABLE', `${method} is not on the v0.8 path.`);
      return counted(() => handler(args));
    }) as Host['call'],
    decideHeld: (input) => (closed || hold.lost.aborted ? Promise.resolve(refused('NOT_AVAILABLE', closed ? 'This host is closed.' : LOST)) : counted(() => decideHeld(input))),
    promotionUnknowns: () => (closed || hold.lost.aborted ? Promise.resolve(refused('NOT_AVAILABLE', closed ? 'This host is closed.' : LOST)) : counted(() => promotionUnknowns())),
    settlePromotionUnknown: (input) => (closed || hold.lost.aborted ? Promise.resolve(refused('NOT_AVAILABLE', closed ? 'This host is closed.' : LOST)) : counted(() => settlePromotionUnknown(input))),
    settleUnknown: (input) => (closed || hold.lost.aborted ? Promise.resolve(refused('NOT_AVAILABLE', closed ? 'This host is closed.' : LOST)) : counted(() => settleUnknown(input))),
    close: async () => {
      closed = true;
      for (const live of running.values()) live.controller.abort();
      // A write still out keeps the home: the owner goes only when nothing of this host can land.
      const drained = (async () => {
        await recovering;
        while (inflight.size) await Promise.allSettled([...inflight]);
        return true;
      })();
      let timer: NodeJS.Timeout | undefined;
      const done = await Promise.race([drained, new Promise<boolean>((r) => { timer = setTimeout(() => r(false), settleWaitMs); })]);
      clearTimeout(timer);
      if (done) await release();
      else void drained.then(release);
    },
  };
}
