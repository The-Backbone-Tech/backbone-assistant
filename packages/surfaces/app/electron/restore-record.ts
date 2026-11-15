// The record of a restore in the app's own state folder: a convenience so that, after the app stopped
// mid-restore, Settings › Backup can still say which folder was involved. It is not a custody record and
// never authority: it is read strictly, only ever names a folder to show, and whatever it says, the app
// reports that the result is not known. Every read, write and removal first checks that the state folder
// and the record are plain (no link) and inside the real data folder, and asks for write admission
// immediately before it writes or removes; a check that fails leaves the file alone, and the app carries on.
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { assertHomeWriteAdmission } from '@backbone-next/platform/composition/home-lock';

export interface RestoreRecord { version: 1; state: 'running' | 'done' | 'refused' | 'unknown'; from: string; target: string; at: string }

const STATES = new Set(['running', 'done', 'refused', 'unknown']);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0');

/** Exactly the record's shape, with known states, bounded strings and absolute paths; anything else is not a record. */
export function validRecord(value: unknown): RestoreRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(',');
  if (keys !== 'at,from,state,target,version' || v.version !== 1) return null;
  if (typeof v.state !== 'string' || !STATES.has(v.state)) return null;
  if (!text(v.from, 4096) || !isAbsolute(v.from) || !text(v.target, 4096) || !isAbsolute(v.target)) return null;
  if (!text(v.at, 40) || Number.isNaN(Date.parse(v.at))) return null;
  return v as unknown as RestoreRecord;
}

/** The state folder and record paths if both are plain and inside the real data folder; null otherwise. A missing record is fine. */
function placed(home: string): { dir: string; file: string; exists: boolean } | null {
  try {
    const dir = join(home, 'electron');
    const file = join(dir, 'restore-pending.json');
    const realHome = realpathSync(home);
    const d = lstatSync(dir, { throwIfNoEntry: false });
    if (d) {
      if (!d.isDirectory() || d.isSymbolicLink() || realpathSync(dir) !== join(realHome, 'electron')) return null;
    }
    const f = d ? lstatSync(file, { throwIfNoEntry: false }) : undefined;
    if (f && (!f.isFile() || f.isSymbolicLink() || f.nlink > 1)) return null;
    return { dir, file, exists: !!f };
  } catch { return null; }
}

export function readRecord(home: string): RestoreRecord | null {
  const at = placed(home);
  if (!at?.exists) return null;
  try { return validRecord(JSON.parse(readFileSync(at.file, 'utf8'))); } catch { return null; }
}

/** Writes the record; false (and nothing changed) when any check or the admission fails. */
export function writeRecord(home: string, record: RestoreRecord): boolean {
  try {
    if (!placed(home)) return false;
    const dir = join(home, 'electron');
    assertHomeWriteAdmission(home, dir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const after = placed(home); // the folder as it is now, once it exists
    if (!after) return false;
    const part = `${after.file}.${randomUUID().slice(0, 8)}.part`;
    writeFileSync(part, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
    assertHomeWriteAdmission(home, dir);
    renameSync(part, after.file);
    return true;
  } catch { return false; }
}

/** Removes only the record file itself, after the same checks; false when it was left. */
export function forgetRecord(home: string): boolean {
  try {
    const at = placed(home);
    if (!at) return false;
    if (!at.exists) return true;
    assertHomeWriteAdmission(home, at.dir);
    unlinkSync(at.file);
    return true;
  } catch { return false; }
}
