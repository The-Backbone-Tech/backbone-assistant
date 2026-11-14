// The door's line to the process that holds a data home's keys (the app's host, or `backbone-mcp
// host`): newline-delimited JSON over a Unix socket that only the person's user can open (no door
// runs on Windows yet: `unsupported`). The door says which grant it is (`{ door: 1, grant }`), is told `{ ready: true }` or
// `{ refused }`, then sends `{ id, method, args }` and reads `{ id, result }`. Only the gateway's four
// methods exist on it: no grant, revoke or any other control. Types and constants only, so the door
// imports nothing that opens a database.
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { GatewayMethod, GatewayRefusal } from '../gateway.ts';

export const DOOR_PROTOCOL = 1;
/** The longest line either side accepts; a longer one ends the connection. */
export const MAX_LINE = 1 << 20;
/** What the socket carries, and nothing else. */
export const DOOR_METHODS: readonly GatewayMethod[] = ['effects.propose', 'effects.get', 'effects.list', 'knowledge.recall'];
export const GRANT_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;

/** The longest path a Unix socket can take, its final NUL aside: 104 bytes on macOS, 108 on Linux. */
const SOCKET_PATH_MAX = process.platform === 'darwin' ? 103 : 107;

/**
 * A data home's one identity, whatever spelling or link reached it: the real path of its nearest
 * folder that exists, and the rest as given. Every socket and lock is chosen from this, so two
 * spellings of one home never make two owners.
 */
export function canonicalHome(home: string): string {
  const rest: string[] = [];
  for (let at = resolve(home); ; at = dirname(at)) {
    try { return join(realpathSync.native(at), ...rest.reverse()); } catch { /* not there yet: one folder up */ }
    if (dirname(at) === at) return resolve(home);
    rest.push(basename(at));
  }
}

/**
 * Where a data home's doors are served: `<home>/run/door.sock`, in a folder only the person's user
 * may enter. A home whose path is too long for a socket uses `/tmp/backbone-doors-<uid>/<id>.sock`,
 * as tmux does: fixed, so the app and a door started with another environment (no TMPDIR, another
 * HOME) find the same one, and checked to be this user's own folder (`ownFolder`).
 */
export function doorSocket(home: string): string {
  const refused = unsupported();
  if (refused) throw new Error(refused.detail);
  const at = canonicalHome(home);
  const id = createHash('sha256').update(at).digest('hex').slice(0, 16);
  const inHome = join(at, 'run', 'door.sock');
  if (Buffer.byteLength(inHome) <= SOCKET_PATH_MAX) return inHome;
  return join('/tmp', `backbone-doors-${process.getuid?.() ?? 0}`, `${id}.sock`);
}

/**
 * Whether the socket's folder is this user's alone: a real folder (not a link), owned by this user,
 * which no one else may enter. Neither side uses a socket in any other: another user could have
 * made it to stand in for the app.
 */
export function ownFolder(socket: string): boolean {
  if (unsupported()) return false;
  try {
    const stat = lstatSync(dirname(socket));
    return stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

export interface Hello {
  door: typeof DOOR_PROTOCOL;
  grant: string;
}
export type HelloReply = { ready: true } | { refused: GatewayRefusal };
export interface CallLine {
  id: number;
  method: GatewayMethod;
  args: unknown;
}
export interface ResultLine {
  id: number;
  result: unknown;
}

const refusal = (reason: GatewayRefusal['reason'], detail: string): GatewayRefusal => ({ ok: false, outcome: 'REFUSED', reason, detail });

/** Nothing serves the home's doors: the call never left the door. */
export const NOT_RUNNING = refusal(
  'NOT_AVAILABLE',
  'The app that keeps this data home is not running, so nothing was sent. Open it, then call again; the door connects by itself.',
);
/**
 * Windows has no door yet: a named pipe's name can be made first by another user, who would then
 * stand in for the app and hand out receipts. It needs a name of this user's own, an access list for
 * the current user only and a check of the server before a door runs there.
 */
const WINDOWS = refusal(
  'NOT_AVAILABLE',
  'The door is not supported on Windows yet: it needs a pipe of this user\'s own, open to this user alone, and a check that the app is at its other end. Nothing was sent.',
);
/** Why no door runs on this platform, or null where one does. */
export const unsupported = (): GatewayRefusal | null => (process.platform === 'win32' ? WINDOWS : null);
export const BAD_METHOD = refusal('INVALID', 'The door carries only propose, status, list and recall.');
export const BAD_GRANT = refusal('INVALID', 'A grant name is lowercase letters, digits and dashes.');
/** The host went away with a call in flight: what became of it is not known, so it is not a refusal. */
export const LOST_MID_CALL =
  'The app stopped while this call was in flight, so whether it happened is not known. Once it runs again, read effect_status with the same idempotency key; never propose it again under a new key.';
