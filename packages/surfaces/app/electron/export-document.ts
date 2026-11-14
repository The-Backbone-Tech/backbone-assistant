// Export: the person saves the document version they are looking at as Markdown, HTML or PDF where
// they choose. The renderer names only the project, the material, the version shown and the format;
// main checks that this is a document of that project that is neither held nor withdrawn, that the
// version exists, and that its stored size is within the format's limit, before reading anything.
// It asks where with the native save dialog (titled with project, document and version), renders
// fully, and writes through export-policy.ts. The renderer never gets a path or a way to write.
// Export records nothing: no version, draft or effect, besides whatever recovery a read already does.
import { app, BrowserWindow, dialog, type SaveDialogOptions } from 'electron';
import { join } from 'node:path';
import type { Receipt } from '@backbone-next/platform';
import type { Host } from '@backbone-next/platform/composition';
import { type ExportFormat, exportHtml, exportName, exportSlides, pageSizeFor } from './export-html';
import { chosenFolder, exportSlot, refusal, withTimeout, writeChosen } from './export-policy';

const FORMATS: Record<ExportFormat, { name: string; extensions: string[] }> = {
  md: { name: 'Markdown', extensions: ['md'] },
  html: { name: 'Web page', extensions: ['html'] },
  pdf: { name: 'PDF', extensions: ['pdf'] },
  slides: { name: 'PDF slides', extensions: ['pdf'] },
};
// Chromium refuses a longer data URL; past it, PDF says so and HTML still works.
const MAX_PRINTED = 2 * 1024 * 1024 - 64;
const PRINT_TIMEOUT_MS = 30_000;
const slot = exportSlot();
type Exported = Receipt<{ saved: boolean }>;
const refused = (reason: 'NOT_FOUND' | 'NOT_AVAILABLE', detail: string): Exported => ({ ok: false, reason, detail, outcome: 'REFUSED' });

/** Prints the page in a hidden window that runs no script, follows no link and reaches no network; it is destroyed after, or after 30 s. */
/** A deck prints on 16:9 pages with no margin; a page on the paper of the person's country. */
async function printPdf(html: string, deck = false): Promise<Uint8Array> {
  const url = `data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf8').toString('base64')}`;
  if (url.length > MAX_PRINTED) throw new Error('This document is too large to print to PDF here; export it as HTML instead.');
  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, javascript: false, webSecurity: true, spellcheck: false, partition: 'backbone-export' },
  });
  const destroy = () => { if (!win.isDestroyed()) win.destroy(); };
  try {
    const contents = win.webContents;
    // The page's own policy forbids every fetch; its in-memory session refuses anything but the page itself.
    contents.session.webRequest.onBeforeRequest((request, answer) => answer({ cancel: request.url !== url }));
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.on('will-redirect', (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const print = win.loadURL(url).then(() => contents.printToPDF(deck ? { pageSize: { width: 13.333, height: 7.5 }, margins: { top: 0, bottom: 0, left: 0, right: 0 }, preferCSSPageSize: true, printBackground: true } : { pageSize: pageSizeFor(app.getLocaleCountryCode()), printBackground: true }));
    return await withTimeout(print, PRINT_TIMEOUT_MS, destroy, 'Printing to PDF took too long.');
  } finally {
    destroy();
  }
}

export async function exportDocument(host: Host, win: BrowserWindow | null, request: unknown): Promise<Exported> {
  const { projectId, id, version, format } = (request ?? {}) as { projectId?: unknown; id?: unknown; version?: unknown; format?: unknown };
  if (typeof projectId !== 'string' || typeof id !== 'string' || !Number.isInteger(version) || (version as number) < 1 || !Object.hasOwn(FORMATS, format as string)) return refused('NOT_FOUND', 'Nothing to export.');
  if (!slot.take()) return refused('NOT_AVAILABLE', 'An export is already open; finish it first.');
  try {
    return await run(host, win, projectId, id, version as number, format as ExportFormat);
  } finally {
    slot.release();
  }
}

async function run(host: Host, win: BrowserWindow | null, projectId: string, id: string, version: number, f: ExportFormat): Promise<Exported> {
  // Admission from the project's own listing, before a byte of the document is read.
  const entry = (await host.call('material.list', { projectId, includeHidden: true })).find((e) => e.id === id);
  const no = refusal(entry, version, f);
  if (no || !entry) return refused(entry ? 'NOT_AVAILABLE' : 'NOT_FOUND', no ?? 'Nothing to export.');
  const project = (await host.call('projects.list', {})).find((p) => p.id === projectId)?.name ?? 'project';
  const options: SaveDialogOptions = {
    title: `Export ${project} › ${entry.name} v${version}`,
    defaultPath: join(app.getPath('documents'), exportName(entry.name, version, f)),
    filters: [FORMATS[f]],
  };
  const chosen = await (win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options));
  // Cancel is the person's answer, not a failure: nothing is written and nothing is said.
  if (chosen.canceled || !chosen.filePath) return { ok: true, value: { saved: false } };
  try {
    const folder = await chosenFolder(chosen.filePath);
    // The dialog can stay open a while: a document held or withdrawn meanwhile is not exported.
    const now = (await host.call('material.list', { projectId, includeHidden: true })).find((e) => e.id === id);
    const late = refusal(now, version, f);
    if (late || !now) return refused(now ? 'NOT_AVAILABLE' : 'NOT_FOUND', late ?? 'Nothing to export.');
    const read = await host.call('material.read', { id, version });
    if (!read.ok) return read;
    const { text } = read.value;
    if (text === undefined) return refused('NOT_AVAILABLE', 'Only text documents can be exported; use Download for this file.');
    const bytes = f === 'md' ? text : f === 'html' ? exportHtml(entry.name, text) : f === 'slides' ? await printPdf(exportSlides(entry.name, text), true) : await printPdf(exportHtml(entry.name, text));
    await writeChosen(chosen.filePath, folder, bytes);
  } catch (error) {
    // A file system error names the path; the renderer hears only its code. Export's own refusals say why.
    const { code, message } = error as NodeJS.ErrnoException;
    return refused('NOT_AVAILABLE', code?.startsWith('EEXPORT') ? message : code ? `The export could not be written (${code}).` : `The export could not be finished: ${message ?? 'unknown error'}`);
  }
  return { ok: true, value: { saved: true } };
}
