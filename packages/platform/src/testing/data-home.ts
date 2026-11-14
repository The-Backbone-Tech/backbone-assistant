// Tests only: a fresh data home that needs no PostgreSQL cluster of its own. Inside a test run that
// started a shared cluster (scripts/with-test-cluster.mjs) the home gets its own database there, so
// a host, the app or the MCP door opened on it starts no server; outside one it is a plain folder
// and the host boots personal mode as in production. Every file of a suite taking a cluster each is
// what exhausts macOS's 32 shared-memory segments.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataHomePasswords, prepareDataHome } from '@backbone/core/testing';
import { writePlaintextVault } from '../keys/vault.ts';

export { dataHomePasswords, prepareDataHome };

/**
 * A new data home folder named `backbone-<label>-…` under the temporary directory, prepared as above,
 * and a test home from the start: its vault is plaintext (keys/vault.ts), which the app refuses.
 */
export function freshDataHome(label = 'home'): string {
  const home = mkdtempSync(join(tmpdir(), `backbone-${label}-`));
  prepareDataHome(home);
  writePlaintextVault(home);
  return home;
}
