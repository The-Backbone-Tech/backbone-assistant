// Internal filesystem boundary. Production constructs it with the filesystem root and uid 0;
// tests construct it with a real, current-user temporary root. Neither is runtime configuration.
import fs from 'node:fs';
import { constants } from 'node:fs';
import childProcess from 'node:child_process';
import { dirname, relative, resolve, isAbsolute } from 'node:path';
import { refuse } from './verify.ts';

/** The fd boundary is separate so a real symlink test proves O_NOFOLLOW itself. */
export function openPolicyFile(path: string, owner?: number): Buffer {
  if (constants.O_NOFOLLOW === undefined) refuse('unsupported-platform', 'This platform cannot open policy files without following links.');
  const fd = fs.openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 131072 || (owner !== undefined && (stat.uid !== owner || (stat.mode & 0o022)))) refuse('unsafe-trust', 'invalid system policy file.');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
export function createProtectedReader(root: string, owner: number) {
  const boundary = resolve(root);
  const ancestors = (file: string) => {
    const target = resolve(file), inside = relative(boundary, target);
    if (inside === '..' || inside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(inside)) refuse('unsafe-trust', 'policy path is outside its trusted root.');
    const paths: string[] = [];
    for (let part = target;; part = dirname(part)) { paths.push(part); if (part === boundary) return paths; }
  };
  return {
    /** Metadata-only cache key: includes files and all ancestors so chmod/ACL changes invalidate it. */
    fingerprint(files: readonly string[]): string {
      return JSON.stringify([...new Set(files.flatMap(ancestors))].map(path => {
        try {
          const stat = fs.lstatSync(path, { bigint: true });
          return [path, String(stat.ctimeNs ?? stat.ctimeMs), String(stat.size), String(stat.dev), String(stat.ino), String(stat.uid), String(stat.mode)];
        } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [path, 'missing']; throw error; }
      }));
    },
    read(file: string): Buffer {
      if (process.platform === 'win32') refuse('unsupported-platform', 'Windows managed policy needs a qualified system ACL verifier.');
      for (const part of ancestors(file)) {
        const stat = fs.lstatSync(part);
        if (stat.isSymbolicLink() || stat.uid !== owner || (stat.mode & 0o022) || (part !== resolve(file) && !stat.isDirectory())) refuse('unsafe-trust', 'system policy files and their ancestors must have the trusted owner, be protected and not be symlinks.');
        if (process.platform === 'darwin') {
          const acl = childProcess.execFileSync('/bin/ls', ['-lde', part], { encoding: 'utf8', timeout: 2000 });
          if (/^\s*\d+: /m.test(acl)) refuse('unsafe-trust', 'system policy paths must not carry extended ACLs.');
        }
      }
      return openPolicyFile(file, owner);
    },
  };
}
