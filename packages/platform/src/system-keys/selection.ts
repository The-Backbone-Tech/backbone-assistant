import { governedPolicy, keyDecision } from '../policy/index.ts';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { keysFromEnvironment, type HomeKeys, type KeyHolder } from '../keys/vault.ts';
import { SystemKeysRefused } from './refusal.ts';
import { systemKeys } from './provider.ts';
import { SYSTEM_WRAP, type SystemKeyStore } from './store.ts';
import { testStoreRefusal, toolStore, unavailable } from './tools.ts';

/** Read-only duplicate of the vault's small metadata read, until it exports that interface. */
export function homeKeyProvider(home: string): { holder: KeyHolder; wrap: string } | null {
  let text: string;
  try { text = readFileSync(join(home, 'keys', 'vault.json'), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new SystemKeysRefused({ kind: 'vault-unreadable' }, 'not-unwrapped', 'This home\'s key provider could not be read; nothing was changed.');
  }
  try {
    const file = JSON.parse(text);
    if (file?.format === 1) {
      if (file.holder === 'plaintext' && file.wrap === 'none') return { holder: 'plaintext', wrap: 'none' };
      if (file.holder === 'keychain' && typeof file.wrap === 'string' && file.wrap.length > 0) return { holder: 'keychain', wrap: file.wrap };
    }
  } catch {}
  throw new SystemKeysRefused({ kind: 'vault-unreadable' }, 'not-unwrapped', 'This home\'s vault names an unknown or invalid key provider; nothing was changed.');
}

const legacyKeys = (home: string) => ['keys/master.key', 'pg/secrets.json'].some((path) => existsSync(join(home, path)));
const noExistingHome = () => new SystemKeysRefused({ kind: 'keys-not-chosen' }, 'no-keys', 'This folder is not an existing data home: no vault or legacy keys were found. Only host creates a home; nothing was changed.');

/** A transport or grant command may open an existing home, but never initialize one. */
export function requireExistingKeyHome(home: string): void {
  if (!homeKeyProvider(home) && !legacyKeys(home)) throw noExistingHome();
}

function children(path: string): string[] {
  try { return readdirSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new SystemKeysRefused({ kind: 'vault-unreadable' }, 'not-unwrapped', 'This home could not be checked for existing data; nothing was changed.');
  }
}

/** Conservative root inventory: only known admission/transport leftovers can mean a fresh retry.
 * Host, Core, credentials, doors, connectors, memory, skills, tools and model writers were audited.
 * Unknown root entries count as data, so new owners do not need to extend a fragile positive list. */
function hasHomeData(home: string): boolean {
  const transient = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', 'keys', 'threads', 'cli', 'run', 'logs', '.lock']);
  if (children(home).some((name) => !transient.has(name))) return true;
  if (children(join(home, 'threads')).length) return true;
  return children(join(home, 'keys')).some((name) => !['system-id', 'system-protected', '.lock'].includes(name)
    && !/^(system-id|system-protected|vault\.json)\.\d+\.[a-f0-9]{8}\.tmp$/.test(name));
}

/** Headless callers choose by existing provider first. No choice converts an existing home. */
export async function chooseKeys(home: string, env: NodeJS.ProcessEnv = process.env, store?: SystemKeyStore, options: { create?: boolean; readOnly?: boolean } = {}): Promise<HomeKeys> {
  const policy = governedPolicy(home);
  const existing = homeKeyProvider(home);
  const preferred = !existing ? policy?.defaults.keyHolders?.[0] : undefined;
  const choice = env.BACKBONE_KEYS || (preferred === 'keychain' ? 'system' : undefined);
  const selectedEnv = choice ? { ...env, BACKBONE_KEYS: choice } : env;
  if (choice && choice !== 'plaintext' && choice !== 'system') throw new SystemKeysRefused({ kind: 'invalid-choice' }, 'no-keys', 'BACKBONE_KEYS takes plaintext or system. Plaintext writes the data key in plain text.');
  keyDecision(policy, existing?.holder ?? (choice === 'plaintext' ? 'plaintext' : 'keychain'));
  const trace = ['keys/system-id', 'keys/system-protected'].find((path) => existsSync(join(home, path)));
  if (trace && (existing?.holder === 'plaintext' || (!existing && choice === 'plaintext'))) {
    throw new SystemKeysRefused({ kind: 'downgrade' }, 'plaintext-home', `${existing ? 'A plaintext vault was found' : 'Plaintext keys were requested'} beside ${trace}, a system-store protection record; downgrade refused and nothing was changed.`);
  }
  if (!existing && legacyKeys(home)) {
    if (options.readOnly) throw new SystemKeysRefused({ kind: 'legacy-home' }, 'no-keys', 'This home has legacy plaintext keys and no vault; a read-only command cannot migrate it. Nothing was changed.');
    if (choice === 'plaintext') return keysFromEnvironment(env)!;
    throw new SystemKeysRefused({ kind: 'legacy-home' }, 'no-keys', 'This home has legacy plaintext keys and no vault. Explicit BACKBONE_KEYS=plaintext permits the existing migration and keeps the data key in plain text; no system conversion was chosen and nothing was changed.');
  }
  if (!existing && (options.create === false || options.readOnly)) throw noExistingHome();
  if (!existing && hasHomeData(home)) throw new SystemKeysRefused({ kind: 'missing-vault' }, 'no-keys', 'This home has data but no vault of its keys; nothing was changed. No new keys were made.');
  if (existing?.holder === 'keychain' && existing.wrap !== SYSTEM_WRAP) {
    if (existing.wrap === 'electron-safeStorage') throw new SystemKeysRefused({ kind: 'app-required' }, 'held-by-app', 'This home needs electron-safeStorage through the app. Its keys are held in the Keychain by the app; open the app to use it. Nothing was changed.');
    throw new SystemKeysRefused({ kind: 'app-required' }, 'held-by-app', 'This home\'s keys are held in the Keychain by the app or another provider that this command cannot open; nothing was changed.');
  }
  if (existing?.holder === 'plaintext') {
    if (choice === 'system') throw new SystemKeysRefused({ kind: 'provider-mismatch', provider: 'plaintext' }, 'plaintext-home', 'This home keeps its keys in plain text and is not converted by choosing a provider. Nothing was changed.');
    return keysFromEnvironment({ ...env, BACKBONE_KEYS: 'plaintext' })!;
  }
  if (choice === 'plaintext') {
    if (existing) throw new SystemKeysRefused({ kind: 'provider-mismatch', provider: 'system' }, 'not-unwrapped', 'This home needs os-keyring-v1 through the system key store; plaintext keys cannot open it. Nothing was changed.');
    return keysFromEnvironment(env)!;
  }
  if (!store && process.platform !== 'darwin' && process.platform !== 'linux') throw unavailable();
  if (!store) { const refusal = testStoreRefusal(env); if (refusal) throw refusal; }
  const selected = store ?? toolStore({ env });
  let usable = false;
  try { usable = await selected.available(); } catch {}
  if (!usable) throw unavailable();
  return systemKeys(home, selected, { readOnly: options.readOnly });
}
