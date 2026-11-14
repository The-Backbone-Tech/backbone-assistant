// Unit generation reads metadata only: it must not probe a store or create a home/item.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { KeysRefused } from '@backbone-next/platform/keys';
import { homeKeyProvider, SYSTEM_WRAP } from '@backbone-next/platform/system-keys';

export function daemonKeyEnvironment(home: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const choice = env.BACKBONE_KEYS || undefined;
  if (choice && choice !== 'plaintext' && choice !== 'system') throw new KeysRefused('no-keys', 'BACKBONE_KEYS takes plaintext or system.');
  const provider = homeKeyProvider(home);
  const trace = ['keys/system-id', 'keys/system-protected'].find(path => existsSync(join(home, path)));
  if (trace && (provider?.holder === 'plaintext' || (!provider && choice === 'plaintext'))) {
    throw new KeysRefused('plaintext-home', `A plaintext choice or vault was found beside ${trace}, a system-store protection record; downgrade refused and nothing was changed.`);
  }
  if (!provider && ['keys/master.key', 'pg/secrets.json'].some(path => existsSync(join(home, path))) && choice !== 'plaintext') {
    throw new KeysRefused('no-keys', 'This data folder has legacy plaintext keys and no vault. Installing its daemon requires explicit BACKBONE_KEYS=plaintext, which keeps the data key in plain text; nothing was installed.');
  }
  if (provider?.holder === 'plaintext') {
    if (choice === 'system') throw new KeysRefused('plaintext-home', 'This plaintext data folder is not converted by installing a daemon. Nothing was changed.');
    return { BACKBONE_HOME: home, BACKBONE_KEYS: 'plaintext' };
  }
  if (provider && provider.wrap !== SYSTEM_WRAP) throw new KeysRefused('held-by-app', 'This data folder needs the app to hold its keys. Open the app; nothing was changed.');
  if (choice === 'plaintext') {
    if (provider) throw new KeysRefused('not-unwrapped', 'Plaintext keys cannot open a system-store data folder. Nothing was changed.');
    return { BACKBONE_HOME: home, BACKBONE_KEYS: 'plaintext' }; // An explicit choice for a new headless home.
  }
  const selected: Record<string, string> = { BACKBONE_HOME: home, BACKBONE_KEYS: 'system' };
  if (platform === 'linux') for (const name of ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR']) if (env[name]) selected[name] = env[name];
  return selected;
}
