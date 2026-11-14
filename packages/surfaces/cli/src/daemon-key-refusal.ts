// Diagnostic text and a bounded read of launchd's existing log. Never writes or opens keys.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { SystemKeysRefused } from '@backbone-next/platform/system-keys';
import type { KeysRefused } from '@backbone-next/platform/keys';
import { cliKeyRefusal } from './key-recovery.ts';

const KINDS = ['store-disabled', 'store-unavailable', 'platform-unsupported', 'missing-item', 'wrapped-key-invalid', 'downgrade', 'provider-mismatch', 'invalid-choice', 'legacy-home', 'missing-vault', 'app-required', 'test-database', 'vault-unreadable', 'keys-not-chosen'] as const;
export type KeyRefusalKind = typeof KINDS[number];
export interface LastKeyRefusal { kind: KeyRefusalKind; at: string }

export function keyRefusalRecovery(error: KeysRefused): { kind: KeyRefusalKind; recovery: string } {
  const reason = error instanceof SystemKeysRefused ? error.reason : undefined;
  if (error.code === 'no-keychain') {
    if (reason?.kind === 'store-disabled') return { kind: 'store-disabled', recovery: reason.source === 'switch'
      ? "Remove BACKBONE_SYSTEM_STORE_UNAVAILABLE only from the real command's environment, then start the daemon again. Keep test commands behind their refusal guard."
      : 'Run the real command outside the test process, then start the daemon again. Keep tests behind their refusal guard.' };
    if (reason?.kind === 'platform-unsupported') return { kind: 'platform-unsupported', recovery: 'Use a supported platform for system-store keys; do not change the provider of an existing data folder.' };
    return { kind: 'store-unavailable', recovery: 'Unlock or start the system key store, or log in to its desktop session, then start the daemon again.' };
  }
  if (error.code === 'held-by-app') return { kind: 'app-required', recovery: 'Open the app for this data folder; the daemon cannot open its app-kept keys.' };
  if (error.code === 'test-database') return { kind: 'test-database', recovery: 'Use a separate data folder with its own database for system-store keys; do not change the provider of this test data folder.' };
  if (reason?.kind === 'downgrade') return { kind: 'downgrade', recovery: 'Restore the original protected vault and use its original system-store item before you start the daemon again. Choosing plaintext cannot undo protection.' };
  if ((reason?.kind === 'provider-mismatch' && reason.provider === 'plaintext') || (!reason && error.code === 'plaintext-home')) return { kind: 'provider-mismatch', recovery: 'This data folder stays plaintext. Unset BACKBONE_KEYS or choose BACKBONE_KEYS=plaintext, then start the daemon again. The data key remains in plain text.' };
  if (error.code === 'no-keys') {
    if (reason?.kind === 'invalid-choice') return { kind: 'invalid-choice', recovery: 'Choose BACKBONE_KEYS=system or BACKBONE_KEYS=plaintext, or leave it unset, then start the daemon again. Plaintext keeps the data key in plain text.' };
    if (reason?.kind === 'legacy-home') return { kind: 'legacy-home', recovery: 'After the migration command above succeeds, start the daemon again with BACKBONE_KEYS=plaintext. The data key remains in plain text.' };
    if (reason?.kind === 'missing-vault') return { kind: 'missing-vault', recovery: 'Start the daemon again only on the data folder with its original keys restored, or on the separate data folder recovered from an export.' };
    return { kind: 'keys-not-chosen', recovery: 'Follow the reported key-choice requirement before you start the daemon again. No provider conversion is performed.' };
  }
  if (reason?.kind === 'missing-item') return { kind: 'missing-item', recovery: 'Recover the original store item from the original key store or its backup before you start the daemon again. Do not recreate the item or make replacement keys.' };
  if (reason?.kind === 'wrapped-key-invalid') return { kind: 'wrapped-key-invalid', recovery: 'Restore the original vault and matching store item from a trusted backup before you start the daemon again. Do not make replacement keys.' };
  if (reason?.kind === 'provider-mismatch' && reason.provider === 'system') return { kind: 'provider-mismatch', recovery: 'Unset BACKBONE_KEYS or choose BACKBONE_KEYS=system, then start the daemon again. This does not convert the data folder.' };
  return { kind: 'vault-unreadable', recovery: 'Restore a readable original vault from a trusted backup, with its matching original store item if it used one, before you start the daemon again. Do not make replacement keys.' };
}

export function keyRefusalLine(error: KeysRefused, home: string, now = new Date()): string {
  const { kind, recovery } = keyRefusalRecovery(error);
  return `daemon: stopped after key refusal (${error.code}): ${cliKeyRefusal(error, home)} ${recovery} [${kind} at ${now.toISOString()}]`.replace(/[\r\n]+/g, ' ');
}

/** Status exposes only whitelisted kinds and canonical timestamps, never arbitrary log text. */
export function lastKeyRefusal(home: string): LastKeyRefusal | undefined {
  let fd: number | undefined;
  try {
    const logs = join(home, 'logs');
    if (!lstatSync(logs).isDirectory()) return; // Do not follow a log-folder symlink.
    fd = openSync(join(logs, 'daemon.log'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return;
    const length = Math.min(stat.size, 65_536), bytes = Buffer.alloc(length);
    const count = readSync(fd, bytes, 0, length, stat.size - length);
    const pattern = /^daemon: stopped after key refusal \([a-z-]+\): [^\r\n]* \[([a-z-]+) at (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)\]$/;
    let found: LastKeyRefusal | undefined;
    for (const line of bytes.subarray(0, count).toString('utf8').split('\n')) {
      // Only LF delimits records. SDK error text can contain CR, ANSI and Unicode controls.
      if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(line)) continue;
      const match = pattern.exec(line);
      if (!match) continue;
      if (!(KINDS as readonly string[]).includes(match[1])) continue;
      const date = new Date(match[2]);
      if (!Number.isFinite(date.valueOf()) || date.toISOString() !== match[2]) continue;
      found = { kind: match[1] as KeyRefusalKind, at: match[2] };
    }
    return found;
  } catch { return; } // Missing, unreadable or rotated logs do not turn status into an error.
  finally { if (fd !== undefined) closeSync(fd); }
}
