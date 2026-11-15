// Machine diagnostics for a data home. Doctor probes only its selected engine's client.
// Codex's own login-status command reads this machine's client sign-in. Claude is version-only.
// This code adds no direct key-store access. It prints only a class of client output, never account details.
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, statSync, accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { binaries } from '@backbone-next/kernel/cluster';

export interface MachineCheck { name: string; status: 'ok' | 'warn' | 'fail'; detail: string; /** Sign-in class only; never account details or credentials. */ billing?: 'plan' | 'metered' | 'unknown' }

const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 5_000 });
const clients = new Map<string, { at: number; check: MachineCheck }>();
/** Reuse only classified output, for at most 30 seconds; executable changes invalidate immediately. */
function clientCheck(command: string, probe: () => MachineCheck): MachineCheck {
  let executable = 'absent';
  for (const folder of (process.env.PATH ?? '').split(delimiter)) {
    try {
      const path = join(folder, command); accessSync(path, constants.X_OK);
      const s = statSync(path, { bigint: true });
      if (!s.isFile()) continue;
      executable = `${path}:${s.dev}:${s.ino}:${s.mtimeNs}:${s.size}`; break;
    } catch { /* Try the next executable on PATH. */ }
  }
  const key = JSON.stringify([command, executable, process.env.PATH, process.env.HOME, process.env.CODEX_HOME, process.env.CLAUDE_CONFIG_DIR, !!process.env.OPENAI_API_KEY, !!process.env.CODEX_API_KEY]);
  const previous = clients.get(key), now = Date.now();
  if (previous && now >= previous.at && now - previous.at < 30_000) return { ...previous.check };
  const check = probe();
  if (clients.size >= 32) clients.delete(clients.keys().next().value!);
  clients.set(key, { at: Date.now(), check });
  return { ...check };
}

export function postgresCheck(native?: string): MachineCheck {
  try {
    const { initdb, postgres } = binaries(native);
    return existsSync(initdb) && existsSync(postgres)
      ? { name: 'postgres', status: 'ok', detail: postgres }
      : { name: 'postgres', status: 'fail', detail: `missing: ${[initdb, postgres].filter((p) => !existsSync(p)).join(', ')}` };
  } catch (error) {
    return { name: 'postgres', status: 'fail', detail: `no binaries for ${process.platform}-${process.arch}: ${(error as Error).message}` };
  }
}

/**
 * On macOS every PostgreSQL server takes one System V shared-memory segment of 32 per machine, and a
 * killed server keeps its own. `sweep` names the repository's pg-shm-sweep script, when present, which
 * counts the leaked ones without removing anything.
 */
export function sharedMemoryCheck(sweep?: string): MachineCheck {
  if (process.platform !== 'darwin') return { name: 'shared memory', status: 'ok', detail: `not limited the macOS way on ${process.platform}` };
  const max = Number(run('sysctl', ['-n', 'kern.sysv.shmmni']).stdout.trim()) || 32;
  const used = run('ipcs', ['-m']).stdout.split('\n').filter((l) => /^m\s/.test(l)).length;
  const count = sweep && existsSync(sweep) ? /^Leaked[^:]*:\s*(\d+)/m.exec(run(process.execPath, [sweep]).stdout)?.[1] : undefined;
  const leaked = count === undefined ? '' : `${count} leaked`;
  const left = max - used;
  return { name: 'shared memory', status: left > 2 ? 'ok' : left > 0 ? 'warn' : 'fail', detail: `${used} of ${max} segments in use${leaked ? `; ${leaked}` : ''}${left <= 2 ? ' Run: node scripts/pg-shm-sweep.mjs --apply' : ''}` };
}

function probeCodex(): MachineCheck {
  const r = run('codex', ['login', 'status']);
  return classifyCodex(r.error as NodeJS.ErrnoException | undefined, r.status, `${r.stdout}\n${r.stderr}`);
}

/** Any process error, a timeout included, is an error whatever the client printed or returned: an uncertain check never counts as signed in. */
export function classifyCodex(error: NodeJS.ErrnoException | undefined, status: number | null, said: string): MachineCheck {
  if (error?.code === 'ENOENT') return { name: 'codex', status: 'warn', detail: 'machine client sign-in (codex login status): absent' };
  if (error) return { name: 'codex', status: 'warn', detail: 'machine client sign-in (codex login status): error' };
  if (/not logged in|not signed in|logged out|signed out/i.test(said)) return { name: 'codex', status: 'warn', detail: 'machine client sign-in (codex login status): signed out' };
  if (status === 0) return { name: 'codex', status: 'ok', detail: 'machine client sign-in (codex login status): signed in', billing: /api[ -]?key/i.test(said) ? 'metered' : /ChatGPT|subscription/i.test(said) ? 'plan' : 'unknown' };
  return { name: 'codex', status: 'warn', detail: 'machine client sign-in (codex login status): error' };
}

/**
 * The same check without blocking this process while the client answers, bounded by the same timeout.
 * For displays only (Settings' engine list); admission and billing use the fresh synchronous check.
 */
export function codexCheckAsync(): Promise<MachineCheck> {
  return new Promise((resolve) => {
    // The kill is not one the client can ignore, so the wait always ends.
    execFile('codex', ['login', 'status'], { encoding: 'utf8', timeout: 5_000, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      const failure = error as (NodeJS.ErrnoException & { code?: string | number; killed?: boolean; signal?: string | null }) | null;
      // A plain non-zero exit is an answer; a missing client, a timeout or a signal is a process error.
      const code = failure && typeof failure.code === 'number' && !failure.killed && !failure.signal ? failure.code : undefined;
      resolve(classifyCodex(failure && code === undefined ? failure : undefined, !failure ? 0 : code ?? null, `${stdout}\n${stderr}`));
    });
  });
}

function probeClaude(): MachineCheck {
  const r = run('claude', ['--version']);
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return { name: 'claude', status: 'warn', detail: 'machine client version: absent; sign-in is not checked' };
  if (r.error || r.status !== 0) return { name: 'claude', status: 'warn', detail: 'machine client version: error; sign-in is not checked' };
  return { name: 'claude', status: 'ok', detail: 'machine client version: found; sign-in is not checked' };
}

// Billing is an admission constraint. Client login state can change independently of its executable
// or environment, so every Codex check uses the client's bounded status command again.
export const codexCheck = (): MachineCheck => probeCodex();
export const claudeCheck = (): MachineCheck => clientCheck('claude', probeClaude);

export function pnpmCheck(): MachineCheck {
  const r = run('pnpm', ['--version']);
  return r.status === 0 ? { name: 'pnpm', status: 'ok', detail: /^\d+\.\d+\.\d+$/.test(r.stdout.trim()) ? r.stdout.trim() : 'found' } : { name: 'pnpm', status: 'warn', detail: 'not found: needed to build from the repository, not to run' };
}
