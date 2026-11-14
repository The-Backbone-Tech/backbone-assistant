import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeJoinLink, parseJoinLink, RemoteClient } from '../src/remote/client.ts';
import { sharedCertificate } from '../src/composition/shared-certificate.ts';
import { serveIdentityApi } from '../src/composition/identity-http.ts';
import type { Host } from '../src/composition/host-types.ts';
import { plaintextKeys } from '../src/keys/vault.ts';

const invitation = randomBytes(32).toString('base64url'), fingerprint = 'ab'.repeat(32);
test('join links carry only an HTTPS origin, a SHA-256 pin and one invitation', () => {
  const target = { origin: 'https://127.0.0.1:8443', fingerprint, invitation };
  assert.deepEqual(parseJoinLink(makeJoinLink(target)), target);
  for (const link of ['http://127.0.0.1/#fingerprint='+fingerprint+'&invitation='+invitation,
    'https://user:pass@localhost/#fingerprint='+fingerprint+'&invitation='+invitation,
    'https://localhost/path#fingerprint='+fingerprint+'&invitation='+invitation,
    'https://localhost/?session=secret#fingerprint='+fingerprint+'&invitation='+invitation,
    'https://localhost/#fingerprint=wrong&invitation='+invitation,
    'https://localhost/#fingerprint='+fingerprint+'&invitation='+invitation+'&invitation='+invitation]) {
    assert.throws(() => parseJoinLink(link), /join link/i);
  }
});
test('pinning refuses a different certificate before sending any invitation or bearer', async () => {
  const home = mkdtempSync(join(tmpdir(), 'shared-pin-')); let accepted = 0, calls = 0;
  const tls = await sharedCertificate(home, plaintextKeys());
  const host = { acceptInvitation: async () => { accepted++; return { ok: true }; }, callAuthenticated: async () => { calls++; return []; } } as unknown as Host;
  const server = await serveIdentityApi({ host, tls, address: '127.0.0.1' });
  try {
    const wrong = new RemoteClient({ origin: server.origin, fingerprint });
    await assert.rejects(wrong.request('/identity/accept', { invitation, name: 'Colleague' }), /certificate.*match/i);
    assert.equal(accepted, 0);
    await assert.rejects(new RemoteClient({origin:server.origin,fingerprint},randomBytes(32).toString('base64url')).call('projects.list',{}),/certificate.*match/i);
    assert.equal(calls,0);
    const right = new RemoteClient({ origin: server.origin, fingerprint: tls.fingerprint });
    assert.deepEqual(await right.request('/identity/accept', { invitation, name: 'Colleague' }), { ok: true });
    assert.equal(accepted, 1);
    const again = await sharedCertificate(home, plaintextKeys());
    assert.equal(again.fingerprint, tls.fingerprint);
  } finally { await server.close(); rmSync(home, { recursive: true, force: true }); }
});
test('invitation acceptance is throttled by socket address before invoking the Host', async () => {
  let accepted = 0;
  const host = { acceptInvitation: async () => { accepted++; return { ok: false }; } } as unknown as Host;
  const server = await serveIdentityApi({ host });
  try {
    const accept = () => fetch(server.origin+'/identity/accept', { method:'POST', body:JSON.stringify({ invitation, name:'Colleague' }) });
    for (let i=0; i<8; i++) assert.equal((await accept()).status, 200);
    const response = await accept(); assert.equal(response.status, 429);
    assert.ok(Number(response.headers.get('retry-after')) > 0); assert.equal(accepted, 8);
  } finally { await server.close(); }
});
