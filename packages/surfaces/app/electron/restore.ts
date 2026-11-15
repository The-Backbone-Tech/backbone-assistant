// Restore a backup from the app: the same platform operation `backbone restore` runs (importHome,
// through Host.importExport, into a new, empty data folder), driven by the main process so the person
// needs no terminal. The page never names a folder to write: it names a backup to read, and takes a
// one-time ticket for the new data folder from this module, bound to its window. The job's state
// lives here, not in the page, so a person who leaves Settings finds the result when they come back.
import type { FolderOpenResult, FolderPick } from './data-folder-open.ts';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { Host } from '@backbone-next/platform/composition';
import { hostClosed } from '@backbone-next/platform/composition';
import { assertHomeWriteAdmission } from '@backbone-next/platform/composition/home-lock';
import { readRecord, forgetRecord, writeRecord } from './restore-record.ts';
import { BackupRefused, exportFingerprint, importHome, inspectExport, newHome, type ImportPlan } from '@backbone-next/platform/composition/backup';

/** What the page may know of a restore. Every text in it is the operation's own, or fixed plain words. */
export type RestoreAdds = ImportPlan['adds'];
export type RestoreCounts = ImportPlan['export']['counts'];

export interface RestorePreview {
  /** Names this preview when the page starts the restore: only an export this module read and checked. */
  previewId: string;
  from: string;
  createdAt: string;
  counts: RestoreCounts;
  adds: RestoreAdds;
  /** What the restore leaves out of the new data folder, one line each, as the operation words it. */
  skipped: string[];
  /** Why this export cannot go ahead as asked, when it cannot. */
  conflicts: string[];
}

export type RestoreJob =
  | { state: 'running'; phase: 'preparing' | 'writing' | 'closing'; from: string; target: string; startedAt: string; adds: RestoreAdds }
  | { state: 'done'; openId?: string; openProblem?: string; from: string; target: string; finishedAt: string; counts: RestoreCounts; adds: RestoreAdds; skipped: string[] }
  | { state: 'refused'; from: string; target: string; finishedAt: string; reason: string; detail: string; /** The new data folder may hold part of the export. */ partial: boolean; /** The folder at `target` may exist and hold files. Nothing the restore does ever removes it. */ remains: boolean }
  | { state: 'unknown'; from: string; target: string; finishedAt: string; detail: string };

export type RestoreAvailability = { available: true } | { available: false; reason: string };

export interface RestoreView {
  availability: RestoreAvailability;
  /** The data folder this app is using now: never the place a restore goes. */
  currentFolder: string;
  job: RestoreJob | null;
}

export type Refused = { ok: false; reason: string; detail: string };
type Ticketed = { ok: true; ticket: string; folder: string };

export type RestoreRequest =
  | { step: 'view' }
  | { step: 'preview'; ticket: string }
  | { step: 'target' }
  | { step: 'start'; previewId: string; ticket: string }
  | { step: 'dismiss' }
  | { step: 'open'; id: string };

/** The part of a Host a restore needs: opened on the new data folder, used once, closed. */
export type RestoreHost = Pick<Host, 'call' | 'importExport' | 'close'>;

/** A folder as it was when it was checked: still the same one only if its device, inode and real path match and it is not a link. */
interface Identity { dev: number; ino: number; real: string }
const identityOf = (path: string): Identity | null => {
  try {
    const st = lstatSync(path);
    return st.isDirectory() && !st.isSymbolicLink() ? { dev: st.dev, ino: st.ino, real: realpathSync(path) } : null;
  } catch { return null; }
};
const same = (a: Identity | null, b: Identity | null) => !!a && !!b && a.dev === b.dev && a.ino === b.ino && a.real === b.real;

/** Something known before a write: nothing was written. */
class NothingWritten extends Error {}

export interface RestorerOptions {
  /** The data folder the app is using. */
  home: string;
  /** Why restore is not offered (a company configuration, say), or undefined. */
  unavailable?: () => string | undefined;
  /** Opens a host on the new data folder, with the keys the app keeps its own with. */
  openHost: (home: string) => RestoreHost;
  folders?: { pick(folder: string, owner: number): FolderPick; open(id: unknown, owner: number): Promise<FolderOpenResult> };
  now?: () => Date;
  ttlMs?: number;
}

const stamp = (now: Date) => now.toISOString().slice(0, 16).replace(/[:T]/g, '-').replace(/-(\d\d)-(\d\d)$/, '-$1$2');

const refusal = (reason: string, detail: string): Refused => ({ ok: false, reason, detail });

/** Whether `inner` is `outer` or inside it, by real path where the folder exists. */
function within(outer: string, inner: string): boolean {
  const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
  const a = real(outer);
  const b = (() => { let p = resolve(inner); const tail: string[] = []; for (;;) { try { return join(realpathSync(p), ...tail.reverse()); } catch { const up = dirname(p); if (up === p) return resolve(inner); tail.push(basename(p)); p = up; } } })();
  return b === a || b.startsWith(a.endsWith(sep) ? a : a + sep);
}

export function createRestorer(options: RestorerOptions) {
  const home = resolve(options.home);
  const now = options.now ?? (() => new Date());
  const ttlMs = options.ttlMs ?? 30 * 60_000;
  const sources = new Map<string, { folder: string; owner: number; at: number }>();
  const previews = new Map<string, { from: string; fingerprint: string; plan: ImportPlan; owner: number; at: number }>();
  const targets = new Map<string, { folder: string; parent: string; parentId: Identity; owner: number; at: number }>();
  let job: RestoreJob | null = null;
  let current: Promise<void> | undefined;
  let startedAt = now().toISOString();

  // A record of the job in the app's state folder (restore-record.ts), so an interruption is not forgotten.
  // It is a convenience: whatever it says, a restart shows only that the result is not known.
  const record = (state: 'running' | 'done' | 'refused' | 'unknown', from: string, target: string) => writeRecord(home, { version: 1, state, from, target, at: now().toISOString() });
  const settle = (value: RestoreJob) => { job = value; if (value.state !== 'running') record(value.state, value.from, value.target); };
  const earlier = readRecord(home);
  if (earlier) job = { state: 'unknown', from: earlier.from, target: earlier.target, finishedAt: earlier.at, detail: 'A restore into this folder was under way, or had finished, when the app last closed. Its result is not known. Nothing is tried again for you.' };

  const availability = (): RestoreAvailability => {
    const why = options.unavailable?.();
    if (why) return { available: false, reason: why };
    // The data folder in use, on its own: read-only or not admitted for writing, whatever the new place allows.
    try { assertHomeWriteAdmission(home); } catch (error) {
      return { available: false, reason: `This data folder cannot be written to now, so a restore cannot start: ${error instanceof Error ? error.message : String(error)}` };
    }
    try { accessSync(home, constants.W_OK); } catch {
      return { available: false, reason: 'This data folder is read-only now, so a restore cannot start.' };
    }
    return { available: true };
  };

  /** A new folder name that does not exist yet, beside the current data folder or inside a folder the person chose. */
  const nameFor = (parent: string | undefined): string => {
    const base = parent ? join(parent, `restored-${stamp(now())}`) : join(dirname(home), `${basename(home)}-restored-${stamp(now())}`);
    let name = base;
    for (let n = 2; lstatSync(name, { throwIfNoEntry: false }); n += 1) name = `${base}-${n}`;
    return name;
  };

  /** What may not be the new data folder, in plain words, checked before anything is written. */
  const targetProblem = (target: string): string | null => {
    if (within(home, target)) return 'That is the data folder this app is using now, or inside it. A restore goes only into a new, empty data folder.';
    if (within(target, home)) return 'That folder holds the data folder this app is using now. A restore goes only into a new, empty data folder.';
    return newHome(target);
  };

  const live = <T extends { at: number }>(map: Map<string, T>) => { for (const [key, value] of map) if (now().getTime() - value.at > ttlMs) map.delete(key); };

  const running = (from: string, target: string, adds: RestoreAdds, phase: 'preparing' | 'writing' | 'closing'): RestoreJob => ({ state: 'running', phase, from, target, startedAt, adds });

  /** The restore itself, after every refusal that can be known without a write. It never throws, never retries and never removes anything. */
  const run = async (from: string, target: string, adds: RestoreAdds, given: { parent: string; parentId: Identity }, fingerprint: string, owner: number) => {
    startedAt = now().toISOString();
    job = running(from, target, adds, 'preparing');
    let host: RestoreHost | undefined;
    let mayExist = false; // the exclusive create may have happened: the folder may be there, whatever follows
    let opened = false;
    let writing = false;
    try {
      // The place it goes in must still be the folder that was checked, and not a link to somewhere else.
      if (!same(identityOf(given.parent), given.parentId)) throw new NothingWritten('The folder it goes in changed after you chose it, so nothing was written. Choose the place again.');
      // The operation's own dry run against this exact folder, and write admission, before any file is made.
      const plan = await importHome({ from, home: target, dryRun: true, expect: fingerprint });
      if (plan.conflicts.length) throw new BackupRefused('INVALID', plan.conflicts.join(' '));
      assertHomeWriteAdmission(target);
      // An exclusive create: a folder that is already there, however empty, is not this restore's.
      try { mayExist = true; mkdirSync(target, { mode: 0o700 }); } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') { mayExist = false; throw new NothingWritten('That folder appeared after you chose it, so nothing was written and it was left as it was. Choose the place again.'); }
        if (code === 'ENOENT') { mayExist = false; throw new NothingWritten('The folder it goes in is gone, so nothing was written. Choose the place again.'); }
        throw error;
      }
      const made = identityOf(target);
      if (!made || within(home, made.real) || dirname(made.real) !== given.parentId.real) throw new NothingWritten('The new data folder is not where it was meant to be, so nothing was written.');
      host = options.openHost(target);
      opened = true;
      // Every call waits for the core to open: a data folder that will not open stops here, before a write.
      await host.call('projects.list', {});
      // Immediately before the import: the new folder and the place it is in are still the ones checked.
      if (!same(identityOf(target), made) || !same(identityOf(given.parent), given.parentId)) throw new NothingWritten('The new data folder was replaced while it opened, so nothing was imported.');
      job = running(from, target, adds, 'writing');
      writing = true;
      const done = await host.importExport(from, fingerprint);
      job = running(from, target, adds, 'closing');
      host.close(); host = undefined;
      await hostClosed(target);
      const picked = options.folders?.pick(target, owner);
      settle({ state: 'done', ...(picked?.ok ? { openId: picked.id } : picked ? {openProblem: `Restored, but this app cannot open it from here: ${picked.detail}`} : {}), from, target, finishedAt: now().toISOString(), counts: done.export.counts, adds: done.adds, skipped: done.skipped });
    } catch (error) {
      try { host?.close(); if (opened) await hostClosed(target); } catch { /* the first failure is the one to show */ }
      const detail = error instanceof Error ? error.message : String(error);
      const finishedAt = now().toISOString();
      if (error instanceof BackupRefused && error.unknown) settle({ state: 'unknown', from, target, finishedAt, detail });
      else if (error instanceof BackupRefused && error.partial) settle({ state: 'refused', from, target, finishedAt, reason: error.reason, detail, partial: true, remains: true });
      else if (error instanceof BackupRefused || !writing) settle({ state: 'refused', from, target, finishedAt, reason: error instanceof BackupRefused ? error.reason : 'NOT_AVAILABLE', detail, partial: false, remains: mayExist });
      else settle({ state: 'unknown', from, target, finishedAt, detail: `The restore ended without a clear answer (${detail}). The data folder may hold part of the backup.` });
    }
  };
  /** `run`, with a last net: whatever goes wrong, the job ends as not known with its path, never left showing as running. */
  const guarded = (...args: Parameters<typeof run>) => run(...args).catch((error: unknown) => {
    settle({ state: 'unknown', from: args[0], target: args[1], finishedAt: now().toISOString(), detail: `The restore ended without a clear answer (${error instanceof Error ? error.message : String(error)}). The folder may exist and hold files.` });
  });

  const view = (): RestoreView => ({ availability: availability(), currentFolder: home, job });

  /** A folder the person picked, as a link-free directory. */
  const folderOf = (path: unknown): string | Refused => {
    if (typeof path !== 'string' || !path.trim()) return refusal('INVALID', 'Choose a folder first.');
    const id = identityOf(resolve(path));
    return id ? resolve(path) : refusal('INVALID', `${path} is not a folder.`);
  };

  return {
    view,
    open: (id: unknown, owner: number) => options.folders?.open(id, owner) ?? Promise.resolve({ state: 'failed' as const, detail: 'Opening another data folder needs the desktop app.' }),

    /** Waits for a running restore to end: the app's shutdown calls it so a restore is not cut off. */
    drain: async () => { await current; },

    /** A backup folder the person picked in the app's own picker (main passes `path`, never the page): the only thing a preview reads. */
    source(path: unknown, owner: number): Ticketed | Refused {
      const folder = folderOf(path);
      if (typeof folder !== 'string') return folder;
      live(sources);
      const ticket = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
      sources.set(ticket, { folder, owner, at: now().getTime() });
      return { ok: true, ticket, folder };
    },

    /** The dry run: reads and checks the picked backup, changes nothing, and fingerprints what it read. */
    async preview(ticket: unknown, owner: number): Promise<{ ok: true; preview: RestorePreview } | Refused> {
      const off = availability();
      if (!off.available) return refusal('NOT_AVAILABLE', off.reason);
      const picked = typeof ticket === 'string' ? sources.get(ticket) : undefined;
      if (!picked || picked.owner !== owner || now().getTime() - picked.at > ttlMs) return refusal('INVALID', 'Choose the backup folder first: a preview reads only a folder you picked, from this window.');
      try {
        const fingerprint = exportFingerprint(inspectExport(picked.folder));
        const plan = await importHome({ from: picked.folder, home: nameFor(undefined), dryRun: true, expect: fingerprint });
        live(previews);
        const previewId = randomUUID();
        previews.set(previewId, { from: plan.export.folder, fingerprint, plan, owner, at: now().getTime() });
        return { ok: true, preview: { previewId, from: plan.export.folder, createdAt: plan.export.createdAt, counts: plan.export.counts, adds: plan.adds, skipped: plan.skipped, conflicts: plan.conflicts } };
      } catch (error) {
        if (error instanceof BackupRefused) return refusal(error.reason, error.message);
        throw error;
      }
    },

    /** A ticket for a new data folder: beside the current one, or inside a folder the person chose in the app's own picker (main passes `parent`, never the page). Nothing is made yet. */
    target(parent: string | undefined, owner: number): Ticketed | Refused {
      const off = availability();
      if (!off.available) return refusal('NOT_AVAILABLE', off.reason);
      const place = parent === undefined ? dirname(home) : folderOf(parent);
      if (typeof place !== 'string') return place;
      const parentId = identityOf(place);
      if (!parentId) return refusal('INVALID', `${place} is not a folder.`);
      // The place the new folder goes in, on its own: admitted for writing, and not inside the data folder in use.
      try { assertHomeWriteAdmission(place); } catch (error) { return refusal('NOT_AVAILABLE', `A new data folder cannot be written there: ${error instanceof Error ? error.message : String(error)}`); }
      const folder = nameFor(parent === undefined ? undefined : place);
      const problem = targetProblem(folder);
      if (problem) return refusal('INVALID', problem);
      live(targets);
      const ticket = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
      targets.set(ticket, { folder, parent: place, parentId, owner, at: now().getTime() });
      return { ok: true, ticket, folder };
    },

    /**
     * Starts the restore and answers at once; the job runs on and its state is `view().job`. Every refusal
     * that can be known before a write is given here, with nothing made on disk.
     */
    start(request: { previewId: unknown; ticket: unknown }, owner: number): { ok: true; job: RestoreJob } | Refused {
      const off = availability();
      if (!off.available) return refusal('NOT_AVAILABLE', off.reason);
      if (job?.state === 'running') return refusal('NOT_AVAILABLE', 'A restore is already running.');
      if (job) return refusal('NOT_AVAILABLE', 'The last restore has not been put away yet. Read it, then press Done or Start again.');
      const given = typeof request.ticket === 'string' ? targets.get(request.ticket) : undefined;
      if (typeof request.ticket === 'string') targets.delete(request.ticket);
      if (!given || given.owner !== owner || now().getTime() - given.at > ttlMs) return refusal('INVALID', 'Choose where the restored data folder goes first: a restore writes only to the folder you were shown, once, from this window.');
      const seen = typeof request.previewId === 'string' ? previews.get(request.previewId) : undefined;
      if (!seen || seen.owner !== owner) return refusal('INVALID', 'Preview the backup first: a restore brings in only what you were shown.');
      const target = given.folder;
      const problem = targetProblem(target);
      if (problem) return refusal('INVALID', problem);
      // The backup must still be the one that was shown; the import checks the same fingerprint on the bytes it uses.
      try {
        if (exportFingerprint(inspectExport(seen.from)) !== seen.fingerprint) return refusal('INVALID', 'The backup changed since you were shown it, so nothing was written. Choose it again.');
      } catch (error) {
        if (error instanceof BackupRefused) return refusal(error.reason, error.message);
        throw error;
      }
      // Written before anything else is: if the app stops, the next start still knows this restore and its folder.
      startedAt = now().toISOString();
      record('running', seen.from, target); // a convenience: if it cannot be written, the restore goes on
      current = guarded(seen.from, target, seen.plan.adds, { parent: given.parent, parentId: given.parentId }, seen.fingerprint, owner).finally(() => { current = undefined; });
      return { ok: true, job: job! };
    },

    /** The person has read the finished or failed job: the dialog starts clean. A running job stays. */
    dismiss(): RestoreView {
      if (job && job.state !== 'running') { job = null; forgetRecord(home); }
      return view();
    },
  };
}

export type Restorer = ReturnType<typeof createRestorer>;

/** One call from a page: the same answer from Electron's IPC and from the browser bridge. */
export async function answerRestore(restorer: Restorer, request: unknown, owner: number): Promise<unknown> {
  const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
  switch (r.step) {
    case 'view': return restorer.view();
    case 'preview': return restorer.preview(r.ticket, owner);
    case 'target': return restorer.target(undefined, owner);
    case 'start': return restorer.start({ previewId: r.previewId, ticket: r.ticket }, owner);
    case 'open': return restorer.open(r.id, owner);
    case 'dismiss': return restorer.dismiss();
    default: return refusal('INVALID', 'Unknown restore step.');
  }
}
