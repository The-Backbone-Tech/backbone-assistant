// Each tool's connection record in its own file, with a revision: a write names the revision it
// read and is refused when the file has moved on (compare-and-set), so a stale copy never overwrites
// a newer one, and one tool's save never touches another's. Writes are whole and atomic, and the
// callers hold the data home's lock (composition/home-lock.ts) around them.
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from '../stub/fsx.ts';

export class Conflict extends Error {}

const fileOf = (dir: string, key: string) => join(dir, `${key}.json`);

/** The record and its revision, or null when there is none. */
export function readRecord<T>(dir: string, key: string): { rev: number; value: T } | null {
  const file = fileOf(dir, key);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as { rev: number; value: T };
}

/** Write (or with null, remove) the record if it is still at `expected` (0: none yet). Returns the new revision. */
export function writeRecord<T>(dir: string, key: string, value: T | null, expected: number): number {
  const now = readRecord<T>(dir, key)?.rev ?? 0;
  if (now !== expected) throw new Conflict(`The ${key} record changed elsewhere (revision ${now}, not ${expected}); nothing was written.`);
  if (value === null) {
    rmSync(fileOf(dir, key), { force: true });
    return 0;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeAtomic(fileOf(dir, key), `${JSON.stringify({ rev: now + 1, value }, null, 2)}\n`);
  return now + 1;
}
