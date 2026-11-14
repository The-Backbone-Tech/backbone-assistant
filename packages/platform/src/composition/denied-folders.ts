// What a home's settings.json denies to the engine besides credential places.
import { join } from 'node:path';
import { HARNESSES } from './harnesses.ts';
import { readJson } from '../stub/fsx.ts';

/**
 * Folders the home's settings.json denies to the engine besides credential places: a run arrangement's
 * isolation. Absent is none. Anything else than a list of folder paths, or a list given to an engine
 * that cannot deny them (the native Codex and ACP registrations declare it), refuses the host before any engine starts.
 */
export function deniedFoldersOf(home: string, harnessId: string): string[] {
  const settings = readJson<Record<string, unknown>>(join(home, 'settings.json'), {});
  if (!settings || typeof settings !== 'object' || !Object.hasOwn(settings, 'deniedFolders')) return [];
  const denied = settings.deniedFolders;
  if (!Array.isArray(denied) || denied.some((d) => typeof d !== 'string')) throw new Error('settings.json deniedFolders must be a list of folder paths; nothing was started.');
  if (denied.length && !HARNESSES[harnessId]?.denies) throw new Error(`settings.json deniedFolders needs an engine with path-deny support (native Codex or ACP); ${harnessId} cannot, so nothing was started.`);
  return denied as string[];
}
