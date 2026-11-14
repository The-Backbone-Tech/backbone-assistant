// Tests only: a stand-in for the Keychain, what a home's vault holds, and a search of every file in a
// home for secrets, as a process of the same user would read them.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ClusterPasswords } from '@backbone/core/db';
import { type HomeKeys, Vault } from '../keys/vault.ts';

/**
 * Keys held as the Keychain holds them for the app: the wrapping key lives in this process's memory
 * only, never in a file, so nothing on disk unwraps the home's data key.
 */
export function memoryKeychain(): HomeKeys {
  const kek = randomBytes(32);
  return {
    holder: 'keychain',
    wrap: 'test-keychain',
    async wrapKey(key) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', kek, iv);
      const data = Buffer.concat([cipher.update(key), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    async unwrapKey(wrapped) {
      const decipher = createDecipheriv('aes-256-gcm', kek, wrapped.subarray(0, 12));
      decipher.setAuthTag(wrapped.subarray(12, 28));
      return { key: Buffer.concat([decipher.update(wrapped.subarray(28)), decipher.final()]), rewrap: false };
    },
  };
}

/** What a home's vault holds: the cluster's passwords and the master key that seals model credentials. */
export async function homeSecrets(home: string, keys?: HomeKeys): Promise<{ passwords: ClusterPasswords; master: Buffer }> {
  const vault = await Vault.open(home, keys);
  const pg = vault.get('pg');
  if (!pg) throw new Error(`${home}'s vault holds no cluster passwords.`);
  return { passwords: JSON.parse(pg.toString('utf8')) as ClusterPasswords, master: await vault.masterKey() };
}

/**
 * Every regular file under `home` (the cluster's own files included) that holds one of `secrets`:
 * a string as its bytes, a buffer as its bytes, its hex and its base64. Empty when none does.
 */
export function findInHome(home: string, secrets: (string | Buffer)[]): string[] {
  const needles = secrets.map((s, i) => ({ i, forms: typeof s === 'string' ? [Buffer.from(s)] : [s, Buffer.from(s.toString('hex')), Buffer.from(s.toString('base64'))] }));
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) {
        const bytes = readFileSync(path);
        for (const n of needles) if (n.forms.some((f) => bytes.includes(f))) found.push(`${relative(home, path)}: secret #${n.i}`);
      }
    }
  };
  walk(home);
  return found;
}
