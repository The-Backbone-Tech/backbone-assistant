// Solution selection, its last step: before a task is reported done, check its deliverables
// (docs/specs/solution-selection.md, step 5; J-solution A9). Each named file must have been written
// by the turn itself (a DONE write receipt for that name), the exact version that write made must
// read back with the content it wrote, not be empty, and read as its kind: rows of a CSV with the same
// number of columns as its header, a markdown document with some words. A later edit by someone else
// is reported beside the check and never decides it: the turn is judged on its own output. A success
// the turn reports is not proof; no project code is run here. Whether the content is right is the
// task's own checker's, run by its scorer.
import type { EffectRecord, Turn } from '../api.ts';

/** `version` is the one judged; `editedSince` says who changed the file after it, reported only. */
export interface DeliverableCheck { name: string; ok: boolean; problem?: string; version?: number; editedSince?: string }
/** What a reader found for a write: the text of the version it made, or why that version cannot be read as written. */
export interface WrittenText { text?: string; version?: number; problem?: string; editedSince?: string }
export interface Verification { complete: boolean; checks: DeliverableCheck[]; summary: string }

/** Split one CSV line, honouring double quotes. */
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (quoted && line[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function readsAsItsKind(name: string, text: string): string | undefined {
  if (/\.csv$/i.test(name)) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
    if (lines.length < 2) return 'has no rows under its header';
    const width = cells(lines[0]).length;
    const bad = lines.findIndex((l, i) => i > 0 && cells(l).length !== width);
    if (bad > 0) return `row ${bad} has ${cells(lines[bad]).length} columns, its header ${width}`;
  }
  if (/\.(md|markdown|txt)$/i.test(name) && text.replace(/[#>*_\-\s`|]/g, '').length < 20) return 'has almost no words';
  return undefined;
}

/**
 * Check each deliverable against what the turn wrote. `read` is given the name and the turn's last DONE
 * write of it, and answers that write's text (a plain string, or a WrittenText with the version read
 * and any later edit); undefined when it cannot be found.
 */
export function verifyDeliverables(turn: Turn, names: readonly string[], read: (name: string, written: EffectRecord) => string | WrittenText | undefined): Verification {
  const checks = names.map((name): DeliverableCheck => {
    const wrote = turn.effects.findLast((e) => e.target === name && e.outcome === 'DONE');
    if (!wrote) {
      const unknown = turn.effects.some((e) => e.target === name && e.outcome === 'UNKNOWN');
      return { name, ok: false, problem: unknown ? 'its write has no known outcome (UNKNOWN)' : 'this turn did not write it' };
    }
    const found = read(name, wrote);
    const got: WrittenText = typeof found === 'string' ? { text: found } : found ?? {};
    const about = { ...(got.version !== undefined ? { version: got.version } : {}), ...(got.editedSince ? { editedSince: got.editedSince } : {}) };
    if (got.problem) return { name, ok: false, problem: got.problem, ...about };
    if (got.text === undefined) return { name, ok: false, problem: 'is not in the project now', ...about };
    if (!got.text.trim()) return { name, ok: false, problem: 'is empty', ...about };
    const problem = readsAsItsKind(name, got.text);
    return problem ? { name, ok: false, problem, ...about } : { name, ok: true, ...about };
  });
  const missing = checks.filter((c) => !c.ok);
  const complete = names.length > 0 && missing.length === 0 && turn.status === 'done';
  const edits = checks.filter((c) => c.editedSince).map((c) => `${c.name} v${c.version} was edited since by ${c.editedSince}; the turn is judged on its own version.`);
  const summary = (complete ? `Done: ${names.join(', ')} written by this turn and read back.`
    : turn.status !== 'done' ? `Not done: the turn ended ${turn.status}.${missing.length ? ` ${missing.map((c) => `${c.name} ${c.problem}`).join('; ')}.` : ''}`
    : names.length === 0 ? 'Nothing to check: no deliverable was named, so completion is not claimed.'
    : `Not done: ${missing.map((c) => `${c.name} ${c.problem}`).join('; ')}.`) + (edits.length ? ` ${edits.join(' ')}` : '');
  return { complete, checks, summary };
}
