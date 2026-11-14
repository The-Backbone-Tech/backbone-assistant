// A connector call never reaches a place that holds credentials. An MCP server runs with the person's
// own rights, outside the engine's sandbox, so a read tool handed a key in the home's .ssh folder or a token
// cache's path would read what the sandbox denies. Every string in the arguments is looked at as a
// path: whole and in pieces, percent-decoded, `file://` and `~` resolved, links followed to the
// nearest folder that exists, compared without case. Anything nested past what a call needs fails closed.
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { CREDENTIAL_DIR_VARIABLES, CREDENTIAL_PATHS, credentialLocations } from '../ports/harness.ts';
import type { ServerLaunch } from './client.ts';

/** A path with every folder that exists replaced by its real location, so a link to a credential place is seen as one. */
export function realish(path: string): string {
  let at = resolve(path);
  const rest: string[] = [];
  for (let i = 0; i < 256; i++) {
    try { return join(realpathSync(at), ...rest.reverse()); } catch { /* not there yet */ }
    const up = dirname(at);
    if (up === at) break;
    rest.push(basename(at));
    at = up;
  }
  return resolve(path);
}
const fold = (p: string) => p.normalize('NFKC').toLowerCase();
const inside = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The listed names as path segments anywhere in a string (a relative `../.ssh/key` too), without case: macOS folders ignore it.
const SEGMENTS = CREDENTIAL_PATHS.map((p) => new RegExp(`(^|[/\\\\])${escape(fold(p)).replace(/\//g, '[/\\\\]+')}([/\\\\]|$)`));
const decoded = (s: string) => { let x = s; for (let i = 0; i < 3; i++) { try { const d = decodeURIComponent(x); if (d === x) break; x = d; } catch { break; } } return x; };

function stringsOf(v: unknown, out: string[], depth = 0): boolean {
  if (typeof v === 'string') { out.push(v); return true; }
  if (!v || typeof v !== 'object') return true;
  if (depth >= 32) return false;
  // An object's keys are text a server may read as paths; an array's indices are not.
  return Object.entries(v as Record<string, unknown>).every(([k, x]) => { if (!Array.isArray(v)) out.push(k); return stringsOf(x, out, depth + 1); });
}

/** Whether any argument of a call names, or leads to, a place that holds credentials. */
/** `base` is the folder the server resolves relative paths in; without one, a relative path-like argument fails closed. */
export function reachesCredentials(args: unknown, home: string | undefined, env: Record<string, string | undefined>, base?: string): boolean {
  const strings: string[] = [];
  if (!stringsOf(args, strings)) return true;
  const places = credentialLocations(home, env).flatMap((p) => [p, realish(p)]).map(fold);
  for (const raw of strings) {
    for (const s of new Set([raw, decoded(raw)])) {
      const pieces = [s, ...s.split(/[\s"'`=,;()<>[\]{}|]+/)].filter(Boolean);
      for (const piece of pieces) {
        const plain = piece.replace(/^file:\/\/(localhost)?/i, '');
        if (SEGMENTS.some((r) => r.test(fold(plain)))) return true;
        const relative = !plain.startsWith('/') && !plain.startsWith('~');
        if (relative && base === undefined && /[/\\]|^\.{1,2}$/.test(plain)) return true;
        const absolute = plain.startsWith('~') && home ? join(home, plain.slice(1)) : plain.startsWith('/') ? plain : base !== undefined ? resolve(base, plain) : null;
        if (absolute) {
          const target = fold(realish(absolute));
          if (places.some((p) => inside(target, p) || inside(fold(resolve(absolute)), p))) return true;
        }
      }
    }
  }
  return false;
}

/** Variables that choose the folders a server's default cache lives under: setting one moves it as surely as the cache variables. */
const HOME_VARIABLES = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'APPDATA', 'LOCALAPPDATA'];
/** Whether a configured server moves its OAuth token cache somewhere, by its variable or by its home: then the engine's sandbox cannot be shown to deny it, so it is not used. */
export const movesCredentialCache = (launch: ServerLaunch) => [...CREDENTIAL_DIR_VARIABLES, ...HOME_VARIABLES].some((n) => launch.env?.[n] !== undefined);
