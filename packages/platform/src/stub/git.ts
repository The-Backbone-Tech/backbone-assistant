// Changes scopes use Git without optional index refresh or external diff/monitor execution.
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readlinkSync, readSync, realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import type { ChangeScope, Changes, FileChange } from '../api.ts';

// diff.autoRefreshIndex is separate from Git's optional-lock switch. Required add/commit locks
// still work; these per-command settings never rewrite the person's Git configuration.
const git = (cwd: string, args: string[]) => execFileSync('git', ['-c','diff.autoRefreshIndex=false','-c','core.fsmonitor=false',...args.slice(0,1),...(args[0]==='diff'?['--no-ext-diff','--no-textconv']:[]),...args.slice(1)], { cwd, env: {...process.env,GIT_OPTIONAL_LOCKS:'0'}, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Project setup is the person's own act; the identity is passed per command, never written to global config. */
export function initRepository(cwd: string): void {
  git(cwd, ['init', '-q', '-b', 'main']);
  git(cwd, ['add', '-A']);
  git(cwd, ['-c', 'user.name=Project setup', '-c', 'user.email=setup@localhost', 'commit', '-q', '--allow-empty', '-m', 'Start project']);
}

export function parsePatch(text: string): FileChange[] {
  const out: FileChange[] = [];
  for (const chunk of text.split(/^(?=diff --git )/m).filter((c) => c.startsWith('diff --git'))) {
    const path = /^\+\+\+ b\/(.+)$/m.exec(chunk)?.[1] ?? /^--- a\/(.+)$/m.exec(chunk)?.[1] ?? /^diff --git a\/(\S+)/.exec(chunk)?.[1] ?? '?';
    let added = 0;
    let removed = 0;
    for (const line of chunk.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) added++;
      else if (line.startsWith('-') && !line.startsWith('---')) removed++;
    }
    out.push({ path, added, removed, patch: chunk });
  }
  return out;
}

/** What an untracked file shows: at most this much text. */
const SHOWN_BYTES = 1024 * 1024;

/**
 * An untracked file's text, read from the file itself and nothing it points to: opened without
 * following a final link and without waiting on a pipe, then checked as opened. A link shows its
 * target's name, as git does; a file with other names (a hard link may be another project's), a
 * large or binary file shows a line saying so; anything else is not read.
 */
function untrackedBody(cwd: string, path: string): { lines: string[]; link: boolean } | null {
  const full = join(cwd, path);
  const real = realpathSync(dirname(full));
  if (real !== realpathSync(cwd) && !real.startsWith(`${realpathSync(cwd)}${sep}`)) return null;
  if (lstatSync(full).isSymbolicLink()) return { lines: [readlinkSync(full)], link: true };
  let fd: number;
  try { fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return null; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    if (stat.nlink > 1) return { lines: ['(a file with other names elsewhere; its text is not shown here)'], link: false };
    if (stat.size > SHOWN_BYTES) return { lines: [`(a large file, ${stat.size} bytes; its text is not shown here)`], link: false };
    const bytes = Buffer.alloc(stat.size);
    const read = readSync(fd, bytes, 0, stat.size, 0);
    const shown = bytes.subarray(0, read);
    if (shown.includes(0)) return { lines: ['(a binary file; its text is not shown here)'], link: false };
    return { lines: shown.toString('utf8').replace(/\n$/, '').split('\n'), link: false };
  } finally { closeSync(fd); }
}

function untracked(cwd: string): FileChange[] {
  return git(cwd, ['ls-files', '--others', '--exclude-standard'])
    .split('\n')
    .filter(Boolean)
    .flatMap((path) => {
      const shown = untrackedBody(cwd, path);
      if (!shown) return [];
      const body = shown.lines;
      const patch = `diff --git a/${path} b/${path}\nnew file${shown.link ? ' mode 120000' : ''}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${body.length} @@\n${body.map((l) => `+${l}`).join('\n')}\n`;
      return [{ path, added: body.length, removed: 0, patch }];
    });
}

export function repositoryChanges(cwd: string, scope: Exclude<ChangeScope, 'last-turn'>, base?: string): Changes {
  const bases = git(cwd, ['branch', '--format=%(refname:short)']).split('\n').filter(Boolean);
  const chosen = base && bases.includes(base) ? base : bases.includes('main') ? 'main' : (bases[0] ?? 'HEAD');
  let files: FileChange[];
  switch (scope) {
    case 'uncommitted':
      files = [...parsePatch(git(cwd, ['diff', 'HEAD'])), ...untracked(cwd)];
      break;
    case 'unstaged':
      files = [...parsePatch(git(cwd, ['diff'])), ...untracked(cwd)];
      break;
    case 'staged':
      files = parsePatch(git(cwd, ['diff', '--cached']));
      break;
    case 'committed':
      files = parsePatch(git(cwd, ['diff', `${chosen}...HEAD`]));
      break;
    case 'branch':
      files = [...parsePatch(git(cwd, ['diff', git(cwd, ['merge-base', chosen, 'HEAD']).trim()])), ...untracked(cwd)];
      break;
  }
  return { scope, base: chosen, bases, files };
}

export function trackedFiles(cwd: string): string[] {
  return git(cwd, ['ls-files', '--cached', '--others', '--exclude-standard']).split('\n').filter(Boolean);
}
