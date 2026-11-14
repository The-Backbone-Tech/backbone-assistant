import assert from 'node:assert/strict';
import { test } from 'node:test';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as certificates from '../src/composition/shared-certificate.ts';
const { sharedCertificate } = certificates;
import { plaintextKeys } from '../src/keys/vault.ts';

const message = /could not generate its TLS certificate.*[Ii]nstall.*openssl/;

test('certificate creation uses absolute system locations before an openssl on PATH', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'shared-openssl-path-'));
  const before = process.env.PATH;
  try {
    const marker = join(scratch, 'path-command-ran');
    const command = join(scratch, 'openssl');
    writeFileSync(command, `#!/bin/sh\n/usr/bin/touch '${marker}'\nexit 1\n`);
    chmodSync(command, 0o700);
    process.env.PATH = scratch;
    const certificate = await sharedCertificate(join(scratch, 'home'), plaintextKeys());
    assert.ok(new X509Certificate(certificate.cert).checkPrivateKey(createPrivateKey(certificate.key)));
    assert.equal(existsSync(marker), false);
  } finally {
    process.env.PATH = before;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('certificate generation works explicitly with the system /usr/bin/openssl', async () => {
  const certificate = await certificates.generateSharedCertificate(['/usr/bin/openssl']);
  const cert = new X509Certificate(certificate.cert);
  assert.ok(cert.checkPrivateKey(createPrivateKey(certificate.key)));
});

test('certificate generation tries the next binary and gives a plain message when none works', async () => {
  const certificate = await certificates.generateSharedCertificate(['/definitely-missing/backbone-openssl', '/usr/bin/openssl']);
  assert.ok(new X509Certificate(certificate.cert).checkPrivateKey(createPrivateKey(certificate.key)));
  await assert.rejects(certificates.generateSharedCertificate(['/definitely-missing/backbone-openssl']), message);
});
