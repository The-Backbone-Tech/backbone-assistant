import { readFile } from 'node:fs/promises';

/**
 * How each legacy database case reached the oracle. The yardstick is the existing suite: every
 * top-level case of a promise's legacy files is listed once, so nothing is dropped silently.
 */
export type Status =
  /** Rewritten through the adapter, asserting what the legacy case asserts. */
  | 'ported'
  /** Rewritten through the adapter, asserting less than the legacy case; `note` says what is left out. */
  | 'narrowed'
  /** Its promise is stated through the adversary port: an attack below every grant, observed publicly. */
  | 'adversary'
  /** Cannot be stated through any public crossing or view: a spec gap (see `gap`). */
  | 'gap'
  /** Black-boxable, but it exercises a surface outside the core six promises; the behaviour oracle takes it. */
  | 'deferred';

export interface CaseCoverage {
  readonly status: Status;
  /** Full names of the oracle cases that carry it (file-relative: `describe > it`). */
  readonly oracle?: readonly string[];
  readonly gap?: string;
  readonly note?: string;
}

export type GapKind =
  | 'private-function' // the legacy case calls a gov._* helper or another function the service may not execute
  | 'administrative' // it needs the administrator connection for a step that is not an attack (queue surgery, seeding a row)
  | 'migration-history' // it only makes sense with the legacy migration history or a renamed shim
  | 'no-surface' // the promise has no public crossing or view that could observe it
  | 'unnamed-crossing'; // the target-neutral act exists, but the legacy schema offers it only as a table write

export interface SpecGap {
  readonly id: string;
  readonly kind: GapKind;
  readonly summary: string;
  /** What the successor's contract would have to name for the case to become black-box. */
  readonly needs: string;
}

export interface Coverage {
  readonly promise: string;
  /** Legacy files under packages/db/test whose every top-level case this promise accounts for. */
  readonly legacyFiles: readonly string[];
  /** Keyed `file > describe > … > it`. */
  readonly cases: Readonly<Record<string, CaseCoverage>>;
  readonly gaps: readonly SpecGap[];
}

/**
 * The full names of every `it`/`test` in a legacy test file. The legacy files are not in this
 * repository: their case names were read from their syntax trees at the frozen head and kept in
 * legacy-cases.json, so the inventory below still accounts for every one of them.
 */
export async function legacyCases(file: string): Promise<string[]> {
  const frozen = JSON.parse(await readFile(new URL('./legacy-cases.json', import.meta.url), 'utf8')) as {
    cases: Record<string, string[]>;
  };
  const names = frozen.cases[file];
  if (!names) throw new Error(`no frozen legacy cases for ${file}`);
  return names;
}
