// Structural inspection only. Schema/profile and authenticated vault verification belong to
// Core's read-only opener. This function must run before Host constructors or lock acquisition.
import {lstatSync} from 'node:fs';
import {join} from 'node:path';

export class HomeIncomplete extends Error {
  readonly code = 'INCOMPLETE_HOME';
  readonly missing: readonly string[];
  constructor(home: string, missing: readonly string[]) {
    // A shell argument, including literal apostrophes, dollars and backticks in the home name.
    const quoted = `'${home.replaceAll("'", "'\"'\"'")}'`;
    super(`This data folder's first run did not finish. Missing or unusable: ${missing.join(', ')}. Complete it with backbone projects create "My project" --home ${quoted}.`);
    this.name = 'HomeIncomplete';
    this.missing = Object.freeze([...missing]);
  }
}

/** Side-effect-free inspection of artifacts every finished first Host leaves. Never reads
 * secret bytes, creates a folder, takes a lock, opens a vault or starts PostgreSQL. Missing
 * projection directories are incomplete too: existing constructors would recreate them.
 * A test database substitutes external.json for native cluster metadata, never for identity.
 * This is a preflight, not protection against a concurrent hostile filesystem replacement. */
export function requireCompleteHome(home: string): void {
  const missing: string[] = [];
  const inspect = (relative: string, directory = false, empty = false): boolean => {
    try {
      // Reject linked parent artifacts instead of inspecting another folder through them.
      const parts = relative.split('/');
      for (let i = 1; i < parts.length; i++) {
        if (!lstatSync(join(home, ...parts.slice(0, i))).isDirectory()) return false;
      }
      const stat = lstatSync(join(home, relative));
      return directory ? stat.isDirectory() : stat.isFile() && (empty || stat.size > 0);
    } catch {
      // A failed inspection never justifies attempting initialization or printing OS paths.
      return false;
    }
  };
  for (const path of ['kernel.json', 'core.json', 'keys/vault.json']) if (!inspect(path)) missing.push(path);
  if (!inspect('pg/external.json')) {
    for (const path of ['pg/data/PG_VERSION', 'pg/cluster.json']) if (!inspect(path)) missing.push(path);
  }
  // Ownership takes the root lock. Readers never take keys/pg locks or publish an in-home
  // socket, so older installed homes need not contain those unused transport artifacts.
  if (!inspect('.lock', false, true)) missing.push('.lock');
  for (const path of ['threads', 'memory', 'memory/daily', 'memory/projects', 'memory/topics']) if (!inspect(path, true)) missing.push(path);
  if (missing.length) throw new HomeIncomplete(home, missing);
}
