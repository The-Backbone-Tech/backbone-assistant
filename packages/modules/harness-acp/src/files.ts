import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { assertDirectory, assertOpenedFile, type DirectoryIdentity } from './directories.ts';
import { RequestError } from '@agentclientprotocol/sdk';

/** Flat scratch files only; recheck the recorded parent identity before opening the joined path. */
export async function scratchFile(directory: DirectoryIdentity, path: string, body?: string): Promise<string> {
  assertDirectory(directory);
  const work = directory.path;
  const joined = join(work, basename(path));
  if (!isAbsolute(path) || path !== joined || basename(path).startsWith('.') || /[\x00-\x1f]/.test(path)) throw new RequestError(-32000, 'Only regular scratch files directly inside this turn working folder are available.');
  if (body !== undefined && Buffer.byteLength(body) > 1_000_000) throw new RequestError(-32000, 'Scratch file exceeds the size limit.');
  let file;
  try {
    file = await open(joined, constants.O_NOFOLLOW | constants.O_NONBLOCK | (body === undefined ? constants.O_RDONLY : constants.O_WRONLY | constants.O_CREAT), 0o600);
    const info = await file.stat();
    assertOpenedFile(directory, joined, info);
    if (!info.isFile() || info.nlink !== 1 || info.size > 1_000_000) throw new Error('Not a bounded regular file.');
    if (body === undefined) {
      const buffer = Buffer.alloc(1_000_001); let bytes = 0;
      while (bytes < buffer.length) {
        const part = await file.read(buffer, bytes, buffer.length - bytes, bytes);
        if (!part.bytesRead) break; bytes += part.bytesRead;
      }
      if (bytes > 1_000_000) throw new Error('File grew beyond the limit.');
      return buffer.subarray(0, bytes).toString('utf8');
    }
    await file.truncate(0); await file.writeFile(body, 'utf8'); return '';
  } catch { throw new RequestError(-32000, 'Scratch file is unavailable, linked, or too large.'); }
  finally { await file?.close(); }
}
