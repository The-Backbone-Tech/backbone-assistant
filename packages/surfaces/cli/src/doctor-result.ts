import { EXIT, type Io, type Parsed } from './commands.ts';
export interface DoctorCheck { name: string; status: 'ok' | 'warn' | 'fail'; detail: string }
export function doctorResult(parsed: Pick<Parsed, 'json'>, checks: DoctorCheck[], io: Pick<Io, 'out'>): number {
  const ok = checks.every(check => check.status !== 'fail');
  io.out(parsed.json ? JSON.stringify({ ok, checks }, null, 2) : checks.map(check => `${check.status.padEnd(4)} ${check.name === 'standing signatures' ? 'tool permissions' : check.name}: ${check.detail}`).join('\n'));
  return ok ? EXIT.OK : EXIT.REFUSED;
}
