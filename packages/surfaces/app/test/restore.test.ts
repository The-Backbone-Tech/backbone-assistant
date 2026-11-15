// The app's restore, as main drives it: a preview that changes nothing, a ticket for a new folder
// bound to the window, every refusal known before a write given before any folder is made, and a job
// whose state (done, refused, partly done, not known) outlives the page that started it. The host is
// scripted; the end-to-end spec (e2e/restore.spec.ts) restores a real export through a real host.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { BackupRefused } from '@backbone-next/platform/composition/backup';
import { answerRestore, createRestorer, type RestoreHost, type RestoreJob } from '../electron/restore.ts';

const scratch: string[] = [];
const fresh = (label: string) => { const dir = mkdtempSync(join(tmpdir(), `backbone-restore-${label}-`)); scratch.push(dir); return dir; };
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** The smallest real export: one project, its manifest and the digest of each file. */
function anExport(): string {
  const folder = join(fresh('export'), 'export');
  mkdirSync(join(folder, 'projects', 'p001'), { recursive: true });
  const files = { 'README.md': 'About this export.\n', 'projects/p001/project.json': JSON.stringify({ name: 'Harbor', kind: 'folder' }) };
  for (const [rel, text] of Object.entries(files)) writeFileSync(join(folder, rel), text);
  const counts = { projects: 1, threads: 0, documents: 0, versions: 0, memoryFiles: 0, skills: 0, receipts: 0, unresolved: 0 };
  writeFileSync(join(folder, 'manifest.json'), JSON.stringify({ format: 'home-export', version: 4, id: 'e-1', createdAt: '2026-11-14T09:00:00.000Z', counts, excluded: [], scrubbed: 0, files: Object.fromEntries(Object.entries(files).map(([rel, text]) => [rel, sha(text)])) }));
  return folder;
}

interface Script { folders?: import('../electron/restore.ts').RestorerOptions['folders']; importExport?: (target: string) => Promise<unknown>; opened?: string[]; calls?: string[]; onCall?: (method: string, target: string) => void; home?: string }
function restorerFor(script: Script = {}, unavailable?: () => string | undefined) {
  const home = script.home ?? join(fresh('home'), 'current');
  mkdirSync(home, { recursive: true });
  const opened: string[] = script.opened ?? [];
  const calls: string[] = script.calls ?? [];
  const restorer = createRestorer({
    home, unavailable, folders:script.folders,
    openHost: (target) => {
      opened.push(target);
      return {
        call: async (method: string) => { calls.push(method); script.onCall?.(method, target); return []; },
        importExport: async () => { calls.push('importExport'); return (await script.importExport?.(target)) ?? { export: { counts: { projects: 1 } }, adds: { projects: 2, documents: 0, versions: 0, chats: 0, memoryFiles: 0, skills: 0 }, skipped: [] }; },
        close: () => { calls.push('close'); },
      } as unknown as RestoreHost;
    },
  });
  return { restorer, home, opened, calls };
}

const until = async (restorer: ReturnType<typeof createRestorer>, state: RestoreJob['state']) => {
  for (let i = 0; i < 200; i += 1) { if (restorer.view().job?.state === state) return restorer.view().job!; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error(`the job never reached ${state}: ${JSON.stringify(restorer.view().job)}`);
};
/** The folder as the native picker hands it over: a ticket main issued, which is all a preview takes. */
const picked = (restorer: ReturnType<typeof createRestorer>, from: string, owner = 1) => {
  const s = restorer.source(from, owner);
  assert.ok(s.ok, JSON.stringify(s));
  return s.ticket;
};
const previewed = async (restorer: ReturnType<typeof createRestorer>, from: string) => {
  const p = await restorer.preview(picked(restorer, from), 1);
  assert.ok(p.ok, JSON.stringify(p));
  return p.preview;
};

test('a preview reads the backup, says what comes in, and makes nothing', async () => {
  const { restorer, home, opened } = restorerFor();
  const before = dirname(home);
  const p = await previewed(restorer, anExport());
  assert.equal(p.counts.projects, 1);
  assert.equal(p.adds.projects, 2, 'the project and the one the history goes in');
  assert.deepEqual(p.conflicts, []);
  assert.equal(opened.length, 0, 'no host is opened for a preview');
  assert.deepEqual(readdirSync(before), [basename(home)], 'nothing is made beside the current data folder');
});

test('a folder that is not a backup is refused with the operation\'s own reason', async () => {
  const { restorer } = restorerFor();
  const empty = fresh('not-a-backup');
  const p = await restorer.preview(picked(restorer, empty), 1);
  assert.equal(p.ok, false);
  assert.match((p as { detail: string }).detail, /holds no manifest\.json/);
});

test('the new data folder is a new name beside the current one, and a chosen place gets a new folder inside it', () => {
  const { restorer, home } = restorerFor();
  const beside = restorer.target(undefined, 1);
  assert.ok(beside.ok);
  assert.equal(dirname(beside.folder), dirname(home));
  assert.match(basename(beside.folder), /^current-restored-\d{4}-\d\d-\d\d-\d{4}$/);
  const place = fresh('place');
  const inside = restorer.target(place, 1);
  assert.ok(inside.ok);
  assert.equal(dirname(inside.folder), place);
  assert.equal(existsSync(inside.folder), false, 'nothing is made until the restore starts');
});

test('the current data folder, and anywhere inside it, is never offered as the place', () => {
  const { restorer, home } = restorerFor();
  const inside = restorer.target(home, 1);
  assert.equal(inside.ok, false);
  assert.match((inside as { detail: string }).detail, /using now/);
  const notAFolder = restorer.target(join(home, 'missing'), 1);
  assert.equal(notAFolder.ok, false);
});

test('a ticket is good once, from the window that took it, and a restore needs a preview', async () => {
  const { restorer, opened } = restorerFor();
  const p = await previewed(restorer, anExport());
  const t = restorer.target(undefined, 1);
  assert.ok(t.ok);
  assert.equal(restorer.start({ previewId: p.previewId, ticket: t.ticket }, 2).ok, false, 'another window');
  assert.equal(restorer.start({ previewId: p.previewId, ticket: t.ticket }, 1).ok, false, 'the ticket went with the first try');
  const again = restorer.target(undefined, 1);
  assert.ok(again.ok);
  assert.equal(restorer.start({ previewId: 'made-up', ticket: again.ticket }, 1).ok, false, 'no preview');
  assert.equal(restorer.start({ previewId: p.previewId, ticket: 'f'.repeat(64) }, 1).ok, false, 'a ticket the page made up');
  assert.equal(opened.length, 0);
});

test('a place that is not empty by the time the person restores is refused before anything is written', async () => {
  const { restorer, opened } = restorerFor();
  const p = await previewed(restorer, anExport());
  const t = restorer.target(undefined, 1);
  assert.ok(t.ok);
  mkdirSync(t.folder);
  writeFileSync(join(t.folder, 'notes.txt'), 'the person\'s own file');
  const started = restorer.start({ previewId: p.previewId, ticket: t.ticket }, 1);
  assert.equal(started.ok, false);
  assert.match((started as { detail: string }).detail, /not a new, empty data folder/);
  assert.equal(opened.length, 0, 'no host was opened on it');
  assert.equal(existsSync(join(t.folder, 'notes.txt')), true, 'what was there is left as it was');
  assert.equal(restorer.view().job, null);
});

test('restore runs: the host opens on the new folder, imports once, closes; the result stays until read', async () => {
  const calls: string[] = [];
  const { restorer, opened } = restorerFor({ calls });
  const p = await previewed(restorer, anExport());
  const t = restorer.target(undefined, 1);
  assert.ok(t.ok);
  const started = restorer.start({ previewId: p.previewId, ticket: t.ticket }, 1);
  assert.ok(started.ok);
  assert.equal(started.job.state, 'running');
  const done = await until(restorer, 'done');
  assert.equal(done.state === 'done' && done.target, t.folder);
  assert.deepEqual(opened, [t.folder]);
  assert.deepEqual(calls, ['projects.list', 'importExport', 'close'], 'opened and checked, imported once, then closed');
  // Leaving the dialog and coming back: the same result is still there, until it is dismissed.
  assert.equal(restorer.view().job?.state, 'done');
  assert.equal(restorer.dismiss().job, null);
});

test('a second restore waits for the first', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { restorer } = restorerFor({ importExport: async () => { await gate; return undefined; } });
  const p = await previewed(restorer, anExport());
  const t = restorer.target(undefined, 1);
  assert.ok(t.ok);
  assert.ok(restorer.start({ previewId: p.previewId, ticket: t.ticket }, 1).ok);
  await until(restorer, 'running');
  const other = restorer.target(undefined, 1);
  assert.ok(other.ok);
  const second = restorer.start({ previewId: p.previewId, ticket: other.ticket }, 1);
  assert.equal(second.ok, false);
  assert.match((second as { detail: string }).detail, /already running/);
  assert.equal(restorer.dismiss().job?.state, 'running', 'a running job is not dismissed');
  release();
  await until(restorer, 'done');
});

test('a restore that ends part-way says the folder holds part of the export, with its path, and is never done', async () => {
  const calls: string[] = [];
  const { restorer } = restorerFor({ calls, importExport: async () => { const e = new BackupRefused('NOT_AVAILABLE', 'A project: Disk full. The data folder holds part of the export: import again into another new data folder.'); e.partial = true; throw e; } });
  const p = await previewed(restorer, anExport());
  const t = restorer.target(undefined, 1);
  assert.ok(t.ok);
  restorer.start({ previewId: p.previewId, ticket: t.ticket }, 1);
  const job = await until(restorer, 'refused');
  assert.ok(job.state === 'refused');
  assert.equal(job.partial, true);
  assert.equal(job.target, t.folder);
  assert.match(job.detail, /holds part of the export/);
  assert.equal(existsSync(t.folder), true, 'the part that came in is left, not hidden');
  assert.equal(calls.filter((c) => c === 'importExport').length, 1, 'never tried again by itself');
});

test('an outcome that cannot be established is not known, and not retried', async () => {
  const unknown = async () => { const e = new BackupRefused('NOT_AVAILABLE', 'A project: Inspect the creation. The data folder holds part of the export: import again into another new data folder.'); e.partial = true; e.unknown = true; throw e; };
  for (const importExport of [unknown, async () => { throw new Error('the connection closed'); }]) {
    const calls: string[] = [];
    const { restorer } = restorerFor({ calls, importExport });
    const p = await previewed(restorer, anExport());
    const t = restorer.target(undefined, 1);
    assert.ok(t.ok);
    restorer.start({ previewId: p.previewId, ticket: t.ticket }, 1);
    const job = await until(restorer, 'unknown');
    assert.ok(job.state === 'unknown');
    assert.equal(job.target, t.folder);
    assert.equal(calls.filter((c) => c === 'importExport').length, 1);
  }
});

test('a refusal after the folder was made leaves the folder, gives its path and does not call it nothing', async () => {
  const { restorer, go, t } = await started({ importExport: async () => { throw new BackupRefused('INVALID', 'An import is already running in this data folder.'); } });
  assert.ok(go().ok);
  const job = await until(restorer, 'refused');
  assert.ok(job.state === 'refused');
  assert.equal(job.partial, false);
  assert.equal(job.remains, true, 'the folder may be there');
  assert.equal(job.target, t.folder);
  assert.equal(existsSync(t.folder), true, 'nothing is ever removed');
});

test('where restore is unavailable, the reason is given and no step runs', async () => {
  const { restorer, opened } = restorerFor({}, () => 'Your company keeps data folders under its own control.');
  assert.deepEqual(restorer.view().availability, { available: false, reason: 'Your company keeps data folders under its own control.' });
  assert.equal(restorer.source(anExport(), 1).ok, true);
  assert.equal((await restorer.preview('x', 1)).ok, false);
  assert.equal(restorer.target(undefined, 1).ok, false);
  assert.equal(restorer.start({ previewId: 'x', ticket: 'y' }, 1).ok, false);
  assert.equal(opened.length, 0);
});

test('the page can ask only for the steps there are', async () => {
  const { restorer } = restorerFor();
  assert.deepEqual(await answerRestore(restorer, { step: 'rm -rf' }, 1), { ok: false, reason: 'INVALID', detail: 'Unknown restore step.' });
  assert.deepEqual(await answerRestore(restorer, null, 1), { ok: false, reason: 'INVALID', detail: 'Unknown restore step.' });
  // A page that names a folder with its target step is not heard: only main's picker passes one.
  const named = await answerRestore(restorer, { step: 'target', parent: '/' }, 1) as { folder: string };
  assert.notEqual(dirname(named.folder), '/');
});

// ---- Review repairs: ownership of the folder written and removed, cleanup, read-only, shutdown, fingerprint ----

test('a preview takes only a folder the native picker handed over, never a path the page names', async () => {
  const { restorer } = restorerFor();
  const named = await restorer.preview(anExport(), 1);
  assert.equal(named.ok, false, 'a path is not a ticket');
  const ticket = picked(restorer, anExport(), 1);
  assert.equal((await restorer.preview(ticket, 2)).ok, false, 'another window');
  assert.equal(restorer.source(join(fresh('f'), 'missing'), 1).ok, false, 'not a folder');
  const link = join(fresh('link'), 'l');
  symlinkSync(anExport(), link);
  assert.equal(restorer.source(link, 1).ok, false, 'a link is not the folder picked');
});

/** Starts a restore on a fresh preview and ticket; returns what the test needs. */
async function started(script: Script = {}, where?: (r: ReturnType<typeof restorerFor>) => string | undefined) {
  const world = restorerFor(script);
  const from = anExport();
  const p = await previewed(world.restorer, from);
  const parent = where?.(world);
  const t = world.restorer.target(parent, 1);
  assert.ok(t.ok, JSON.stringify(t));
  return { ...world, p, t, from, go: () => world.restorer.start({ previewId: p.previewId, ticket: t.ticket }, 1) };
}

test('a folder that appears between the check and the create is refused and left untouched', async () => {
  const { restorer, opened, t, go } = await started();
  mkdirSync(t.folder); // empty, so the earlier checks pass: only an exclusive create can tell it is not ours
  const first = go();
  assert.ok(first.ok);
  const job = await until(restorer, 'refused');
  assert.ok(job.state === 'refused');
  assert.equal(job.partial, false);
  assert.equal(opened.length, 0);
  assert.equal(existsSync(t.folder), true, 'a folder that was there is never removed');
  assert.match(job.detail, /appeared after you chose it/);
});

test('a link swapped in for the chosen place after it was checked is refused, with nothing written through it and nothing deleted', async () => {
  const place = fresh('place');
  const elsewhere = fresh('elsewhere');
  writeFileSync(join(elsewhere, 'precious.txt'), 'not ours');
  const { restorer, opened, go } = await started({}, () => place);
  renameSync(place, `${place}-moved`); scratch.push(`${place}-moved`);
  symlinkSync(elsewhere, place);
  assert.ok(go().ok);
  const job = await until(restorer, 'refused');
  assert.ok(job.state === 'refused');
  assert.equal(opened.length, 0);
  assert.deepEqual(readdirSync(elsewhere), ['precious.txt'], 'nothing was written through the link, nothing removed');
});

test('a link swapped in for the new folder after it was made is noticed before the import, and nothing it points at is removed', async () => {
  const elsewhere = fresh('elsewhere');
  writeFileSync(join(elsewhere, 'precious.txt'), 'not ours');
  const calls: string[] = [];
  const { restorer, go, t } = await started({ calls, onCall: (method, target) => { if (method === 'projects.list') { renameSync(target, `${target}-moved`); scratch.push(`${target}-moved`); symlinkSync(elsewhere, target); } } });
  assert.ok(go().ok);
  const job = await until(restorer, 'refused');
  assert.ok(job.state === 'refused');
  assert.equal(calls.includes('importExport'), false, 'no import into a folder that is not the one made');
  assert.deepEqual(readdirSync(elsewhere), ['precious.txt']);
  assert.equal(job.remains, true, 'the path is kept, as holding what this restore may not have made');
  assert.equal(job.target, t.folder);
});

test('a foreign file added to the new folder survives every way a restore can end', async () => {
  const ends: Record<string, () => Promise<unknown>> = {
    refused: async () => { throw new BackupRefused('INVALID', 'An import is already running in this data folder.'); },
    partial: async () => { const e = new BackupRefused('NOT_AVAILABLE', 'A project: Disk full.'); e.partial = true; throw e; },
    unknown: async () => { throw new Error('the connection closed'); },
    done: async () => undefined,
  };
  for (const [end, importExport] of Object.entries(ends)) {
    const { restorer, go, t } = await started({ importExport: async (target) => { writeFileSync(join(target, 'foreign.txt'), 'not made by the restore'); mkdirSync(join(target, 'pg')); writeFileSync(join(target, 'pg', 'precious.txt'), 'not ours'); return importExport(); } });
    assert.ok(go().ok);
    await until(restorer, end === 'refused' || end === 'partial' ? 'refused' : end === 'done' ? 'done' : 'unknown');
    assert.equal(readFileSync(join(t.folder, 'foreign.txt'), 'utf8'), 'not made by the restore', end);
    assert.equal(readFileSync(join(t.folder, 'pg', 'precious.txt'), 'utf8'), 'not ours', end);
  }
});

test('a folder that could not be made says nothing was made, and one that may exist says files may remain', async () => {
  const appeared = await started();
  mkdirSync(appeared.t.folder);
  assert.ok(appeared.go().ok);
  const first = await until(appeared.restorer, 'refused');
  assert.ok(first.state === 'refused');
  assert.equal(first.remains, false, 'the exclusive create never happened');
  const swapped = await started({ onCall: (method, target) => { if (method === 'projects.list') { renameSync(target, `${target}-moved`); scratch.push(`${target}-moved`); } } });
  assert.ok(swapped.go().ok);
  const second = await until(swapped.restorer, 'refused');
  assert.ok(second.state === 'refused');
  assert.equal(second.remains, true);
});

test('an error while inspecting the folder ends the job as not known, with its path, and never leaves it running', async () => {
  const { restorer, go, t } = await started({ onCall: (method) => { if (method === 'projects.list') throw 'a surprise that is not an Error'; } });
  assert.ok(go().ok);
  const job = await until(restorer, 'refused').catch(() => until(restorer, 'unknown'));
  assert.notEqual(job.state, 'running');
  assert.equal((job as { target: string }).target, t.folder);
});

test('a read-only current data folder makes restore unavailable at every step', async () => {
  const world = restorerFor();
  const from = anExport();
  const p = await previewed(world.restorer, from);
  const t = world.restorer.target(undefined, 1);
  assert.ok(t.ok);
  chmodSync(world.home, 0o555);
  try {
    const view = world.restorer.view();
    assert.equal(view.availability.available, false);
    assert.match((view.availability as { reason: string }).reason, /read-only/);
    assert.equal((await world.restorer.preview(picked(world.restorer, from), 1)).ok, false);
    assert.equal(world.restorer.target(undefined, 1).ok, false);
    assert.equal(world.restorer.start({ previewId: p.previewId, ticket: t.ticket }, 1).ok, false);
    assert.equal(world.opened.length, 0);
  } finally { chmodSync(world.home, 0o755); }
});

test('the person is told after an interruption, with the folder, and it is never retried', async () => {
  const gate = new Promise<void>(() => {}); // the app stops: this never finishes
  const first = await started({ importExport: async () => { await gate; return undefined; } });
  assert.ok(first.go().ok);
  await until(first.restorer, 'running');
  const marker = join(first.home, 'electron', 'restore-pending.json');
  assert.equal(existsSync(marker), true, 'written before the first write');
  const calls: string[] = [];
  const reopened = restorerFor({ home: first.home, calls }).restorer;
  const job = reopened.view().job;
  assert.ok(job?.state === 'unknown');
  assert.equal(job.target, first.t.folder);
  assert.match(job.detail, /result is not known/);
  assert.deepEqual(calls, [], 'nothing is tried again');
  reopened.dismiss();
  assert.equal(existsSync(marker), false, 'the marker goes once it has been read and dismissed');
});

test('a result from an earlier run of the app is never shown as finished', async () => {
  const { restorer, go, home, t } = await started();
  assert.ok(go().ok);
  await until(restorer, 'done');
  const again = restorerFor({ home }).restorer;
  const job = again.view().job;
  assert.ok(job?.state === 'unknown', 'whatever the record says, the result is not known');
  assert.equal(job.target, t.folder);
  assert.match(job.detail, /under way, or had finished/);
  again.dismiss();
  assert.equal(restorerFor({ home }).restorer.view().job, null);
});

const recordPath = (home: string) => join(home, 'electron', 'restore-pending.json');
const plant = (home: string, record: unknown) => { mkdirSync(join(home, 'electron'), { recursive: true }); writeFileSync(recordPath(home), JSON.stringify(record)); };
const good = { version: 1, state: 'done', from: '/backups/one', target: '/data/restored', at: '2026-11-14T10:00:00.000Z' };

test('a forged pending record that says finished is shown as not known, and a malformed one is ignored', () => {
  const forged = restorerFor();
  plant(forged.home, good);
  const job = restorerFor({ home: forged.home }).restorer.view().job;
  assert.ok(job?.state === 'unknown');
  assert.equal(job.target, '/data/restored');
  for (const bad of [
    { ...good, extra: 1 }, { ...good, state: 'Restored' }, { ...good, target: 'relative/path' }, { ...good, from: 'x'.repeat(5000) },
    { ...good, at: 'yesterday' }, { ...good, version: 2 }, [good], 'done', null,
  ]) {
    const world = restorerFor();
    plant(world.home, bad);
    assert.equal(restorerFor({ home: world.home }).restorer.view().job, null, JSON.stringify(bad)?.slice(0, 60));
  }
});

test('a linked state folder is neither written through nor deleted through', async () => {
  const elsewhere = fresh('elsewhere');
  writeFileSync(join(elsewhere, 'restore-pending.json'), 'someone else\'s file');
  const world = restorerFor();
  symlinkSync(elsewhere, join(world.home, 'electron'));
  const from = anExport();
  const p = await previewed(world.restorer, from);
  const t = world.restorer.target(undefined, 1);
  assert.ok(t.ok);
  assert.ok(world.restorer.start({ previewId: p.previewId, ticket: t.ticket }, 1).ok, 'the restore goes on without its record');
  await until(world.restorer, 'done');
  world.restorer.dismiss();
  assert.deepEqual(readdirSync(elsewhere), ['restore-pending.json'], 'nothing written through the link');
  assert.equal(readFileSync(join(elsewhere, 'restore-pending.json'), 'utf8'), 'someone else\'s file', 'nothing deleted through it');
});

test('a manifest changed after the preview is a different backup', async () => {
  const { opened, from, go, t } = await started();
  const manifest = JSON.parse(readFileSync(join(from, 'manifest.json'), 'utf8'));
  writeFileSync(join(from, 'manifest.json'), JSON.stringify({ ...manifest, version: 3 }));
  const refused = go();
  assert.equal(refused.ok, false);
  assert.equal(opened.length, 0);
  assert.equal(existsSync(t.folder), false);
});

test('the restore module contains no removal of any kind', () => {
  const source = readFileSync(new URL('../electron/restore.ts', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(source, /\b(rmSync|rmdirSync|unlinkSync|unlink|rm|removeDataHome|remove)\s*\(/);
  // Putting away the person's own record of the job is restore-record.ts's, after its own checks; it never names the destination.
  assert.doesNotMatch(source, /\bfs\/promises\b/);
});

test('shutdown waits for a running restore', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { restorer, go } = await started({ importExport: async () => { await gate; return undefined; } });
  assert.ok(go().ok);
  await until(restorer, 'running');
  let drained = false;
  const waiting = restorer.drain().then(() => { drained = true; });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(drained, false, 'still running');
  release();
  await waiting;
  assert.equal(restorer.view().job?.state, 'done');
});

test('a backup replaced after its preview is refused before anything is written', async () => {
  const { restorer, opened, from, go, t } = await started();
  // Another valid export takes the place of the one that was shown.
  writeFileSync(join(from, 'projects', 'p001', 'project.json'), JSON.stringify({ name: 'Somebody else', kind: 'folder' }));
  const manifest = JSON.parse(readFileSync(join(from, 'manifest.json'), 'utf8'));
  manifest.files['projects/p001/project.json'] = sha(JSON.stringify({ name: 'Somebody else', kind: 'folder' }));
  writeFileSync(join(from, 'manifest.json'), JSON.stringify(manifest));
  const refused = go();
  assert.equal(refused.ok, false);
  assert.match((refused as { detail: string }).detail, /changed since you were shown it/);
  assert.equal(opened.length, 0);
  assert.equal(existsSync(t.folder), false);
  assert.equal(restorer.view().job, null);
});


test('only a verified restore in this instance gets a window-bound open identity; a persisted record never does', async () => {
  const picks: string[]=[];const opens: unknown[]=[];
  const world=await started({folders:{pick:(folder,owner)=>{picks.push(folder);assert.equal(owner,1);return {ok:true,id:'main-only-id',folder};},open:async(id,owner)=>{opens.push([id,owner]);return {state:'opened'};}}});
  world.go();const done=await until(world.restorer,'done');assert.equal(done.state,'done');if(done.state!=='done')return;
  assert.equal(done.openId,'main-only-id');assert.deepEqual(picks,[world.t.folder]);
  assert.deepEqual(await answerRestore(world.restorer,{step:'open',id:done.openId,path:'/renderer/path'},1),{state:'opened'});
  assert.deepEqual(opens,[['main-only-id',1]]);
  const reopened=restorerFor({home:world.home}).restorer.view().job;
  assert.equal(reopened?.state,'unknown');assert.equal('openId' in reopened!,false);
});
test('a finished import stays done when the folder open check refuses and is not offered for opening',async()=>{
  const world=await started({folders:{pick:()=>({ok:false,reason:'INVALID',detail:'The restored data folder is incomplete.'}),open:async()=>{throw new Error('must not launch');}}});
  world.go();const job=await until(world.restorer,'done');assert.equal('openId' in job,false);assert.match(job.state==='done'?job.openProblem??'':'',/Restored.*incomplete/);
});
