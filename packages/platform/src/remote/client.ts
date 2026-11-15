// Pin the peer before constructing an HTTP request: neither invitation nor bearer
// can leave on a different certificate. No CA, redirect, proxy or retry is used.
import { Agent, request } from 'node:https';
import { connect, type TLSSocket } from 'node:tls';
import { isIP } from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { ApiEvent, Args, Method, Result } from '../api.ts';

export interface RemoteAddress { origin: string; fingerprint: string }
export interface JoinLink extends RemoteAddress { invitation: string }
export const ACCESS_ENDED='Access ended. Ask the workspace owner for a new invitation, then run backbone join <link>.';
export class RemoteError extends Error {
  readonly outcome:'REFUSED'|'UNKNOWN'; readonly status?:number; readonly accessEnded:boolean;
  constructor(message:string,outcome:'REFUSED'|'UNKNOWN',status?:number,accessEnded=false){super(message);this.name='RemoteError';this.outcome=outcome;this.status=status;this.accessEnded=accessEnded;}
}
function address(value:RemoteAddress):RemoteAddress {
  const url=new URL(value.origin);
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!/^([0-9a-f]{64})$/.test(value.fingerprint))throw new Error('Invalid workspace address or certificate fingerprint.');
  return {origin:url.origin,fingerprint:value.fingerprint};
}
export function parseJoinLink(link:string):JoinLink {
  try {
    const url=new URL(link), fields=new URLSearchParams(url.hash.slice(1));
    if([...fields.keys()].length!==2||fields.getAll('fingerprint').length!==1||fields.getAll('invitation').length!==1||! /^[A-Za-z0-9_-]{30,256}$/.test(fields.get('invitation')??''))throw new Error();
    const result=address({origin:link.split('#')[0],fingerprint:fields.get('fingerprint')??''});
    return {...result,invitation:fields.get('invitation')!};
  } catch { throw new Error('This join link is invalid. Ask the workspace owner for a complete HTTPS join link.'); }
}
export function makeJoinLink(target:JoinLink):string {
  const {origin,fingerprint}=address(target);
  const link=origin+'/#'+new URLSearchParams({fingerprint,invitation:target.invitation});
  parseJoinLink(link); return link;
}
async function pinned(target:RemoteAddress,signal?:AbortSignal):Promise<TLSSocket> {
  const url=new URL(target.origin), host=url.hostname.replace(/^\[|\]$/g,'');
  return new Promise((resolve,reject)=>{
    const socket=connect({host,port:Number(url.port)||443,servername:isIP(host)?undefined:host,rejectUnauthorized:false});
    const abort=()=>socket.destroy(new RemoteError('The workspace connection was closed.','REFUSED'));
    signal?.addEventListener('abort',abort,{once:true});
    socket.once('close',()=>signal?.removeEventListener('abort',abort));
    if(signal?.aborted)abort();
    const timeout=setTimeout(()=>socket.destroy(new RemoteError('The workspace did not answer. Check its address and connection.', 'REFUSED')),10_000);
    const failed=(error:Error)=>{clearTimeout(timeout);reject(error instanceof RemoteError?error:new RemoteError('The workspace connection failed. Check its address and connection.','REFUSED'));};
    socket.once('error',failed);
    socket.once('secureConnect',()=>{
      clearTimeout(timeout);
      const raw=socket.getPeerCertificate().raw, actual=raw&&createHash('sha256').update(raw).digest();
      if(!actual||!timingSafeEqual(actual,Buffer.from(target.fingerprint,'hex'))){socket.destroy();reject(new RemoteError('The workspace certificate does not match the join link. Ask the owner for the current link; nothing was sent.','REFUSED'));return;}
      // Retain an error listener until HTTP takes over: a peer may fail in the
      // promise handoff immediately after this certificate check.
      resolve(socket);
    });
  });
}
export class RemoteClient {
  readonly target:RemoteAddress;
  private readonly session?:string;
  constructor(target:RemoteAddress,session?:string){this.target=address(target);this.session=session;}
  private async response(path:string,body?:unknown,signal?:AbortSignal){
    if(!['/api','/api/events','/identity/accept','/identity/sign-out'].includes(path))throw new Error('No such remote endpoint.');
    const socket=await pinned(this.target,signal);
    if(socket.destroyed)throw new RemoteError('The connection ended. The request outcome is unknown. Read the work before sending it again.','UNKNOWN');
    const agent=new Agent({keepAlive:false});
    // The already verified socket is the only connection this one-request agent can make.
    agent.createConnection=()=>socket;
    return new Promise<import('node:http').IncomingMessage>((resolve,reject)=>{
      const req=request(new URL(path,this.target.origin),{agent,method:body===undefined?'GET':'POST',signal,
        headers:{...(body===undefined?{}:{'content-type':'application/json'}),...(this.session?{authorization:`Bearer ${this.session}`}:{})}},response=>{
        req.setTimeout(0); response.once('close',()=>agent.destroy()); resolve(response);
      });
      req.setTimeout(15_000,()=>req.destroy(new Error('timeout')));
      req.once('error',()=>{agent.destroy();reject(new RemoteError('The connection ended. The request outcome is unknown. Read the work before sending it again.','UNKNOWN'));});
      req.end(body===undefined?undefined:JSON.stringify(body));
    });
  }
  async request(path:string,body?:unknown):Promise<unknown>{
    const response=await this.response(path,body), chunks:Buffer[]=[];let size=0;
    try {
      for await(const chunk of response){size+=chunk.length;if(size>64*1024*1024){response.destroy();throw new Error();}chunks.push(Buffer.from(chunk));}
      const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(response.statusCode!==200){
        const status=response.statusCode;
        const ended=status===401||value?.accessEnded===true;
        if(ended)throw new RemoteError(ACCESS_ENDED,'REFUSED',status,true);
        // A refusal needs the workspace's explicit word for it. A reply without one (a proxy's 500 or 502,
        // another server's 404, a failure after the change committed) proves nothing was left undone.
        if(value?.outcome==='REFUSED')throw new RemoteError(typeof value.error==='string'?value.error:'The workspace refused this request.','REFUSED',status);
        throw new RemoteError(value?.outcome==='UNKNOWN'&&typeof value.error==='string'?value.error:'The workspace gave no clear answer. The request outcome is unknown. Read the work before sending it again.','UNKNOWN',status);
      }
      return value;
    } catch(error){if(error instanceof RemoteError)throw error;throw new RemoteError('The reply was lost or invalid. The request outcome is unknown. Read the work before sending it again.','UNKNOWN');}
  }
  async call<M extends Method>(method:M,args:Args<M>):Promise<Result<M>> {return await this.request('/api',{method,args}) as Result<M>;}
  async *events(signal?:AbortSignal):AsyncGenerator<ApiEvent>{
    const response=await this.response('/api/events',undefined,signal);
    try {
      if(response.statusCode!==200){
        const status=response.statusCode;let text='';
        for await(const chunk of response){text+=chunk.toString();if(text.length>65_536)break;}
        let value:{accessEnded?:boolean;error?:string;outcome?:string}={};try{value=JSON.parse(text)??{};}catch{}
        if(status===401||value.accessEnded===true)throw new RemoteError(ACCESS_ENDED,'REFUSED',status,true);
        if(status===429||(status??0)>=500)throw new RemoteError('Temporary workspace connection problem. Try opening the event stream again shortly.','UNKNOWN',status);
        // The same rule as a request: without the workspace's explicit word, nothing says who answered.
        if(value.outcome==='REFUSED')throw new RemoteError(typeof value.error==='string'?value.error:'The workspace event stream is not permitted.','REFUSED',status);
        throw new RemoteError('The workspace gave no clear answer about the event stream. Try opening it again shortly.','UNKNOWN',status);
      }
      let pending='', ended=false; const decoder=new TextDecoder();
      for await(const chunk of response){
        pending+=decoder.decode(chunk,{stream:true});
        if(pending.length>1_048_576)throw new RemoteError('The workspace event stream is invalid.','UNKNOWN');
        let boundary:number;
        while((boundary=pending.indexOf('\n\n'))>=0){
          const frame=pending.slice(0,boundary);pending=pending.slice(boundary+2);
          const data=frame.split('\n').filter(line=>line.startsWith('data: ')).map(line=>line.slice(6)).join('\n');
          if(data){
            const event=JSON.parse(data) as ApiEvent;
            if(event.topic==='identity'&&event.urgent?.startsWith('Access ended'))ended=true;
            yield event;
          }
        }
      }
      if(!ended&&!signal?.aborted)throw new RemoteError('Temporary workspace connection problem. Try opening the event stream again shortly.','UNKNOWN');
    } catch(error){
      if(error instanceof RemoteError)throw error;
      if(!signal?.aborted)throw new RemoteError('Temporary workspace connection problem. Try opening the event stream again shortly.','UNKNOWN');
    } finally {response.destroy();}
  }
}
