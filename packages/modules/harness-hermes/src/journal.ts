// The per-attempt journal: evidence, not truth (docs/contracts/harness.md). The core's gateway owns
// effects. This records only what a restart must know to say "this was unsettled" and to refuse a
// replay: the run's id and each write's intent and settlement. Names and tool names, never bodies.
// Its file is also the turn's claim: taken once, before submission, and never taken again.
import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type JournalEntry =
  | { kind: 'admitting' }
  | { kind: 'run'; runId: string }
  | { kind: 'intent'; id: string; tool: string; name: string }
  | { kind: 'settled'; id: string; outcome: 'done' | 'refused' | 'unknown' }
  | { kind: 'late'; id: string; outcome: 'DONE' | 'REFUSED' }
  | { kind: 'ended'; status: string };

export interface JournalView {
  runId?: string;
  ended?: string;
  /** Writes with an intent and no known end: unsettled, or settled as UNKNOWN. */
  open: { id: string; tool: string; name: string }[];
  /** Names of writes with a DONE receipt. Whether the model learned of them is not recorded. */
  done: string[];
  /** Writes held UNKNOWN whose host answered too late to count, with that answer. Evidence, never an outcome. */
  late: string[];
}

const fileFor = (dir: string, threadId: string, turnId: string) => join(dir, `${createHash('sha256').update(`${threadId}\0${turnId}`).digest('hex').slice(0, 32)}.jsonl`);

export class Journal {
  private fd: number;
  private clean: (line: string) => string;

  constructor(dir: string, threadId: string, turnId: string, clean: (line: string) => string = (l) => l, flags = 'a') {
    this.clean = clean;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.fd = openSync(fileFor(dir, threadId, turnId), flags, 0o600);
  }

  /** Durably claims a turn for one submission, or returns null when it was ever claimed. Exclusive across processes. */
  static claim(dir: string, threadId: string, turnId: string, clean: (line: string) => string) {
    let journal: Journal;
    try {
      journal = new Journal(dir, threadId, turnId, clean, 'ax');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
      throw err;
    }
    journal.record({ kind: 'admitting' });
    // The claim's name, and the name of a folder made for it, must survive a power loss too.
    for (const path of [dir, dirname(dir)]) {
      const folder = openSync(path, 'r');
      fsyncSync(folder);
      closeSync(folder);
    }
    return journal;
  }

  /**
   * Durable before it returns: an intent must reach the disk before the write is proposed. Only the
   * file name is content and may be withheld. Kinds, ids and outcomes are what recovery reads, so they
   * are never rewritten; an entry whose id carries a key is refused instead, and its caller fails closed.
   */
  record(entry: JournalEntry) {
    // On decoded values: escaping would hide a key with a quote in it from a search of the JSON.
    const line = JSON.stringify(entry, (key, value: unknown) => {
      if (typeof value !== 'string' || (key !== 'name' && key !== 'id' && key !== 'runId')) return value;
      const clean = this.clean(value);
      if (key !== 'name' && clean !== value) throw new Error('This entry names a key, so it was not recorded.');
      return clean;
    });
    writeSync(this.fd, `${line}\n`);
    fsyncSync(this.fd);
  }

  close() {
    closeSync(this.fd);
  }
}

/** The attempt as a restart sees it, or null when there is no record of one. A torn last line was never committed. */
export function readJournal(dir: string, threadId: string, turnId: string): JournalView | null {
  let text: string;
  try {
    text = readFileSync(fileFor(dir, threadId, turnId), 'utf8');
  } catch {
    return null;
  }
  const view: JournalView = { open: [], done: [], late: [] };
  for (const line of text.split('\n')) {
    let entry: JournalEntry;
    try {
      entry = JSON.parse(line) as JournalEntry;
    } catch {
      continue;
    }
    if (entry.kind === 'run') view.runId = entry.runId;
    else if (entry.kind === 'intent') view.open.push({ id: entry.id, tool: entry.tool, name: entry.name });
    else if (entry.kind === 'settled' && entry.outcome !== 'unknown') {
      const settled = entry;
      if (settled.outcome === 'done') view.done.push(...view.open.filter((o) => o.id === settled.id).map((o) => o.name));
      view.open = view.open.filter((o) => o.id !== settled.id);
    }
    else if (entry.kind === 'late') {
      const late = entry;
      view.late.push(...view.open.filter((o) => o.id === late.id).map((o) => `${o.name} (${late.outcome})`));
    } else if (entry.kind === 'ended') view.ended = entry.status;
  }
  return view;
}
