import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { CompanySignIn } from '../src/composition/identity-oidc.ts';

test('company sign-in verifies issuer, audience, signature, expiry, nonce, PKCE state and initiating browser', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let issuer = '', nonce = '', mode = '', requests = 0;
  const callback = 'https://app.example.invalid/identity/callback';
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/.well-known/openid-configuration') return res.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'] }));
    if (req.url === '/jwks') return res.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test', use: 'sig', alg: 'RS256' }] }));
    if (req.url !== '/token') { res.statusCode = 404; return res.end('{}'); }
    requests++;
    const parts = [];
    for await (const chunk of req) parts.push(chunk);
    const body = new URLSearchParams(Buffer.concat(parts).toString());
    assert.equal(body.get('redirect_uri'), callback);
    assert.ok(body.get('code_verifier'));
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const jwt = `${encode({ alg: 'RS256', kid: 'test' })}.${encode({ iss: mode === 'issuer' ? 'https://wrong.invalid' : issuer, aud: mode === 'audience' ? 'wrong' : 'test-app', sub: 'stable-subject', nonce: mode === 'nonce' ? 'wrong' : nonce, exp: Math.floor(Date.now() / 1000) + (mode === 'expiry' ? -3600 : 300), iat: Math.floor(Date.now() / 1000), email: 'untrusted@example.invalid', name: 'Test person' })}`;
    const signature = sign('RSA-SHA256', Buffer.from(jwt), privateKey).toString('base64url');
    res.end(JSON.stringify({ access_token: 'fake-access', token_type: 'Bearer', id_token: `${jwt}.${mode === 'signature' ? 'bad' : signature}` }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const options = { issuer, clientId: 'test-app', redirectUri: callback, allowLoopbackHttp: true };
    const client = await CompanySignIn.connect(options);
    const begin = async () => {
      const url = await client.begin('browser-session');
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      nonce = url.searchParams.get('nonce')!;
      return new URL(`${callback}?code=fake-code&state=${url.searchParams.get('state')}`);
    };
    const first = await begin();
    assert.deepEqual(await client.complete(first, 'browser-session'), { issuer, subject: 'stable-subject', displayName: 'Test person' });
    await assert.rejects(client.complete(first, 'browser-session'));
    for (const failure of ['issuer', 'audience', 'nonce', 'expiry', 'signature']) {
      mode = failure;
      await assert.rejects(client.complete(await begin(), 'browser-session'), failure);
    }
    mode = '';
    const crossedBrowser = await begin(), before = requests;
    await assert.rejects(client.complete(crossedBrowser, 'other-browser'));
    assert.equal(requests, before, 'a mismatched browser never exchanges a code');
    const wrongPath = await begin(); wrongPath.pathname = '/other';
    await assert.rejects(client.complete(wrongPath, 'browser-session'));
    await assert.rejects(CompanySignIn.connect({ ...options, allowLoopbackHttp: false }));
    await assert.rejects(CompanySignIn.connect({ ...options, issuer: 'http://company.example.invalid' }));
    const pending = await Promise.all(Array.from({ length: 128 }, (_,index) => client.begin(`pending-browser-${index}`)));
    await client.begin('fresh-browser');
    const evicted=new URL(`${callback}?code=old&state=${pending[0].searchParams.get('state')}`);
    const beforeEviction=requests;await assert.rejects(client.complete(evicted,'pending-browser-0'));assert.equal(requests,beforeEviction);
    for(let index=0;index<8;index++)await client.begin('burst-browser');
    await assert.rejects(client.begin('burst-browser'),'one browser cannot exhaust the shared pool');
    await client.begin('other-browser');
    const now = Date.now;
    try {
      const advanced = now() + 6 * 60_000;
      Date.now = () => advanced;
      const expired = new URL(`${callback}?code=old&state=${pending[127].searchParams.get('state')}`);
      const beforeExpiry = requests;
      await assert.rejects(client.complete(expired, 'pending-browser-127'));
      assert.equal(requests, beforeExpiry, 'expired attempts do not exchange codes');
      await client.begin('browser-session');
    } finally { Date.now = now; }
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
