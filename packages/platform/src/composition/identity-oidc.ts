import * as oidc from 'openid-client';
import {reserveSignIn,signInBudget} from './identity-attempts.ts';

export interface CompanySignInOptions {
  issuer: string;
  clientId: string;
  redirectUri: string;
  clientSecret?: string;
  /** Disposable local provider fixtures only; never permits remote HTTP. */
  allowLoopbackHttp?: boolean;
}

export interface CompanyIdentity {
  issuer: string;
  subject: string;
  displayName: string;
}

interface Attempt { browser: string; verifier: string; nonce: string; expires: number }
const LIFETIME = 5 * 60_000;

function secureUrl(value: string, local: boolean): URL {
  const url = new URL(value);
  const loopback = ['127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash || url.search || (url.protocol !== 'https:' && !(local && loopback && url.protocol === 'http:'))) {
    throw new Error('Company identity requires an HTTPS URL without credentials, query or fragment.');
  }
  return url;
}

/** Protocol proof only. The Host must resolve (issuer, subject) to a live Core membership
 * on every request. Email, display names and provider roles never confer authority. */
export class CompanySignIn {
  private readonly config: oidc.Configuration;
  private readonly redirect: URL;
  private readonly attempts = new Map<string, Attempt>();
  private readonly budget=signInBudget();

  private constructor(config: oidc.Configuration, redirect: URL) {
    this.config = config;
    this.redirect = redirect;
  }

  static async connect(options: CompanySignInOptions): Promise<CompanySignIn> {
    const issuer = secureUrl(options.issuer, !!options.allowLoopbackHttp);
    // A native app may receive the authorization code on numeric loopback HTTP.
    // Its issuer, token and JWKS endpoints still require HTTPS outside a fixture.
    const redirect = secureUrl(options.redirectUri, true);
    const insecure = issuer.protocol === 'http:';
    const config = await oidc.discovery(issuer, options.clientId,
      options.clientSecret ? { client_secret: options.clientSecret } : undefined,
      options.clientSecret ? oidc.ClientSecretPost(options.clientSecret) : oidc.None(),
      { timeout: 5, execute: insecure ? [oidc.allowInsecureRequests] : undefined });
    // A code exchange alone does not request JWT signature verification in this library.
    oidc.enableNonRepudiationChecks(config);
    // Keep the fixture exception local even if discovery supplies hostile endpoints.
    for (const endpoint of [config.serverMetadata().authorization_endpoint, config.serverMetadata().token_endpoint, config.serverMetadata().jwks_uri]) {
      if (typeof endpoint !== 'string') throw new Error('Company identity metadata is incomplete.');
      secureUrl(endpoint, insecure);
    }
    return new CompanySignIn(config, redirect);
  }

  async begin(browser: string): Promise<URL> {
    if (!browser) throw new Error('Company sign-in requires an initiating browser session.');
    this.budget.admit(browser);
    const state = oidc.randomState(), verifier = oidc.randomPKCECodeVerifier(), nonce = oidc.randomNonce();
    reserveSignIn(this.attempts,state, { browser, verifier, nonce, expires: Date.now() + LIFETIME });
    const challenge = await oidc.calculatePKCECodeChallenge(verifier);
    return oidc.buildAuthorizationUrl(this.config, {
      redirect_uri: this.redirect.href, response_type: 'code', scope: 'openid profile',
      state, nonce, code_challenge: challenge, code_challenge_method: 'S256',
    });
  }

  async complete(callback: URL, browser: string): Promise<CompanyIdentity> {
    const states = callback.searchParams.getAll('state');
    const state = states.length === 1 ? states[0] : '';
    const attempt = this.attempts.get(state);
    // Consume before any await: duplicate callbacks cannot exchange the same code twice.
    this.attempts.delete(state);
    if (!attempt || attempt.browser !== browser || attempt.expires <= Date.now()
      || callback.origin !== this.redirect.origin || callback.pathname !== this.redirect.pathname
      || callback.hash || callback.username || callback.password) {
      throw new Error('Company sign-in is expired or does not match this browser. Start again.');
    }
    try {
      const tokens = await oidc.authorizationCodeGrant(this.config, callback, {
        expectedState: state, expectedNonce: attempt.nonce, pkceCodeVerifier: attempt.verifier, idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims || typeof claims.sub !== 'string' || !claims.sub) throw new Error('Missing subject.');
      return { issuer: claims.iss, subject: claims.sub, displayName: typeof claims.name === 'string' ? claims.name : claims.sub };
    } catch {
      // Provider responses can contain credentials and personal details. Retain neither.
      throw new Error('Company sign-in could not be verified. Start again.');
    }
  }
}
