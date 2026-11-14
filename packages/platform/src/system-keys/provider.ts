import { createCipheriv, createDecipheriv, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeDurable } from '@backbone-next/kernel/files';
import { assertHomeWriteAdmission, withHomeLock } from '../composition/home-lock.ts';
import type { HomeKeys } from '../keys/vault.ts';
import { ACCOUNT, SYSTEM_WRAP, type SystemKeyStore } from './store.ts';
import { SystemKeysRefused } from './refusal.ts';
import { storeFailure, toolStore, unavailable } from './tools.ts';

export { SYSTEM_WRAP, type SystemKeyStore } from './store.ts';
export { toolStore } from './tools.ts';

const identityPath = (home: string) => join(home, 'keys', 'system-id');
function identity(home: string): string {
  try {
    const id = readFileSync(identityPath(home), 'utf8').trim();
    if (ACCOUNT.test(id)) return id;
  } catch {}
  throw new SystemKeysRefused({ kind: 'vault-unreadable' }, 'not-unwrapped', 'This home\'s system key store identity is missing or invalid; nothing was changed.');
}
const invalid = () => new SystemKeysRefused({ kind: 'wrapped-key-invalid' }, 'not-unwrapped', 'The system key store could not authenticate this home\'s wrapped key; nothing was changed.');
async function readKey(store: SystemKeyStore, account: string): Promise<Buffer | null> {
  let key: Buffer | null;
  try { key = await store.get(account); }
  catch (error) { throw storeFailure(error); }
  if (key && key.length !== 32) throw invalid();
  return key;
}

/** An optional second pin: failure to publish it must not change an authenticated open. */
async function publishProtection(home: string, wrapped: Buffer): Promise<void> {
  const marker = join(home, 'keys', 'system-protected');
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    if (existsSync(marker)) return;
    assertHomeWriteAdmission(home, join(home, 'keys'));
    const admission = new AbortController();
    deadline = setTimeout(() => admission.abort(), 100);
    // No cross-process retries; the admission deadline also bounds an in-process queue.
    await withHomeLock(join(home, 'keys'), async (lost) => {
      if (existsSync(marker)) return;
      const file = JSON.parse(readFileSync(join(home, 'keys', 'vault.json'), 'utf8'));
      if (file.format !== 1 || file.holder !== 'keychain' || file.wrap !== SYSTEM_WRAP
        || typeof file.key !== 'string' || !Buffer.from(file.key, 'base64').equals(wrapped)) return;
      lost.throwIfAborted();
      assertHomeWriteAdmission(home, join(home, 'keys'));
      writeDurable(marker, `${SYSTEM_WRAP}\n`);
    }, 0, admission.signal);
  } catch {
    // Read-only snapshots, busy writers and metadata errors leave this for a later open.
    // system-id remains the creation pin; the envelope independently names its store account.
  } finally { clearTimeout(deadline); }
}

/** Existing HomeKeys shape. wrapKey is called by Vault.open while holding the vault's lock. */
export function systemKeys(home: string, store: SystemKeyStore = toolStore(), options: { readOnly?: boolean } = {}): HomeKeys {
  return {
    holder: 'keychain', wrap: SYSTEM_WRAP,
    wrapKey: async (dataKey) => {
      if (options.readOnly) throw new SystemKeysRefused({ kind: 'keys-not-chosen' }, 'no-keys', 'Read-only key selection cannot create a vault; nothing was changed.');
      assertHomeWriteAdmission(home, join(home, 'keys'));
      return withHomeLock(join(home, 'keys'), async (lost) => {
      lost.throwIfAborted();
      assertHomeWriteAdmission(home, join(home, 'keys'));
      // Make the durable nonsecret identity before storing a key. A retry uses that same item.
      if (!existsSync(identityPath(home))) writeDurable(identityPath(home), `${randomUUID()}\n`);
      const account = identity(home);
      let wrapping = await readKey(store, account);
      if (!wrapping) {
        lost.throwIfAborted();
        assertHomeWriteAdmission(home, join(home, 'keys'));
        wrapping = randomBytes(32);
        try { await store.create(account, wrapping); } catch (error) { wrapping.fill(0); throw storeFailure(error); }
        const verified = await readKey(store, account);
        if (!verified || !timingSafeEqual(wrapping, verified)) { wrapping.fill(0); throw unavailable(); }
        verified.fill(0);
      }
      try {
        lost.throwIfAborted();
        const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', wrapping, iv);
        cipher.setAAD(Buffer.from(account));
        const data = Buffer.concat([cipher.update(dataKey), cipher.final()]);
        return Buffer.from(JSON.stringify({ account, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }));
      } finally { wrapping.fill(0); }
      });
    },
    async unwrapKey(wrapped, reading) {
      let envelope: { account: string; iv: string; tag: string; data: string };
      try {
        if (wrapped.length > 2048) throw invalid();
        const parsed: unknown = JSON.parse(wrapped.toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid();
        const { account, iv, tag, data } = parsed as Record<string, unknown>;
        if (typeof account !== 'string' || !ACCOUNT.test(account)
          || typeof iv !== 'string' || !/^[A-Za-z0-9+/]{16}$/.test(iv)
          || typeof tag !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(tag)
          || typeof data !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(data)) throw invalid();
        envelope = { account, iv, tag, data };
      } catch { throw invalid(); }
      const account = envelope.account; // GCM authenticates this account as additional data.
      const wrapping = await readKey(store, account);
      if (!wrapping) throw new SystemKeysRefused({ kind: 'missing-item' }, 'not-unwrapped', 'This home\'s keys are gone from the system key store; nothing was changed.');
      let key: Buffer;
      try {
        const decipher = createDecipheriv('aes-256-gcm', wrapping, Buffer.from(envelope.iv, 'base64'));
        decipher.setAAD(Buffer.from(account)); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        key = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
      } catch { throw invalid(); }
      finally { wrapping.fill(0); }
      // Authentication succeeded. Marker errors cannot turn it into a refusal.
      if (!options.readOnly && !reading?.readOnly) await publishProtection(home, wrapped);
      return { key, rewrap: false };
    },
  };
}
