import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

export interface TerminalProcess { group: number; members: { pid: number; start: string }[] }

/** Field 22 is the birth tick; comm may itself contain spaces and closing parentheses. */
export function parseTerminalProcStat(text: string): { pid: number; group: number; start: string; state: string } {
  const end = text.lastIndexOf(') '), fields = text.slice(end + 2).trim().split(/\s+/);
  const pid = Number(text.slice(0, text.indexOf(' ('))), group = Number(fields[2]), start = fields[19];
  if (end < 0 || !Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(group) || !/^\d+$/.test(start ?? '') || !/^[A-Za-z]$/.test(fields[0] ?? '')) throw new Error('Invalid process record');
  return { pid, group, start, state: fields[0] };
}

/** OS birth times, never just kill(pid, 0): a recycled process group must not inherit Stop authority. */
function members(group: number): TerminalProcess['members'] {
  const found: TerminalProcess['members'] = [];
  if (process.platform === 'linux') {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const p = parseTerminalProcStat(readFileSync(`/proc/${entry}/stat`, 'utf8'));
        if (p.group === group && !/[ZX]/i.test(p.state)) found.push({ pid: p.pid, start: p.start });
      } catch (error) {
        // A process can disappear between enumeration and read; other failures cannot prove absence.
        if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    }
    return found;
  }
  const text = execFileSync('/bin/ps', ['-axo', 'pid=,pgid=,lstart=,stat='], { encoding: 'utf8', timeout: 2_000, maxBuffer: 8_000_000 });
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.{24})\s+(\S+)/);
    if (!match || Number(match[2]) !== group || match[4].startsWith('Z')) continue;
    found.push({ pid: Number(match[1]), start: match[3] });
  }
  return found;
}
export function captureTerminalProcess(group: number): TerminalProcess | undefined {
  try { const found = members(group); return found.some(p => p.pid === group) ? { group, members: found } : undefined; }
  catch { return; }
}
export function inspectTerminalProcess(identity: TerminalProcess | undefined): 'same' | 'gone' | 'different' | 'unconfirmed' {
  if (!identity || !Number.isSafeInteger(identity.group) || identity.group <= 1 || !Array.isArray(identity.members)) return 'different';
  try {
    const current = members(identity.group);
    if (!current.length) return 'gone';
    if (!current.some(p => identity.members.some(prior => prior.pid === p.pid && prior.start === p.start))) return 'different';
    // A surviving confirmed member anchors descendants after their shell exits.
    identity.members = current;
    return 'same';
  } catch { return 'unconfirmed'; }
}
