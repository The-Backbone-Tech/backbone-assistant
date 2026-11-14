// One live door per workspace, held at the database. A copied or restored home names the same tasks
// and custody, so nothing in a home can tell it from the live one. A session advisory lock on a
// connection of its own can: it lasts as long as that connection, through any pause of the process.
import type { SqlClient, SqlPool } from './types.ts';

export class WorkspaceHeld extends Error {}

const HEARTBEAT_MS = 1_000;
/** A killed door's lock goes with its connection, a moment after the process. */
const OPEN_WAIT_MS = 2_000;
const CHECK_MS = 5_000;

const within = <T>(call: Promise<T>, ms: number) => {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('no answer')), ms); });
  return Promise.race([call, late]).finally(() => clearTimeout(timer));
};

export interface DoorHold {
  /** Aborts once the hold is gone. Nothing of this host may act after that. */
  readonly lost: AbortSignal;
  /** Asks the database now: the check before anything lands. */
  held(): Promise<boolean>;
  release(): void;
}

export async function holdWorkspaceDoor(pool: SqlPool, workspaceId: string): Promise<DoorHold> {
  const client: SqlClient = await pool.connect();
  const dropped = new AbortController();
  const lose = () => dropped.abort();
  client.on?.('error', lose);
  client.on?.('end', lose);
  let released = false;
  const key = `backbone-v08-door:${workspaceId}`;
  const free = () => { if (released) return; released = true; clearInterval(beat); client.release(new Error('door hold released')); };
  const held = async () => {
    if (dropped.signal.aborted || released) return false;
    try {
      const { rows } = await within(client.query(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND granted
        AND pid=pg_backend_pid() AND (classid::bigint<<32 | objid::bigint)=hashtextextended($1,8)) AS value`, [key]), CHECK_MS);
      if (rows[0]?.value === true) return true;
    } catch { /* No answer is not a hold. */ }
    lose();
    return false;
  };
  let beat: NodeJS.Timeout | undefined;
  try {
    for (const deadline = Date.now() + OPEN_WAIT_MS; ;) {
      const { rows } = await within(client.query('SELECT pg_try_advisory_lock(hashtextextended($1,8)) AS value', [key]), CHECK_MS);
      if (rows[0]?.value === true) break;
      if (Date.now() >= deadline) throw new WorkspaceHeld('This workspace is in use by another host.');
      await new Promise((r) => setTimeout(r, 50));
    }
  } catch (error) { free(); throw error; }
  beat = setInterval(() => { void held().then((yes) => { if (!yes) clearInterval(beat); }); }, HEARTBEAT_MS);
  beat.unref();
  return { lost: dropped.signal, held, release: free };
}
