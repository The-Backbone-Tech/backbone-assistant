// Read the maintained Arena query; never mirror its catalogue or send private task content.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface ArenaEvidence {
  status: 'current' | 'needs-revalidation' | 'unavailable';
  query: string;
  detail: string;
  /** Dated records, not task fit, authority, entitlement or an instruction to execute. */
  records?: unknown;
}
interface QueryOptions {
  cwd?: string;
  run?: (command: string, args: string[], options: { cwd: string; timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv }) => Promise<{ stdout: string }>;
}
const date = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
/** Check even a provider's claimed current response for expired nested evidence. */
function stale(value: unknown, today: string): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (['not_current', 'incomplete', 'retired', 'missing'].includes(String(record.status))) return true;
  if ('revalidateBy' in record && (!date(record.revalidateBy) || record.revalidateBy < today)) return true;
  return Object.values(record).some((v) => stale(v, today));
}
export async function arenaEvidence(query: string, options: QueryOptions = {}): Promise<ArenaEvidence> {
  const cwd = options.cwd ?? process.env.BACKBONE_ARENA;
  const unavailable = (detail: string): ArenaEvidence => ({ status: 'unavailable', query, detail });
  if (!cwd) return unavailable('Set BACKBONE_ARENA to an Arena checkout to read dated evidence with npm run ask. No catalogue was consulted.');
  if (!query.trim() || query.length > 200 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(query) || query.startsWith('-')) return unavailable('Use a public topic or exact evidence id, at most 200 plain characters.');
  try {
    const run = options.run ?? promisify(execFile);
    let stdout: string;
    try { ({ stdout } = await run('npm', ['run', '--silent', 'ask', '--', '--json', '--compare', query], { cwd, timeout: 5000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? cwd, npm_config_offline: 'true', npm_config_update_notifier: 'false' } })); }
    catch (error) {
      // Arena deliberately exits 2 for stale records; its JSON still explains the limitation.
      if (typeof (error as { stdout?: unknown }).stdout !== 'string') throw error;
      stdout = (error as { stdout: string }).stdout;
    }
    const records = JSON.parse(stdout) as { schema?: string; status?: string; picks?: { status?: string; data?: Record<string, unknown> }[]; synthesis?: { status?: string; data?: Record<string, unknown> } | null };
    if (records.schema !== 'arena-query/1') return unavailable('Arena returned an unsupported query format.');
    if (!['current', 'not_current', 'incomplete'].includes(records.status ?? '')) return unavailable('Arena returned an unsupported query status. No current decision was established.');
    const today = new Date().toISOString().slice(0, 10);
    const decisions = [...(Array.isArray(records.picks) ? records.picks : []), ...(records.synthesis ? [records.synthesis] : [])];
    // A current label without a dated decision is not current decision evidence.
    const dated = decisions.length > 0 && decisions.every(({ status, data }) => status === 'current' && data && date(data.asOf) && date(data.revalidateBy) && data.asOf <= today && data.revalidateBy >= data.asOf);
    const expired = records.status !== 'current' || !dated || stale(records, today);
    return { status: expired ? 'needs-revalidation' : 'current', query, ...(!expired ? { records } : {}), detail: expired ? 'This evidence needs revalidation before relying on its decision. Expired decision text is withheld.' : 'Dated external evidence only. Machine feasibility, authority and task fit are evaluated separately; engines retain model routing.' };
  } catch { return unavailable('Arena query could not be read. No current decision was established.'); }
}
