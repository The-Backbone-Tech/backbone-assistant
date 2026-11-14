// OpenSSL supplies X.509; the existing vault seals the private key. No model or
// external service participates in certificate creation or certificate trust.
import { execFile } from 'node:child_process';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { mkdtemp, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Vault, type HomeKeys } from '../keys/vault.ts';
import { assertHomeWriteAdmission, withHomeLock } from './home-lock.ts';

type CertificatePair = { cert: string; key: string };
export interface SharedCertificate extends CertificatePair { fingerprint: string }
const opensslLocations = ['/usr/bin/openssl', '/opt/homebrew/bin/openssl', '/usr/local/bin/openssl', 'openssl'];

/** Prefer known absolute binaries; an unusable candidate does not hide a working system binary. */
export async function generateSharedCertificate(binaries: readonly string[] = opensslLocations): Promise<CertificatePair> {
  const scratch = await mkdtemp(join(tmpdir(), 'backbone-certificate-'));
  try {
    await chmod(scratch, 0o700);
    for (const binary of binaries) {
      try {
        await promisify(execFile)(binary, ['req', '-x509', '-newkey', 'rsa:3072', '-sha256', '-nodes', '-days', '3650',
          '-subj', '/CN=Shared workspace', '-keyout', join(scratch, 'key.pem'), '-out', join(scratch, 'cert.pem')], { timeout: 30_000 });
        await chmod(join(scratch, 'key.pem'), 0o600);
        const pair = { cert: await readFile(join(scratch, 'cert.pem'), 'utf8'), key: await readFile(join(scratch, 'key.pem'), 'utf8') };
        certificate(pair);
        return pair;
      } catch { /* A missing or incompatible binary leaves the next known location available. */ }
    }
    throw new Error('The service could not generate its TLS certificate. Install the openssl command and run daemon run --share again.');
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

function certificate(pair: CertificatePair): SharedCertificate {
  const cert = new X509Certificate(pair.cert);
  if (!cert.checkPrivateKey(createPrivateKey(pair.key))) throw new Error('The saved shared certificate needs repair.');
  return { ...pair, fingerprint: cert.fingerprint256.replaceAll(':', '').toLowerCase() };
}

export async function sharedCertificate(home: string, keys: HomeKeys): Promise<SharedCertificate> {
  // Open the vault and run the local certificate process before taking the data-folder lock.
  // The locked section never awaits Core/Host opening or another crossing: only the vault's
  // independent keys lock is acquired, and it cannot acquire this data-folder lock in return.
  const vault = await Vault.open(home, keys);
  const saved = vault.get('shared.tls');
  if (saved) return certificate(JSON.parse(saved.toString('utf8')));
  const generated = await generateSharedCertificate();
  return withHomeLock(home, async () => {
    // Another process may have prepared it while OpenSSL was running. Keep its established pin.
    const now = vault.get('shared.tls');
    if (now) return certificate(JSON.parse(now.toString('utf8')));
    assertHomeWriteAdmission(home, join(home, 'keys'));
    await vault.put('shared.tls', Buffer.from(JSON.stringify(generated)));
    return certificate(generated);
  });
}
