import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { shell } from 'electron';
import type { Host } from '@backbone-next/platform/composition';
import type { RendererIdentitySessions } from './identity-session.ts';

/** The system browser owns the provider page. Main owns state, the PKCE client and
 * the callback; no renderer can supply a principal, verified claim or provider token. */
export function companyBrowserSignIn(host: Host, sessions: RendererIdentitySessions, redirectUri: string | undefined) {
  let server: Server | undefined;
  const pending = new Map<string,{ window: number; browser: string; invitation?: string; expires: number }>();
  let readiness: Promise<void> | undefined;
  async function listen() {
    if (!redirectUri) throw new Error('Company sign-in is not configured.');
    const redirect = new URL(redirectUri);
    if (redirect.protocol !== 'http:' || !['127.0.0.1','[::1]'].includes(redirect.hostname) || !redirect.port) throw new Error('The desktop company callback must use a configured numeric loopback address and port.');
    if (server?.listening) return;
    server = createServer((request,response) => {
      void (async () => {
        try {
          const callback = new URL(request.url ?? '/',redirect.origin);
          if (request.method !== 'GET' || callback.pathname !== redirect.pathname || callback.searchParams.getAll('state').length !== 1) throw new Error();
          const state = callback.searchParams.get('state')!, attempt = pending.get(state);
          pending.delete(state);
          if (!attempt || attempt.expires <= Date.now()) throw new Error();
          await sessions.activate(attempt.window,()=>host.completeCompanySignIn(callback,attempt.browser,attempt.invitation));
          response.writeHead(200,{'content-type':'text/plain','cache-control':'no-store'}).end('Signed in. Return to the app.');
        } catch { response.writeHead(400,{'content-type':'text/plain','cache-control':'no-store'}).end('Sign-in was not confirmed. Return to the app and inspect membership.'); }
      })();
    });
    await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(Number(redirect.port),redirect.hostname.replace(/^\[|\]$/g,''),()=>{server!.off('error',reject);resolve();});});
  }
  return {
    async begin(window: number, invitation?: string) {
      await (readiness ??= listen().catch(error=>{readiness=undefined;throw error;}));
      for(const[state,attempt]of pending)if(attempt.expires<=Date.now())pending.delete(state);
      const browser=randomBytes(32).toString('base64url'),url=await host.beginCompanySignIn(browser);
      pending.set(url.searchParams.get('state')!,{window,browser,invitation,expires:Date.now()+5*60_000});
      await shell.openExternal(url.href);
      return {ok:true,value:{started:true}};
    },
    close() { pending.clear(); server?.close(); },
  };
}
