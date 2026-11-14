// File primitives for the stub. Writes go through the core's one durable writer (write-then-rename
// with fsync of the file and its folder), so a kill never leaves half a file.
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { writeDurable } from '@backbone-next/kernel/files';

/** A file anyone of this user's may read (0644 before the umask), written durably. */
export function writeAtomic(path: string, data: string | Uint8Array): void {
  writeDurable(path, data, 0o644);
}

export function writeJson(path: string, value: unknown): void {
  writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

export const isIntermediate = (name: string) => name.endsWith('.tmp') || name.startsWith('.');
