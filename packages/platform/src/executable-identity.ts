// Entry-file trust and identity shared by Settings, diagnostics and the external-agent launcher.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { userInfo } from 'node:os';
import type { AcpExecutableIdentity } from './api-acp.ts';
import { defaultToolEnv } from './tools/places.ts';

export function assertTrustedExecutableEntry(stat: { uid: number; mode: number }, uid = process.getuid?.()): void {
  if (uid === undefined || (stat.uid !== uid && stat.uid !== 0) || (stat.mode & 0o022)) {
    throw new Error('The executable and its ancestors must be owned by you or root and must not allow group or other writes.');
  }
}
function checkChain(path: string): void {
  for (let current = path; ; current = dirname(current)) {
    const link = lstatSync(current);
    if (link.isSymbolicLink()) {
      if (link.uid !== process.getuid?.() && link.uid !== 0) throw new Error('An executable link must be owned by you or root.');
    } else assertTrustedExecutableEntry(link);
    if (dirname(current) === current) break;
  }
}
const hashes = new Map<string, string>();
/** Absolute names only. Both the selected link hierarchy and its actual target are checked. */
export function inspectExecutable(path: string): AcpExecutableIdentity {
  if (!isAbsolute(path)) throw new Error('Use an absolute executable path or resolve an installed command first.');
  checkChain(path);
  const actual = realpathSync(path); checkChain(actual);
  const stat = statSync(actual); assertTrustedExecutableEntry(stat);
  if (!stat.isFile()) throw new Error('The executable must be a regular file.');
  accessSync(actual, constants.X_OK);
  const key = [actual, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
  let sha256 = hashes.get(key);
  if (!sha256) {
    const fd = openSync(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024);
      for (let count; (count = readSync(fd, buffer)) > 0;) hash.update(buffer.subarray(0, count));
      const after = fstatSync(fd);
      if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('The executable changed while being checked. Resolve and accept it again.');
      sha256 = hash.digest('hex');
      if (hashes.size >= 64) hashes.clear();
      hashes.set(key, sha256);
    } finally { closeSync(fd); }
  }
  const named = statSync(actual);
  if (realpathSync(path) !== actual || named.dev !== stat.dev || named.ino !== stat.ino || named.mtimeMs !== stat.mtimeMs || named.ctimeMs !== stat.ctimeMs) throw new Error('The executable changed while being checked. Resolve and accept it again.');
  return { path: actual, sha256, dev: stat.dev, ino: stat.ino };
}
export function verifyExecutable(expected: AcpExecutableIdentity): AcpExecutableIdentity {
  if (!expected || typeof expected.path !== 'string' || !/^[a-f0-9]{64}$/.test(expected.sha256) || !Number.isFinite(expected.dev) || !Number.isFinite(expected.ino)) throw new Error('The executable acceptance is missing or invalid. Resolve and accept it again.');
  const current = inspectExecutable(expected.path);
  if (current.path !== expected.path || current.sha256 !== expected.sha256 || current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error('The accepted executable changed. Resolve and accept it again in Settings.');
  }
  return current;
}
/** Reuse tool discovery's Finder install locations; never execute a login shell or use relative PATH entries. */
export function installedExecutablePath(env: NodeJS.ProcessEnv = process.env): string {
  return [...new Set([...(env.PATH ?? '/usr/bin:/bin').split(delimiter), ...defaultToolEnv(env).bins].filter(isAbsolute))].join(delimiter);
}
export function resolveExecutable(command: string, env: NodeJS.ProcessEnv = process.env): AcpExecutableIdentity {
  if (isAbsolute(command)) return inspectExecutable(command);
  if (!command || /[\/\\\x00-\x1f]/.test(command)) throw new Error('Relative executable paths are refused.');
  for (const dir of installedExecutablePath(env).split(delimiter)) {
    const candidate = join(dir, command);
    try { lstatSync(candidate); } catch { continue; }
    return inspectExecutable(candidate);
  }
  throw new Error('The installed executable was not found. Choose its absolute path.');
}

class ExecutablePermissionsChanged extends Error {}
const aclChecks = new Map<string, Promise<void>>();
/** macOS ACL grants do not appear in mode bits. Inspect them asynchronously and cache by metadata. */
export async function verifyExecutableAccess(expected: AcpExecutableIdentity): Promise<void> {
  verifyExecutable(expected);
  if (process.platform !== 'darwin') return;
  const own = `user:${userInfo().username}`, uid = `user:${process.getuid?.()}`;
  for (let path = expected.path; ; path = dirname(path)) {
    // Directory entries change ctime too. Retry a changed snapshot; never reuse its ACL result.
    for (let attempt = 0; ; attempt++) {
      const stat = statSync(path); assertTrustedExecutableEntry(stat);
      const key = [path, stat.dev, stat.ino, stat.uid, stat.mode, stat.ctimeMs].join(':');
      let pending = aclChecks.get(key);
      if (!pending) {
        const selected = path;
        pending = new Promise<void>((resolve, reject) => {
          execFile('/bin/ls', ['-lde', selected], { encoding: 'utf8', timeout: 1_000, maxBuffer: 64 * 1024, env: { PATH: '/usr/bin:/bin', LANG: 'C' } }, (error, stdout) => {
            if (error) return reject(new Error('The executable permissions could not be verified.'));
            for (const line of stdout.split('\n').slice(1).filter(line => /^\s*\d+:/.test(line))) {
              const entry = /^\s*\d+:\s+(.+?)\s+(allow|deny)\s+(.+)$/.exec(line);
              if (!entry) return reject(new Error('The executable ACL could not be verified.'));
              if (entry[2] === 'allow' && ![own, uid, 'user:root', 'user:0'].includes(entry[1]) && /\b(write|append|delete|delete_child|add_file|add_subdirectory|writeattr|writeextattr|writesecurity|chown)\b/.test(entry[3])) return reject(new Error('The executable or an ancestor grants write access to another user or group.'));
            }
            try {
              const after = statSync(selected);
              if (after.dev !== stat.dev || after.ino !== stat.ino) return reject(new Error('The executable permissions changed while being checked.'));
              if (after.ctimeMs !== stat.ctimeMs) return reject(new ExecutablePermissionsChanged('The executable permissions changed while being checked.'));
              resolve();
            } catch { reject(new Error('The executable disappeared while checking its permissions.')); }
          });
        });
        if (aclChecks.size >= 512) aclChecks.clear();
        aclChecks.set(key, pending);
      }
      try { await pending; break; } catch (error) {
        aclChecks.delete(key);
        if (!(error instanceof ExecutablePermissionsChanged) || attempt >= 4) throw error;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    if (dirname(path) === path) break;
  }
  verifyExecutable(expected);
}
