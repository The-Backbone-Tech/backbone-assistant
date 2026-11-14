// CLI-only recovery text. Metadata reads never choose keys or initialize a home.
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SystemKeysRefused } from '@backbone-next/platform/system-keys';
import type { KeysRefused } from '@backbone-next/platform/keys';

export function keyHomeState(home: string): 'legacy' | 'missing-vault' | undefined {
  if (existsSync(join(home, 'keys', 'vault.json'))) return;
  if (['keys/master.key', 'pg/secrets.json'].some(path => existsSync(join(home, path)))) return 'legacy';
  if (['data', 'projects.json', 'cluster.json', 'core.json', 'kernel.json', 'pg', 'credentials', 'doors', 'memory'].some(path => existsSync(join(home, path)))) return 'missing-vault';
  if (existsSync(join(home, 'threads')) && readdirSync(join(home, 'threads')).length) return 'missing-vault';
}
export function legacyHomeRecovery(home: string): string {
  return `This data folder has legacy plaintext keys and no vault; a read-only command cannot migrate them. Nothing was changed. Migrate the existing keys and keep the work with: BACKBONE_KEYS=plaintext backbone projects create "My project" --home ${JSON.stringify(resolve(home))}. This command also creates a project with the name given ("My project" here); existing projects are kept. This keeps the data key in plain text; protect the folder as you would the keys.`;
}
export function missingVaultRecovery(): string {
  return 'This data folder has data but no vault and no legacy keys. Nothing was changed. Creating a project cannot recover the original keys. Restore the original vault (and its matching key-store item if it used one) from a trusted backup, or recover work from a backup export into a different empty data folder with: backbone restore <backup-folder> --home <new-empty-home>. Keep this data folder unchanged.';
}
export function keyHomeRecovery(home: string): string | undefined {
  const state = keyHomeState(home);
  return state === 'legacy' ? legacyHomeRecovery(home) : state === 'missing-vault' ? missingVaultRecovery() : undefined;
}
export function cliKeyRefusal(error: KeysRefused, home: string): string {
  const reason = error instanceof SystemKeysRefused ? error.reason : undefined;
  if (reason?.kind === 'legacy-home') return legacyHomeRecovery(home);
  if (reason?.kind === 'missing-vault' || (reason?.kind === 'keys-not-chosen' && keyHomeState(home) === 'missing-vault')) return missingVaultRecovery();
  if (reason?.kind === 'keys-not-chosen') return `This folder is not an existing data folder: no vault or legacy keys were found. Create it with: backbone projects create "My project" --home ${JSON.stringify(resolve(home))}; nothing was changed.`;
  return error.message;
}
