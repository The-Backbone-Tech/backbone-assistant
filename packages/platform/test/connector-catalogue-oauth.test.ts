import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import { test } from 'node:test';
import { catalogueOAuth } from '../src/connectors/catalogue-oauth.ts';

test('fake OAuth binds state and PKCE, rejects a foreign callback and redeems the exact code once', async () => {
  let exchanges = 0, challenge = '', redirect = '';
  const issuer = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const params = new URLSearchParams(Buffer.concat(chunks).toString());
    exchanges++;
    assert.equal(params.get('code'), 'one-use-code');
    assert.equal(params.get('redirect_uri'), redirect);
    assert.equal(createHash('sha256').update(params.get('code_verifier')!).digest('base64url'), challenge);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ access_token: 'fake-access-token', token_type: 'bearer', expires_in: 3600 }));
  });
  await new Promise<void>(resolve => issuer.listen(0, '127.0.0.1', resolve));
  const address = issuer.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const token = await catalogueOAuth({ clientId: 'fake-app', clientSecret: 'fake-app-secret' }, { issuer: origin, authorization: `${origin}/authorize`, token: `${origin}/token`, scope: 'read write' }, async target => {
      const auth = new URL(target); redirect = auth.searchParams.get('redirect_uri')!;
      challenge = auth.searchParams.get('code_challenge')!;
      assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
      const callback = new URL(redirect); callback.searchParams.set('state', 'foreign'); callback.searchParams.set('code', 'wrong');
      assert.equal((await fetch(callback)).status, 400);
      callback.searchParams.set('state', auth.searchParams.get('state')!); callback.searchParams.set('code', 'one-use-code');
      const foreignHost = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(callback, { headers: { Host: 'attacker.invalid' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
        req.on('error', reject); req.end();
      });
      assert.equal(foreignHost, 400);
      assert.equal((await fetch(callback)).status, 200);
      callback.searchParams.set('code', 'a-different-code');
      assert.equal((await fetch(callback)).status, 400);
    }, new AbortController().signal);
    assert.equal(token.access_token, 'fake-access-token'); assert.equal(exchanges, 1);
  } finally { issuer.closeAllConnections(); await new Promise<void>(resolve => issuer.close(() => resolve())); }
});

test('an OAuth error callback consumes the state without exchanging or accepting a later code', async () => {
  await assert.rejects(catalogueOAuth({ clientId: 'fake-app', clientSecret: 'fake-secret' }, { issuer: 'http://127.0.0.1:1', authorization: 'http://127.0.0.1:1/authorize', token: 'http://127.0.0.1:1/must-not-be-called', scope: 'read' }, async target => {
    const auth = new URL(target), callback = new URL(auth.searchParams.get('redirect_uri')!);
    callback.searchParams.set('state', auth.searchParams.get('state')!); callback.searchParams.set('error', 'access_denied');
    assert.equal((await fetch(callback)).status, 400);
    callback.searchParams.delete('error'); callback.searchParams.set('code', 'late-code');
    assert.equal((await fetch(callback)).status, 400);
  }, new AbortController().signal), /declined/);
});

test('cancelling fake OAuth redeems no code and closes the loopback callback', async () => {
  const controller = new AbortController(); let callback = '';
  await assert.rejects(catalogueOAuth({ clientId: 'fake-app', clientSecret: 'fake-app-secret' }, { issuer: 'http://127.0.0.1:1', authorization: 'http://127.0.0.1:1/authorize', token: 'http://127.0.0.1:1/token', scope: 'read' }, async target => {
    callback = new URL(target).searchParams.get('redirect_uri')!;
    controller.abort();
  }, controller.signal), /cancelled/);
  await assert.rejects(fetch(callback));
});
