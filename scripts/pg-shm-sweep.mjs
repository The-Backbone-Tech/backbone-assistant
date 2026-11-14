// Opt-in: finds the System V shared-memory segments that killed PostgreSQL servers left behind on
// macOS, and removes them only with --apply. macOS allows 32 segments per machine (kern.sysv.shmmni);
// every PostgreSQL server takes one, and a server killed outright never gives its one back, until
// `initdb` and `postgres` fail with "could not create shared memory segment".
//
//   node scripts/pg-shm-sweep.mjs            lists what would be removed, removes nothing
//   node scripts/pg-shm-sweep.mjs --apply    removes it (ipcrm -m <id>)
//
// A segment is swept only when ALL of these hold, and each is checked again just before its removal:
// it is owned by you; the process that created it is gone; nothing is attached to it. A segment whose
// creator is alive, or that anything is attached to, is never touched, nor is another user's.
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';

/** The segments `ipcs -m -a` lists, by its own header names (macOS and BSD). */
export function parseIpcs(text) {
  const lines = text.split('\n');
  const header = lines.findIndex((line) => /^T\s+ID\s+KEY/.test(line));
  if (header < 0) return [];
  const names = lines[header].trim().split(/\s+/);
  const at = (name) => names.indexOf(name);
  const segments = [];
  for (const line of lines.slice(header + 1)) {
    const cells = line.trim().split(/\s+/);
    if (cells[0] !== 'm' || cells.length < names.length) continue;
    segments.push({
      id: Number(cells[at('ID')]),
      key: cells[at('KEY')],
      owner: cells[at('OWNER')],
      attached: Number(cells[at('NATTCH')]),
      size: Number(cells[at('SEGSZ')]),
      creator: Number(cells[at('CPID')]),
      lastPid: Number(cells[at('LPID')]),
      attachedAt: cells[at('ATIME')],
      detachedAt: cells[at('DTIME')],
      created: cells[at('CTIME')],
    });
  }
  return segments;
}

/** Why a segment is left alone, or null when it is a leak: yours, its creator dead, nothing attached. */
export function keepReason(segment, { user, alive }) {
  if (segment.owner !== user) return `owned by ${segment.owner}`;
  if (!Number.isInteger(segment.attached) || segment.attached < 0) return 'its attachment count is unknown';
  if (segment.attached > 0) return `${segment.attached} process(es) attached`;
  if (!(segment.creator > 0)) return 'its creator is unknown';
  if (alive(segment.creator)) return `its creator ${segment.creator} is running`;
  return null;
}

const processAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists and is somebody else's. Only ESRCH says it is gone.
    return error.code !== 'ESRCH';
  }
};

const run = (command, args) => execFileSync(command, args, { encoding: 'utf8' });

/**
 * List, and with `apply` remove, the leaked segments. `deps` stands in for the machine in tests.
 * Returns { swept, kept, limit } and prints what it did or would do.
 */
export function sweep({ apply = false, log = console.log, deps = {} } = {}) {
  const user = deps.user ?? userInfo().username;
  const alive = deps.alive ?? processAlive;
  const read = deps.read ?? (() => parseIpcs(run('ipcs', ['-m', '-a'])));
  const remove = deps.remove ?? ((id) => run('ipcrm', ['-m', String(id)]));
  const limit = deps.limit ?? Number(run('sysctl', ['-n', 'kern.sysv.shmmni']).trim());

  const segments = read();
  const leaked = segments.filter((s) => keepReason(s, { user, alive }) === null);
  const kept = segments.filter((s) => !leaked.includes(s));
  log(`System V shared memory: ${segments.length} of ${limit} segments in use (kern.sysv.shmmni).`);
  log(`Kept, never touched: ${kept.length} (a live creator, something attached, or another user's).`);
  log(`Leaked (yours, creator gone, nothing attached): ${leaked.length}.`);
  if (leaked.length) {
    log('');
    log(`  ${'id'.padEnd(10)} ${'key'.padEnd(10)} ${'bytes'.padStart(6)}  ${'creator'.padEnd(8)} ${'created'.padEnd(9)} last detached`);
    for (const s of leaked) log(`  ${String(s.id).padEnd(10)} ${s.key.padEnd(10)} ${String(s.size).padStart(6)}  ${String(s.creator).padEnd(8)} ${s.created.padEnd(9)} ${s.detachedAt}`);
    log('');
  }
  if (!apply) {
    log(leaked.length ? `Dry run: nothing removed. Run with --apply to remove the ${leaked.length} listed above.` : 'Nothing to remove.');
    return { swept: [], kept, leaked, limit };
  }
  const swept = [];
  for (const s of leaked) {
    // Looked at again at the last moment: whatever attached or started since keeps its segment.
    const now = read().find((x) => x.id === s.id && x.key === s.key && x.creator === s.creator);
    const why = now ? keepReason(now, { user, alive }) : 'already gone';
    if (why !== null) {
      log(`  kept ${s.id}: ${why}`);
      continue;
    }
    remove(s.id);
    swept.push(s);
    log(`  removed ${s.id}`);
  }
  log(`Removed ${swept.length} of ${leaked.length}.`);
  return { swept, kept, leaked, limit };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.platform !== 'darwin') {
    console.log('System V segments are only a limit worth sweeping on macOS (32 per machine); nothing to do here.');
    process.exit(0);
  }
  const unknown = process.argv.slice(2).filter((a) => a !== '--apply');
  if (unknown.length) {
    console.error(`usage: node scripts/pg-shm-sweep.mjs [--apply]   (unknown: ${unknown.join(' ')})`);
    process.exit(2);
  }
  sweep({ apply: process.argv.includes('--apply') });
}
