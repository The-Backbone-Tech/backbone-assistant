import { unknownChecked } from './unknown-checks.ts';
// Rewind uses immutable material versions and the thread journal, never a second snapshot store.
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Args, Method, Receipt, Result, RewindFile, RewindPlan, RewindRecord } from '../api.ts';
import { sha256 } from '../stub/fsx.ts';
import { type MaterialStore, isWithdrawn, isText } from '../stub/material.ts';
import { assertHomeWriteAdmission, withHomeLock } from './home-lock.ts';
import { WorkspaceStore } from '../workspace/store.ts';
import type { CoreLink } from './core.ts';
import { applyEvent, type StoredThread, type ThreadJournal } from './thread-journal.ts';

export interface RewindRevision { id: string; versions: { n: number; text: string }[]; current?: number }
/** Same person-revision contract as Save. A lost response is inspected by version on retry. */
export async function syncRewindVersions(link: Pick<CoreLink, 'documentVersion' | 'reviseDocument'> & Partial<Pick<CoreLink, 'read' | 'person'>>, revisions: RewindRevision[]): Promise<void> {
  for (const entry of revisions) {
    const known = await link.documentVersion(entry.id);
    if (known === null) throw new Error('The Core document is unavailable.');
    const target = entry.current ?? entry.versions.at(-1)?.n ?? known;
    if (known > target) throw new Error('Core version differs from the restored file.');
    let expected = known;
    for (const version of entry.versions.filter(version => version.n > known)) {
      if (version.n !== ++expected) throw new Error('Core is missing a version outside this restore.');
      await link.reviseDocument(entry.id, version.text);
      // reviseDocument returns an affected-row count. The document owns its version.
      if (await link.documentVersion(entry.id) !== version.n) throw new Error('The restored document version needs inspection before this rewind can complete.');
    }
    if (await link.documentVersion(entry.id) !== target) throw new Error('Core version differs from the restored file.');
    const text = entry.versions.find(version => version.n === target)?.text;
    if (text !== undefined && link.read && link.person) {
      // As with recovered writes, a number alone cannot prove the exact artifact.
      const { rows } = await link.read<{ content: string }>(link.person(), 'SELECT content FROM app.documents WHERE id = $1 AND version = $2', [entry.id, target]);
      if (rows[0]?.content !== text) throw new Error('Core content differs from the restored file.');
    }
  }
}

const refused = <T>(detail: string): Receipt<T> => ({ ok: false, outcome: 'REFUSED', reason: 'NOT_AVAILABLE', detail });

type DirectMethod = { [M in Method]: Result<M> extends Receipt<unknown> ? never : M }[Method];
// These contracts return data directly: substituting a refusal breaks their consumers.
// Keep this exhaustive as the API grows. UI preferences do not change restored files.
const DIRECT_RESULTS = {
  'core.signatureStatus': true, 'projects.list': true, 'threads.list': true, 'threads.search': true,
  'goals.runs': true, 'host.status': true, 'material.list': true, 'work.now': true, 'files.list': true,
  'drafts.get': true, 'models.list': true, 'settings.policy.get': true, 'settings.model.get': true,
  'models.local': true, 'viewer.get': true, 'viewer.put': true, 'tools.list': true, 'triage.get': true,
  'schedules.get': true, 'triggers.get': true, 'solutions.options': true, 'memory.get': true,
  'memory.search': true, 'plugins.parts': true, 'connectors.list': true,
} satisfies Record<DirectMethod, true>;

/** Preserve read shapes and the person's Stop, draft and permission controls. */
export function rewindControl(method: Method, args: unknown): boolean {
  if (Object.hasOwn(DIRECT_RESULTS, method)) return true;
  if (['turns.stop', 'sidechat.stop', 'goals.pause', 'tools.disconnect', 'connectors.set', 'drafts.put', 'queue.remove'].includes(method)) return true;
  const input = args as { verdict?: string; patch?: { paused?: boolean } } | null;
  if (method === 'connectors.decide' || method === 'connectors.resolveRead') return input?.verdict === 'discard';
  if (method === 'schedules.update' || method === 'triggers.update') return input?.patch?.paused === true;
  return false;
}

export function createThreadRewind(ctx: {
  home: string; material: MaterialStore; threads: Map<string, StoredThread>; journal: ThreadJournal;
  projectDir: (id: string) => string; busy: (thread: StoredThread) => boolean;
  save: (thread: StoredThread) => Promise<void>; changed: (id: string) => void;
  sync?: (revisions: RewindRevision[]) => Promise<void>;
  retention?: (thread: StoredThread) => Promise<string | null>;
  retireWorkspace?: (threadId: string) => Promise<void>;
  unresolved?: (threadId: string, turn: import('../api.ts').Turn) => Promise<boolean>;
}) {
  // Direct folder edits count even when they have not been Saved in the app. Refuse
  // links in every path segment; a logical document name never grants another folder.
  function folder(entry: NonNullable<ReturnType<MaterialStore['load']>>): string {
    if (entry.projection === 'managed') return 'managed';
    const home = resolve(ctx.home), root = resolve(ctx.projectDir(entry.projectId));
    const within = relative(home, root);
    if (within === '..' || within.startsWith('../')) return 'unsafe';
    let path = realpathSync(home);
    for (const segment of within.split('/').filter(Boolean)) {
      path = join(path, segment);
      try { if (lstatSync(path).isSymbolicLink()) return 'unsafe'; } catch { return 'unsafe'; }
    }
    for (const part of entry.name.split('/')) {
      if (!part || part === '.' || part === '..' || /[\\\0]/.test(part)) return 'unsafe';
      path = join(path, part);
      try { if (lstatSync(path).isSymbolicLink()) return 'unsafe'; }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unsafe'; }
    }
    try {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try { return fstatSync(fd).isFile() ? sha256(readFileSync(fd)) : 'unsafe'; }
      finally { closeSync(fd); }
    } catch { return 'unsafe'; }
  }
  function plan(args: Args<'threads.rewindPreview'>, unresolved: Set<string>): Receipt<RewindPlan> {
    const thread = ctx.threads.get(args.threadId);
    if (!thread) return refused('This conversation is unavailable.');
    const pending = thread.rewindPending;
    if (pending && pending.turnId !== args.turnId) return refused('Use Resume rewind on the pending rewind banner.');
    if (!pending && (ctx.busy(thread) || thread.summary.running || thread.queue?.length || thread.child || thread.sideTurns.some(turn => turn.sideRecoveryPending || turn.unknownOutcome || turn.status === 'running' || turn.effects.some(effect => effect.outcome === 'UNKNOWN')))) return refused('Stop work and settle pending recovery before rewinding.');
    const index = thread.turns.findIndex(turn => turn.id === args.turnId);
    if (index < 0) return refused('The selected turn is unavailable.');
    if (thread.turns[index].status === 'running') return refused('The selected turn is still running. Stop it before rewinding.');
    const turns = thread.turns.slice(index + 1);
    if (!pending && turns.some(turn => turn.nativeAccountActivity && turn.status !== 'done' && !unknownChecked(turn))) return refused('Native account activity needs inspection before rewinding. Check its work steps and the source system, then use “I checked this myself” in the conversation.');
    if (!pending && turns.some(turn => unresolved.has(turn.id) || turn.effects.some(effect => effect.outcome === 'UNKNOWN'))) return refused('An outside action has an unknown outcome. Inspect its receipts before rewinding.');
    if (!turns.length && !pending) return refused('There are no later turns to rewind.');
    const changed = new Map<string, number[]>();
    for (const turn of turns) for (const effect of turn.effects) {
      if (effect.outcome !== 'DONE' || !effect.materialId || !effect.version) continue;
      if (ctx.material.load(effect.materialId)?.versions.find(v => v.n === effect.version)?.by !== 'agent') continue;
      changed.set(effect.materialId, [...(changed.get(effect.materialId) ?? []), effect.version]);
    }
    if (pending) for (const file of pending.files) changed.set(file.materialId, file.agentVersions ?? changed.get(file.materialId) ?? [file.restore + 1]);
    const observations: unknown[] = [];
    const files: RewindFile[] = [];
    for (const [id, versions] of changed) {
      const entry = ctx.material.load(id), previous = pending?.files.find(file => file.materialId === id);
      const digest = entry ? folder(entry) : 'unsafe';
      const unavailable = !entry || entry.projectId !== thread.summary.projectId || entry.class === 'original' || entry.held || entry.recovery || isWithdrawn(entry);
      const problem = unavailable ? 'This file is held or unavailable.' : digest === 'unsafe' ? 'The folder is missing, linked or outside the data folder. Restore is unavailable; finish without remaining files to end this rewind.' : undefined;
      if (problem && !pending) return refused(problem);
      const restore = previous?.restore ?? Math.min(...versions) - 1;
      const external = !!entry && digest !== 'managed' && digest !== entry.versions.find(v => v.n === entry.current)?.sha256;
      const applied = !!entry && !!pending && entry.rewindOperation === pending.id && !entry.folderConflict && (restore === 0 ? entry.hidden && (digest === 'missing' || digest === 'managed') : !entry.hidden && !external);
      const foreignVersions = entry?.versions.filter(v => v.n > restore && v.n <= entry.current && (v.by !== 'agent' || !versions.includes(v.n))).map(v => v.n) ?? [];
      files.push({ ...previous, materialId: id, name: entry?.name ?? previous!.name, current: entry?.current ?? previous!.current, restore, agentVersions: versions, foreignVersions, conflict: !applied && (!!pending || foreignVersions.length > 0 || external || !!entry?.hidden || !!entry?.folderConflict), folderDigest: digest, problem: problem ?? (previous?.core === 'failed' ? previous.problem : undefined) });
      observations.push([entry, digest]);
    }
    return { ok: true, value: { pendingKey: pending?.id, files, turns, revision: sha256(JSON.stringify([thread.turns, observations])) } };
  }
  async function guarded<T>(threadId: string, fn: (unresolved: Set<string>) => Promise<Receipt<T>>): Promise<Receipt<T>> {
    const thread = ctx.threads.get(threadId);
    const reason = thread && !thread.rewindPending && await ctx.retention?.(thread);
    if (reason) return refused(reason);
    // Snapshot under the home lock, verify Core outside it, then reject any changed snapshot.
    const snapshot = await withHomeLock(ctx.home, async () => JSON.stringify(ctx.threads.get(threadId)?.turns));
    const turns = JSON.parse(snapshot ?? 'null') as import('../api.ts').Turn[] | null;
    const unresolved = new Set<string>();
    for (const turn of turns ?? []) {
      if (ctx.unresolved ? await ctx.unresolved(threadId, turn).catch(() => true) : turn.unknownOutcome && !unknownChecked(turn)) unresolved.add(turn.id);
    }
    return withHomeLock(ctx.home, async () => {
      if (snapshot !== JSON.stringify(ctx.threads.get(threadId)?.turns)) return refused('The conversation changed. Review the rewind again.');
      return fn(unresolved);
    });
  }
  let applying = false;
  async function singleFlight(run: () => Promise<Receipt<RewindRecord>>): Promise<Receipt<RewindRecord>> {
    if (applying) return refused('A rewind is already being recorded. Reload its preview after it finishes.');
    applying = true;
    try { return await run(); } finally { applying = false; }
  }
  async function progress(thread: StoredThread, record: RewindRecord) {
    assertHomeWriteAdmission(ctx.home);
    applyEvent(ctx.threads, ctx.journal.append({ kind: 'thread.rewind.progress', threadId: thread.summary.id, record }));
    await ctx.save(thread);
  }
  const observe = (record: RewindRecord) => sha256(JSON.stringify(record.files.map(file => { const entry = ctx.material.load(file.materialId); return [entry, entry && folder(entry)]; })));
  async function complete(threadId: string, record: RewindRecord, observation?: string): Promise<Receipt<RewindRecord>> {
    // Scratch can contain derived outputs without recorded material sources. Retire it
    // before recording completion, outside the home lock; a kill leaves a resumable intent.
    try { await (ctx.retireWorkspace ?? (id => new WorkspaceStore(ctx.home).remove(id)))(threadId); }
    catch {
      return withHomeLock(ctx.home, async () => {
        const thread = ctx.threads.get(threadId)!;
        await progress(thread, { ...record, problem: 'Command workspace retirement could not be confirmed. Resume to retry cleanup.' });
        return refused('Command workspace cleanup needs inspection. This conversation remains paused.');
      });
    }
    return withHomeLock(ctx.home, async () => {
      const thread = ctx.threads.get(threadId);
      if (!thread || thread.rewindPending?.id !== record.id) return refused('The pending rewind changed. Reload it.');
      if (observation && observe(record) !== observation) {
        await progress(thread, { ...record, problem: 'Files changed while the rewind was recorded. Resume to inspect them, or finish without remaining files.' });
        return refused('Files changed while the rewind was recorded. Review the saved rewind again.');
      }
      assertHomeWriteAdmission(ctx.home);
      applyEvent(ctx.threads, ctx.journal.append({ kind: 'thread.rewound', threadId, record }));
      await ctx.save(thread);
      return { ok: true, value: record };
    });
  }
  return {
    preview: async (args: Args<'threads.rewindPreview'>): Promise<Receipt<RewindPlan>> => guarded(args.threadId, async unresolved => plan(args, unresolved)),
    finish: (args: Args<'threads.rewindFinish'>) => singleFlight(async () => {
      const result = await withHomeLock(ctx.home, async (): Promise<Receipt<RewindRecord>> => {
        const thread = ctx.threads.get(args.threadId);
        const prior = thread?.rewinds?.find(record => record.id === args.pendingKey);
        if (prior) return { ok: true, value: prior };
        if (!thread?.rewindPending || thread.rewindPending.id !== args.pendingKey) return refused('Use the current pending rewind.');
        const record = thread.rewindPending;
        return { ok: true, value: { ...record, resolution: 'without-remaining-files', problem: undefined, files: record.files.map(file => {
          // Finish records history; it must not depend on reading an inaccessible,
          // renamed or special workspace file. A settled intent proves delivery.
          const entry = ctx.material.load(file.materialId);
          const applied = entry?.rewindOperation === record.id && !entry.projecting && !entry.folderConflict && (file.restore === 0 ? entry.hidden : !entry.hidden);
          return { ...file, outcome: applied ? 'restored' : file.outcome === 'restored' || file.outcome === 'kept' ? file.outcome : 'not-restored' };
        }) } };
      });
      if (!result.ok) return result;
      const thread = ctx.threads.get(args.threadId);
      if (thread?.rewinds?.some(record => record.id === result.value.id) || !thread?.rewindPending) return result;
      return complete(args.threadId, result.value);
    }),
    apply: (args: Args<'threads.rewind'>) => singleFlight(async (): Promise<Receipt<RewindRecord>> => {
      const revisions: RewindRevision[] = [];
      let observation = '';
      const result = await guarded<RewindRecord>(args.threadId, async unresolved => {
        const thread = ctx.threads.get(args.threadId);
        if (!thread || !args.clientKey || args.clientKey.length > 200 || !Array.isArray(args.choices)) return refused('Use a valid rewind request.');
        const id = thread.rewindPending?.id === args.clientKey ? args.clientKey : sha256(JSON.stringify([args.threadId, args.clientKey]));
        const prior = thread.rewinds?.find(record => record.id === id || record.id === args.clientKey);
        if (prior) return prior.turnId === args.turnId ? { ok: true, value: prior } : refused('This request already rewound another turn.');
        const pending = thread.rewindPending;
        if (pending && (pending.id !== id || pending.turnId !== args.turnId)) return refused('Finish the interrupted rewind before starting another.');
        const preview = plan(args, unresolved);
        if (!preview.ok) return preview;
        if (preview.value.revision !== args.revision) return refused('Files or conversation changed. Review the rewind again.');
        const { files, turns } = preview.value;
        if (args.choices.some((c, i) => !files.some(f => f.materialId === c.materialId) || !['keep', 'restore'].includes(c.action) || args.choices.findIndex(other => other.materialId === c.materialId) !== i)) return refused('Choose once for each affected file.');
        if (files.some(file => file.conflict && !args.choices.some(c => c.materialId === file.materialId))) return refused('Choose Keep my file or Restore for every file changed since the agent.');
        if (files.some(file => file.problem && args.choices.find(c => c.materialId === file.materialId)?.action !== 'keep' && file.core !== 'failed')) return refused('An affected file cannot be restored. Keep it or finish without remaining files.');
        let record: RewindRecord = { id, turnId: args.turnId, files, turns: pending?.turns ?? turns, clientKeys: pending?.clientKeys ?? thread.clientKeys.slice(thread.turns.findIndex(turn => turn.id === args.turnId) + 1), sideTurns: pending?.sideTurns ?? thread.sideTurns.filter(turn => turn.user.at > (thread.turns.find(turn => turn.id === args.turnId)!.work.endedAt ?? thread.turns.find(turn => turn.id === args.turnId)!.user.at)), choices: args.choices };
        assertHomeWriteAdmission(ctx.home);
        applyEvent(ctx.threads, ctx.journal.append({ kind: 'thread.rewind.started', threadId: args.threadId, record }));
        await ctx.save(thread);
        for (const file of record.files) {
          const keep = record.choices.find(c => c.materialId === file.materialId)?.action === 'keep';
          let entry = ctx.material.load(file.materialId);
          try {
            if (entry && folder(entry) !== 'unsafe' && !entry.held && !entry.recovery && !isWithdrawn(entry)) {
              if (entry.rewindOperation !== id && entry.current !== file.current || folder(entry) !== file.folderDigest) throw new Error('changed');
              assertHomeWriteAdmission(ctx.home);
              if (keep) entry = ctx.material.keepRewindFile(entry.id);
              else {
                if (file.conflict) ctx.material.keepRewindFile(entry.id);
                entry = ctx.material.rewind(file.materialId, file.restore, id, file.conflict);
                if (entry.folderConflict) throw new Error('folder conflict');
              }
            } else if (!keep) throw new Error('unavailable');
          } catch {
            record = { ...record, files: record.files.map(f => f.materialId === file.materialId ? { ...f, outcome: 'pending', problem: 'This file changed or became unavailable. Its bytes were preserved; resume to choose, or finish without remaining files.' } : f) };
            await progress(thread, record);
            return refused('A file needs inspection. Open the pending rewind to resume or finish.');
          }
          record = { ...record, files: record.files.map(f => f.materialId === file.materialId ? { ...f, outcome: keep ? 'kept' : 'restored', problem: undefined } : f) };
          await progress(thread, record);
          ctx.changed(file.materialId);
          if (entry && isText(entry) && (!keep || entry.current !== file.current)) revisions.push({ id: entry.id, current: entry.current, versions: entry.versions.filter(v => v.by === 'person').map(v => ({ n: v.n, text: Buffer.from(ctx.material.bytes(entry!.id, v.n)).toString('utf8') })) });
        }
        observation = observe(record);
        return { ok: true, value: record };
      });
      if (!result.ok || !observation) return result;
      let record = result.value;
      for (const revision of revisions) {
        let failed = false;
        try { await ctx.sync?.([revision]); } catch { failed = true; }
        record = { ...record, files: record.files.map(file => file.materialId === revision.id ? { ...file, core: ctx.sync ? failed ? 'failed' : 'recorded' : undefined, problem: failed ? 'Core could not confirm this file version. Resume to inspect and retry, or finish with this outcome recorded.' : undefined } : file) };
      }
      if (record.files.some(file => file.core === 'failed')) return withHomeLock(ctx.home, async () => {
        await progress(ctx.threads.get(args.threadId)!, record);
        return refused('A restored file could not be confirmed in Core. Its outcome is recorded in the pending rewind.');
      });
      return complete(args.threadId, { ...record, resolution: 'complete' }, observation);
    }),
  };
}
