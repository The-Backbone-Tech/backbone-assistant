// OAuth protocol primitives come from the maintained MCP SDK. This boundary owns only native
// browser handoff and the exact, single-use loopback callback, never a tools/call retry.
import { exchangeAuthorization, startAuthorization } from '@modelcontextprotocol/client';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { CatalogueApp } from '../api-catalogue.ts';

export interface CatalogueOAuthEndpoints { issuer: string; authorization: string; token: string; scope: string }
export const GITHUB_OAUTH: CatalogueOAuthEndpoints = { issuer: 'https://github.com', authorization: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token', scope: 'repo read:user' };
export const SLACK_OAUTH: CatalogueOAuthEndpoints = { issuer: 'https://slack.com', authorization: 'https://slack.com/oauth/v2_user/authorize', token: 'https://slack.com/api/oauth.v2.user.access', scope: 'search:read.public search:read.private search:read.im search:read.mpim search:read.files search:read.users channels:history groups:history im:history mpim:history users:read chat:write' };

export async function catalogueOAuth(app: CatalogueApp, endpoints: CatalogueOAuthEndpoints, open: (url: string) => Promise<void>, signal: AbortSignal) {
  const state = randomBytes(32).toString('base64url');
  let settle!: (value: URL) => void, fail!: (reason: Error) => void, used = false;
  const received = new Promise<URL>((resolve, reject) => { settle = resolve; fail = reject; });
  // Register a handler before any native/browser work; early cancellation must not be unhandled.
  void received.catch(() => {});
  let redirect = '';
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', redirect);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    if (req.method !== 'GET' || req.headers.host !== new URL(redirect).host || url.pathname !== '/oauth/callback' || used || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== state) {
      res.writeHead(400).end('This sign-in callback is not valid.'); return;
    }
    used = true;
    if (url.searchParams.has('error') || url.searchParams.getAll('code').length !== 1 || !url.searchParams.get('code')) {
      res.writeHead(400).end('Sign-in was not completed. Return to the app.');
      fail(new Error('Sign-in was declined or its code was missing.')); return;
    }
    res.end('Return to the app to finish connecting.'); settle(url);
  });
  const cancelled = () => fail(new Error('Sign-in was cancelled.'));
  const timer = setTimeout(() => fail(new Error('Sign-in expired. Start a new connection.')), 180_000);
  try {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(app.redirectPort ?? 0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('The sign-in callback could not be opened.');
    redirect = `http://127.0.0.1:${address.port}/oauth/callback`;
    const metadata = { issuer: endpoints.issuer, authorization_endpoint: endpoints.authorization, token_endpoint: endpoints.token,
      response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_post'] };
    const clientInformation = { client_id: app.clientId, client_secret: app.clientSecret };
    const request = await startAuthorization(endpoints.issuer, { metadata, clientInformation, redirectUrl: redirect, scope: endpoints.scope, state });
    signal.addEventListener('abort', cancelled, { once: true });
    signal.throwIfAborted();
    await open(request.authorizationUrl.toString());
    const callback = await received;
    signal.throwIfAborted();
    // A dropped exchange has an unknown result. Never redeem its one-use code again.
    return await exchangeAuthorization(endpoints.issuer, { metadata, clientInformation, authorizationCode: callback.searchParams.get('code')!,
      iss: callback.searchParams.get('iss') ?? undefined, codeVerifier: request.codeVerifier, redirectUri: redirect,
      fetchFn: (url, init) => fetch(url, { ...init, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), headers: { ...Object.fromEntries(new Headers(init?.headers)), Accept: 'application/json' } }),
    });
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', cancelled);
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
