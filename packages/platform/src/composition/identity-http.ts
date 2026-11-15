// Authenticated team API: loopback HTTP for local composition tests, or an explicit
// TLS listener for the shared daemon. No network request inherits device authority;
// recovery and device-only controls have no endpoint. Remote clients pin the certificate.
// Shared TLS exposes POST /identity/accept (single-use invitation), /identity/sign-out
// and /api plus GET /api/events (session bearer), and /scim/v2/* (configured directory
// bearer only). Company sign-in /identity/company/{begin,complete} is loopback-only:
// it uses OIDC state/nonce/PKCE and a single-use browser attempt, not a session bearer.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createTlsServer, type ServerOptions } from 'node:https';
import { isIP } from 'node:net';
import { randomBytes } from 'node:crypto';
import { CoreRefusal, definiteServerRefusal } from './core.ts';
import { METHODS, type Method, type ApiEvent } from '../api.ts';
import type { Host } from './host-types.ts';
import { reserveSignIn,signInBudget,SignInRateLimited } from './identity-attempts.ts';
import { IdentityRefused,IdentityUnavailable, SharedEngineRequired, PersonalConversationRequired } from './identity-core.ts';

async function bodyOf(request: IncomingMessage): Promise<string> {
  let size=0;const chunks:Buffer[]=[];
  for await(const chunk of request){size+=chunk.length;if(size>65_536)throw new Error('Request too large');chunks.push(Buffer.from(chunk));}
  return Buffer.concat(chunks).toString('utf8');
}
const json=(response:ServerResponse,value:unknown,status=200)=>response.writeHead(status,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify(value));
const tokenOf=(request:IncomingMessage)=>/^Bearer ([A-Za-z0-9_-]{30,256})$/.exec(request.headers.authorization??'')?.[1];

export async function serveIdentityApi(options:{host:Host;port?:number;address?:string;tls?:ServerOptions;clientAddress?:(request:IncomingMessage)=>string;connectionLimitPerAddress?:number}):Promise<{origin:string;close():Promise<void>}> {
  const {host}=options, address=options.address??'127.0.0.1';
  if(!isIP(address))throw new Error('Choose a numeric listening address, such as 192.168.1.10:8443.');
  if(!options.tls&&!['127.0.0.1','::1'].includes(address))throw new Error('A shared listener requires TLS.');
  const streams=new Set<ServerResponse>(),sessionStreams=new Map<string,number>(),budget=signInBudget(),acceptBudget=signInBudget();
  const attempts=new Map<string,{browser:string;invitation?:string;expires:number}>();
  let origin='';
  const handle=(request:IncomingMessage,response:ServerResponse)=>{
    void(async()=>{
      try{
        const url=new URL(request.url??'/',origin);
        if(url.pathname.startsWith('/scim/v2/')){
          const headers=new Headers();for(const[key,value]of Object.entries(request.headers))if(value&&!['connection','transfer-encoding','content-length'].includes(key))headers.set(key,Array.isArray(value)?value.join(','):value);
          const body=['GET','HEAD'].includes(request.method??'GET')?undefined:await bodyOf(request);
          const result=await host.directoryRequest(new Request(url,{method:request.method,headers,body}));
          response.writeHead(result.status,Object.fromEntries(result.headers));response.end(await result.text());return;
        }
        if(request.method==='POST'&&url.pathname==='/identity/accept'){
          acceptBudget.admit(options.clientAddress?.(request)??request.socket.remoteAddress??'unknown');
          const body=JSON.parse(await bodyOf(request));
          if(typeof body.invitation!=='string'||body.invitation.length>256||typeof body.name!=='string'||!body.name.trim()||body.name.length>200)throw new Error();
          json(response,await host.acceptInvitation(body.invitation,body.name));return;
        }
        if(options.tls&&url.pathname.startsWith('/identity/company/')){json(response,{error:'No such endpoint.'},404);return;}
        if(request.method==='POST'&&url.pathname==='/identity/company/begin'){
          const body=JSON.parse(await bodyOf(request));
          if(body.invitation!==undefined&&(typeof body.invitation!=='string'||body.invitation.length>256))throw new Error();
          // A proxy address is trusted only when composition explicitly supplies it.
          budget.admit(options.clientAddress?.(request)??request.socket.remoteAddress??'unknown');
          const attempt=randomBytes(32).toString('base64url'),browser=randomBytes(32).toString('base64url');
          reserveSignIn(attempts,attempt,{browser,invitation:body.invitation,expires:Date.now()+5*60_000});
          let authorization:URL;
          try{authorization=await host.beginCompanySignIn(browser);}catch(error){attempts.delete(attempt);throw error;}
          json(response,{attempt,authorization:authorization.href});return;
        }
        if(request.method==='POST'&&url.pathname==='/identity/company/complete'){
          const body=JSON.parse(await bodyOf(request));
          const attempt=attempts.get(body.attempt);attempts.delete(body.attempt);
          if(!attempt||attempt.expires<=Date.now()||typeof body.callback!=='string'||body.callback.length>8192)throw new Error();
          json(response,await host.completeCompanySignIn(new URL(body.callback),attempt.browser,attempt.invitation));return;
        }
        const token=tokenOf(request);
        if(!token){json(response,{error:'A workspace session is required.'},401);return;}
        if(url.pathname==='/identity/sign-out'&&request.method==='POST'){
          json(response,await host.signOut(token));return;
        }
        if(url.pathname==='/api'&&request.method==='POST'){
          const body=JSON.parse(await bodyOf(request));
          if(typeof body.method!=='string'||!METHODS.includes(body.method as Method))throw new Error();
          json(response,await host.callAuthenticated(token,body.method as Method,body.args));return;
        }
        if(url.pathname==='/api/events'&&request.method==='GET'){
          // Reserve before the asynchronous check so concurrent opens cannot exceed the caps.
          if((sessionStreams.get(token)??0)>=2){response.setHeader('retry-after','5');json(response,{error:'Temporary problem: this session already has two event streams. Close another window and retry.',outcome:'UNKNOWN'},429);return;}
          if(streams.size>=32){response.setHeader('retry-after','5');json(response,{error:'Temporary problem: workspace event streams are busy. Retry shortly.',outcome:'UNKNOWN'},503);return;}
          streams.add(response);sessionStreams.set(token,(sessionStreams.get(token)??0)+1);
          let off=()=>{};
          const release=()=>{off();if(!streams.delete(response))return;const count=(sessionStreams.get(token)??1)-1;if(count)sessionStreams.set(token,count);else sessionStreams.delete(token);};
          response.once('close',release);
          try {
            let opened=false;const notices:ApiEvent[]=[];
            const send=(event:ApiEvent)=>{if(response.writableEnded)return;response.write(`data: ${JSON.stringify(event)}\n\n`);if(event.topic==='identity'&&event.urgent?.startsWith('Access ended.'))response.end();};
            // Project events are sent only inside their live audience admission.
            // Before opening, retain only notices, never project payloads to flush
            // after releasing that admission's shared identity lock.
            const subscription=host.onAuthenticated(token,event=>{if(opened)send(event);else if(event.topic==='identity'&&event.urgent)notices.push(event);});
            off=subscription;
            await subscription.ready;
            if(response.destroyed){release();return;}
            response.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});response.write(': open\n\n');
            opened=true;for(const event of notices)send(event);
          } catch(error){release();throw error;}
          return;
        }
        json(response,{error:'No such endpoint.'},404);
      }catch(error){
        if(response.headersSent){response.end();return;}
        if(error instanceof SharedEngineRequired || error instanceof PersonalConversationRequired){json(response,{error:error.message,outcome:'REFUSED'},409);return;}
        if(error instanceof IdentityUnavailable){json(response,{error:error.message,outcome:'REFUSED',availability:error.availability},503);return;}
        if(error instanceof SignInRateLimited){response.setHeader('retry-after',String(error.retryAfter));json(response,{error:'Too many sign-in attempts.',outcome:'REFUSED'},429);return;}
        if(error instanceof IdentityRefused){
          let accessEnded=true;
          const token=tokenOf(request);
          if(token)try{await host.callAuthenticated(token,'identity.get',{});accessEnded=false;}catch(checkError){if(!(checkError instanceof IdentityRefused)){json(response,{error:'Temporary workspace problem. Access could not be checked; retry shortly.',outcome:'UNKNOWN'},503);return;}}
          json(response,{error:accessEnded?'Access ended. Ask the workspace owner for a new invitation.':'This request is not permitted for this workspace or project. A viewer can read but cannot send. Ask the owner to check your project access.',accessEnded,outcome:'REFUSED'},403);return;
        }
        if(error instanceof CoreRefusal&&definiteServerRefusal(error.cause)){json(response,{error:'The request was refused. Check the invitation and project permissions before trying again.',outcome:'REFUSED'},403);return;}
        json(response,{error:'The request outcome is unknown. Check the work, membership and receipts before sending it again.',outcome:'UNKNOWN'},503);
      }
    })();
  };
  const server=options.tls?createTlsServer({...options.tls,minVersion:'TLSv1.2',handshakeTimeout:5_000,connectionsCheckingInterval:1_000},handle):createServer({connectionsCheckingInterval:1_000},handle);
  server.maxConnections=64;server.requestTimeout=15_000;server.headersTimeout=5_000;
  // Count raw sockets before TLS: incomplete handshakes cannot monopolise the
  // global cap. Only the actual peer address counts, never a forwarded header.
  const connectionsByAddress=new Map<string,number>();
  server.on('connection',socket=>{
    const peer=socket.remoteAddress??'unknown',count=connectionsByAddress.get(peer)??0;
    if(count>=(options.connectionLimitPerAddress??8)){socket.destroy();return;}
    connectionsByAddress.set(peer,count+1);
    socket.once('close',()=>{const remaining=connectionsByAddress.get(peer)!-1;if(remaining)connectionsByAddress.set(peer,remaining);else connectionsByAddress.delete(peer);});
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.port??0,address,()=>{server.off('error',reject);resolve();});});
  origin=`${options.tls?'https':'http'}://${address.includes(':')?'['+address+']':address}:${(server.address() as {port:number}).port}`;
  return{origin,async close(){attempts.clear();for(const response of streams)response.end();streams.clear();await new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeIdleConnections();});}};
}
