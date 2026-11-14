import { homeKeyProvider, SYSTEM_WRAP } from '@backbone-next/platform/system-keys';

/** Metadata only: the provider named in the file is not proof that its store can unlock it. */
export function keyProviderCheck(home: string): { name: string; status: 'ok' | 'warn' | 'fail'; detail: string } {
  try {
    const provider = homeKeyProvider(home);
    if (!provider) return { name: 'keys', status: 'fail', detail: 'No key provider is recorded.' };
    if (provider.holder === 'plaintext') return { name: 'keys', status: 'warn', detail: 'recorded: plaintext (none); the data key is in plain text in the home.' };
    if (provider.wrap === SYSTEM_WRAP) return { name: 'keys', status: 'ok', detail: 'recorded: system key store (keychain, os-keyring-v1).' };
    if (provider.wrap === 'electron-safeStorage') return { name: 'keys', status: 'ok', detail: 'recorded: app key store (keychain, electron-safeStorage).' };
    return { name: 'keys', status: 'warn', detail: 'A different keychain provider is recorded; this command cannot open it.' };
  } catch {
    return { name: 'keys', status: 'fail', detail: 'The recorded key provider could not be read; nothing was changed.' };
  }
}
