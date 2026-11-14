import type { Target } from '../../target.ts';

/**
 * The lifecycle area's port: the command line's lifecycle on scratch Homes. A case reaches a target
 * through the command line run as its own process (`cli`), and only for what the command line has
 * no verb for, through:
 * - `provision` — give a Home an instance, as its first start does;
 * - `open` — the stopped Home's instance, reached as its service is (a core `Target`: crossings and
 *   views as the service role, the operator for creating a workspace), until `close` stops it again;
 * - `adversary` — what someone with the Home's files or the archive does below every grant.
 * Files a case looks at (an archive, a Home) are plain paths below its scratch root.
 */
export interface HomePort {
  /** A fresh scratch root for one case. Every Home and file the case names lives below it. */
  scratch(label: string): Promise<Scratch>;
  /** Remove a scratch root and everything below it. */
  discard(scratch: Scratch): Promise<void>;
  /**
   * Run the command line as its own process. `home` names the Home it acts on; `null` names none,
   * so the target resolves whatever it resolves by default, with the user's profile pointed at
   * `scratch.profile`. Every run is a test run, marked as such the way the target recognises one.
   */
  cli(scratch: Scratch, args: readonly string[], options: CliOptions): Promise<CliResult>;
  /** Give a Home that does not exist yet an instance with no workspace, as its first start does. */
  provision(home: string): Promise<void>;
  /** Start a stopped Home's instance and reach it as its service does; `close()` stops it again. */
  open(home: string): Promise<Target>;
  readonly adversary: HomeAdversary;
}

export interface Scratch {
  /** Everything a case makes lives below this directory. */
  readonly root: string;
  /** The user profile (home directory) the target sees: empty when the scratch is made. */
  readonly profile: string;
  /** A path for a Home below the root; not created. */
  home(name: string): string;
  /** A path for a file below the root; not created. */
  file(name: string): string;
}

export interface CliOptions {
  readonly home: string | null;
  /** Standard input, when the command reads one. */
  readonly input?: string;
}

export interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Attacks below every grant, by name:
 * - `home.ledger.rewrite_payload` `{ home, workspace, seq? }` — rewrite one ledger entry's payload
 *   in the stopped Home's database, its hash left as it was (default: the first entry); persists.
 * - `file.flip_byte` `{ file }` — flip one byte in the middle of a file; the digest printed for it
 *   no longer matches.
 * - `export.rewrite_row` `{ file, to }` — rewrite one exported row inside an export archive,
 *   repack it with its manifest as it was, and write it to `to`; resolves with its new sha256, as an
 *   attacker who also controls the digest would print it.
 * - `backup.rewrite_file` `{ file, to }` — the same for a recovery backup: one file's bytes changed,
 *   its manifest as it was; resolves with the new sha256.
 */
export interface HomeAdversary {
  attack<T = unknown>(name: string, args: Record<string, unknown>): Promise<T>;
}
