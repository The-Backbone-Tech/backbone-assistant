import https from 'node:https';
import http from 'node:http';
import {createHmac,generateKeyPairSync,sign} from 'node:crypto';
import {mock} from 'node:test';
import {teamsMessage} from './breadth-fixtures.ts';

/** The production verifier still validates signatures; its JWKS and MSAL token transports are local. */
export async function localTeamsKeys(){
 const keys=generateKeyPairSync('rsa',{modulusLength:2048});
 const jwk={...keys.publicKey.export({format:'jwk'}),kid:'local-key',use:'sig',alg:'RS256'};
 const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
 let fetches=0,tokens=0;
 const server=http.createServer((req,res)=>{
  res.setHeader('content-type','application/json');
  if(req.url==='/token'){
   tokens++;const token=encode({alg:'none'})+'.'+encode({aud:'https://api.botframework.com',appid:'app-id',exp:Math.floor(Date.now()/1000)+3600})+'.synthetic';
   res.end(JSON.stringify({token_type:'Bearer',expires_in:3600,ext_expires_in:3600,access_token:token}));
  }else{fetches++;res.end(JSON.stringify({keys:[jwk]}));}
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const address=server.address();if(!address||typeof address==='string')throw new Error('No local JWKS endpoint');
 const nativeHttps=https.request,localFetch=globalThis.fetch;
 const transport=mock.method(https,'request',(options:unknown,callback:Parameters<typeof http.request>[1])=>{
  const target=options as {hostname?:string;path?:string};
  if(!((target.hostname==='login.botframework.com'&&target.path==='/v1/.well-known/keys')||(target.hostname==='login.microsoftonline.com'&&/^\/tenant-(one|two)\/discovery\/v2.0\/keys$/.test(target.path??''))))return Reflect.apply(nativeHttps,https,[options,callback] as never);
  return http.request(`http://127.0.0.1:${address.port}`,callback);
 });
 const tokenTransport=mock.method(globalThis,'fetch',(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
  const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
  if(url.origin==='https://login.microsoftonline.com'&&url.pathname==='/tenant-one/oauth2/v2.0/token'){
   return localFetch('http://127.0.0.1:'+address.port+'/token',init);
  }
  return localFetch(input,init);
 });
 return {
  fetches:()=>fetches,tokens:()=>tokens,
  token(serviceUrl:string,claims:Record<string,unknown>={},header:Record<string,unknown>={}){
   const body=`${encode({typ:'JWT',alg:'RS256',kid:'local-key',...header})}.${encode({iss:'https://api.botframework.com',aud:'app-id',serviceurl:serviceUrl,exp:Math.floor(Date.now()/1000)+600,...claims})}`;
   const signature=header.alg==='none'?'':header.alg==='HS256'?createHmac('sha256',keys.publicKey.export({type:'spki',format:'pem'})).update(body).digest('base64url'):sign('RSA-SHA256',Buffer.from(body),keys.privateKey).toString('base64url');
   return `${body}.${signature}`;
  },
  request(token:string,url:string,extra={}){return new Request('http://localhost/channels/teams',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(teamsMessage(1,'local work',url,extra))});},
  async close(){tokenTransport.mock.restore();transport.mock.restore();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
 };
}
