import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, verify, createHash } from 'node:crypto';
import { signPolicy } from './sign-managed-policy.mjs';
test('offline signing covers exact bytes and emits only public trust information', () => {
  const dir = mkdtempSync(join(tmpdir(), 'policy-sign-'));
  try {
    const pair = generateKeyPairSync('ed25519'), file = join(dir, 'policy.json'), key = join(dir, 'private.pem');
    writeFileSync(file, JSON.stringify({ id: 'test', version: 2, requirements: {}, defaults: {} }));
    writeFileSync(key, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const trust = signPolicy(file, key);
    assert.ok(verify(null, readFileSync(file), trust.keys[0], readFileSync(`${file}.sig`)));
    assert.equal(trust.deployment.sha256, createHash('sha256').update(readFileSync(file)).digest('hex'));
    assert.ok(!JSON.stringify(trust).includes('PRIVATE KEY'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('signing refuses duplicate keys, comments and malformed UTF-8 before creating a signature', () => {
  const dir = mkdtempSync(join(tmpdir(), 'policy-strict-sign-'));
  try {
    const key = join(dir, 'private.pem'), file = join(dir, 'policy.json');
    writeFileSync(key, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    for (const bytes of ['{"id":"test","version":1,"version":2}', '{/*comment*/"id":"test","version":1}', Buffer.from([0xff])]) {
      writeFileSync(file, bytes);
      assert.throws(() => signPolicy(file, key));
      assert.throws(() => readFileSync(`${file}.sig`), { code: 'ENOENT' });
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
