// What export admits and how it writes, kept free of Electron so it can be tested on its own.
// Admission binds a request to the document shown in its project, before anything is read; the
// write puts fully rendered bytes in a fresh file beside the chosen one and renames it onto the
// chosen name, refusing a link or a folder that changed since the person chose it.
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink, chmod } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { MaterialEntry } from '@backbone-next/platform';
import type { ExportFormat } from './export-html.ts';

const MB = 1024 * 1024;
/** On the stored bytes, before reading or rendering. */
export const EXPORT_LIMITS: Record<ExportFormat, number> = { pdf: 2 * MB, slides: 2 * MB, html: 20 * MB, md: 20 * MB };

/** Why this version of this entry may not be exported, or undefined when it may. `entry` is the one found in the named project. */
export function refusal(entry: MaterialEntry | undefined, version: number, format: ExportFormat): string | undefined {
  if (!entry) return 'That document is not in this project.';
  if (entry.held) return 'This document is held for your decision; decide on it before exporting.';
  const last = entry.withdrawals?.at(-1);
  if (last && !last.restoredAt) return 'This document is withdrawn; restore it to export it.';
  const shown = entry.versions.find((v) => v.n === version);
  if (!shown || version > entry.current) return 'That version does not exist.';
  if (shown.bytes > EXPORT_LIMITS[format]) return `This version is too large to export as ${format === 'slides' ? 'PDF slides' : format.toUpperCase()} (limit ${EXPORT_LIMITS[format] / MB} MB).`;
  return undefined;
}

/** One export at a time across the app: a second request while one is open is refused at once. */
export function exportSlot() {
  let busy = false;
  return {
    take: () => (busy ? false : (busy = true)),
    release: () => { busy = false; },
  };
}

/** Rejects after `ms`, calling `onTimeout` first (which destroys whatever is still running). */
export function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => void, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { onTimeout(); reject(new Error(message)); }, ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** The chosen folder as it really is when the person chooses; the write checks it again before the rename. */
export const chosenFolder = (chosen: string) => realpath(dirname(chosen));

/**
 * Writes `bytes` under the chosen name: a fresh file beside it (created exclusively, never through a
 * link), then a rename onto the name. An existing regular file there is replaced, as the person
 * approved in the save dialog; a link or anything else there, or a folder that is no longer the one
 * chosen, is refused and nothing is left behind.
 */
export async function writeChosen(chosen: string, folderAtChoice: string, bytes: string | Uint8Array): Promise<void> {
  const name = basename(chosen);
  const sameFolder = async () => {
    if ((await realpath(dirname(chosen))) !== folderAtChoice) throw Object.assign(new Error('The chosen folder changed; nothing was written.'), { code: 'EEXPORTFOLDER' });
  };
  await sameFolder();
  const temp = join(folderAtChoice, `.${name}.${randomBytes(6).toString('hex')}.export`);
  // Private while it is written; a replaced file keeps the permissions it had, so an export never widens who can read it.
  const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let renamed = false;
  try {
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    const there = await lstat(chosen).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (there && (there.isSymbolicLink() || !there.isFile())) throw Object.assign(new Error('The chosen name is a link or not a file; nothing was written.'), { code: 'EEXPORTTARGET' });
    await chmod(temp, there ? there.mode & 0o777 : 0o666 & ~process.umask());
    await sameFolder();
    await rename(temp, join(folderAtChoice, name));
    renamed = true;
  } finally {
    if (!renamed) await unlink(temp).catch(() => undefined);
  }
}
