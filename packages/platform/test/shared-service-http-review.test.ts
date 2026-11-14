import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { request } from 'node:https';
import pg from 'pg';
import { CoreRefusal, type CoreLink } from '../src/composition/core.ts';
import { createIdentityHost, type IdentityHostDeps } from '../src/composition/identity-host.ts';
import { serveIdentityApi } from '../src/composition/identity-http.ts';
import { sharedCertificate } from '../src/composition/shared-certificate.ts';
import { plaintextKeys } from '../src/keys/vault.ts';
import { RemoteClient, RemoteError } from '../src/remote/client.ts';
import { IdentityRefused } from '../src/composition/identity-core.ts';
import type { Host } from '../src/composition/host-types.ts';
import type { ApiEvent, Project } from '../src/api.ts';

const person={id:'colleague',name:'Colleague',role:'member' as const,status:'active' as const};
function fixture(followupError:Error=new CoreRefusal('unclassified','Connection reset after dispatch')) {
  let available=true,temporary=false,reads=0,admissions=0,dispatched=0;
  const lanes:string[]=[]; const subscribers=new Set<(event:ApiEvent)=>void>();
  const link={id:{person:person.id},person:()=>({}),identities:{requireReady(){},devicePerson:'owner',
    admit:async(_token:string,work:(p:typeof person)=>Promise<unknown>,_piece?:string,lane='request')=>{admissions++;lanes.push(lane);if(!available)throw new IdentityRefused();if(temporary)throw new Error('temporary connection loss');return work(person);}},
    read:async()=>{reads++;return{rows:[{access:'editor'}]};},
    call:async()=>{throw followupError;}} as unknown as CoreLink;
  const adapter=createIdentityHost({home:'/unused-review-home',readOnly:false,link:async()=>link,projects:()=>[{id:'shared'} as Project],threads:new Map(),summary:async t=>t.summary,material:{} as IdentityHostDeps['material'],piece:()=>null,nativeEngine:()=>false,emit(){},abort(){},on:fn=>{subscribers.add(fn);return()=>subscribers.delete(fn);},dispatch:async(method)=>{if(method==='projects.create'){dispatched++;return{ok:true,value:{id:'committed'}};}assert.fail('Unexpected dispatch');}} as IdentityHostDeps);
  return {adapter,lanes,get reads(){return reads;},get admissions(){return admissions;},get dispatched(){return dispatched;},expire(){available=false;},temporary(){temporary=true;},recover(){temporary=false;},emit(){for(const fn of subscribers)fn({topic:'identity'});}};
}
test('a committed project with an unconfirmed follow-up is UNKNOWN through the remote client and never resent',async()=>{
  const home=mkdtempSync(join(tmpdir(),'http-review-')),f=fixture();
  const tls=await sharedCertificate(home,plaintextKeys()),server=await serveIdentityApi({host:{callAuthenticated:f.adapter.call} as unknown as Host,tls});
  try {
    const client=new RemoteClient({origin:server.origin,fingerprint:tls.fingerprint},randomBytes(32).toString('base64url'));
    await assert.rejects(client.call('projects.create',{name:'Committed project',kind:'folder',clientKey:'committed-once'}),error=>error instanceof RemoteError&&error.outcome==='UNKNOWN'&&error.status===503&&/outcome is unknown.*Check the work/i.test(error.message));
    assert.equal(f.dispatched,1);
  } finally {await server.close();rmSync(home,{recursive:true,force:true});}
});
test('only a definite SQL refusal is REFUSED; socket and completion-unknown errors stay UNKNOWN',async()=>{
  for(const [code,severity,expected]of [['42501','ERROR',403],['08006','ERROR',503],['40003','ERROR',503],['42501','FATAL',503]] as const){
    const cause=new pg.DatabaseError('server response',0,'error');cause.code=code;cause.severity=severity;
    const refusal=new CoreRefusal('unclassified','server response',{cause});
    const server=await serveIdentityApi({host:{callAuthenticated:async()=>{throw refusal;}} as unknown as Host});
    try{const response=await fetch(server.origin+'/api',{method:'POST',headers:{authorization:'Bearer '+'a'.repeat(40)},body:JSON.stringify({method:'projects.list',args:{}})});assert.equal(response.status,expected,`${severity} ${code}`);}finally{await server.close();}
  }
});
test('event subscribers share one slower session poll and temporary failures do not end access',async t=>{
  t.mock.timers.enable({apis:['setInterval']});
  const f=fixture(),first:ApiEvent[]=[],second:ApiEvent[]=[];
  const off1=f.adapter.onAuthenticated('one-session',e=>first.push(e)),off2=f.adapter.onAuthenticated('one-session',e=>second.push(e));
  const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
  try {
    await settle();assert.equal(f.admissions,1);assert.deepEqual(f.lanes,['request']);
    t.mock.timers.tick(1_000);await settle();assert.equal(f.admissions,1);
    f.temporary();t.mock.timers.tick(4_000);await settle();
    assert.equal(f.admissions,2);assert.match(first[0]?.urgent??'',/temporary/i);assert.doesNotMatch(JSON.stringify(first),/Access ended/);assert.deepEqual(second,first);
    f.recover();f.expire();f.emit();await settle();assert.match(first.at(-1)?.urgent??'',/Access ended/);assert.deepEqual(second,first);
  } finally {off1();off2();}
});
test('event streams are capped per session and globally before opening more subscriptions',async()=>{
  // Isolate stream admission from the lower per-address socket limit.
  let opened=0;const server=await serveIdentityApi({host:{callAuthenticated:async()=>({ok:true}),onAuthenticated:()=>{opened++;return Object.assign(()=>{opened--;},{ready:Promise.resolve()});}} as unknown as Host,connectionLimitPerAddress:64});
  const bodies:ReadableStream<Uint8Array>[]=[];
  const connect=(token:string)=>fetch(server.origin+'/api/events',{headers:{authorization:`Bearer ${token}`}});
  try{
    const first='q'.repeat(40);
    for(let n=0;n<2;n++){const response=await connect(first);assert.equal(response.status,200);bodies.push(response.body!);}
    assert.equal((await connect(first)).status,429);assert.equal(opened,2);
    for(let n=1;n<16;n++)for(let i=0;i<2;i++){const response=await connect(n.toString(16).repeat(40));assert.equal(response.status,200);bodies.push(response.body!);}
    assert.equal(opened,32);const limited=await connect('z'.repeat(40));assert.equal(limited.status,503);assert.match((await limited.json()).error,/temporary/i);
  }finally{await Promise.all(bodies.map(body=>body.cancel()));await server.close();}
});
test('the shared TLS listener does not expose loopback company sign-in routes',async()=>{
  const home=mkdtempSync(join(tmpdir(),'http-company-review-'));let called=0;
  const tls=await sharedCertificate(home,plaintextKeys());
  const server=await serveIdentityApi({host:{beginCompanySignIn:async()=>{called++;return new URL('https://company.invalid/authorize');},completeCompanySignIn:async()=>{called++;return{ok:true};}} as unknown as Host,tls});
  try {
    // Use a locally pinned HTTPS request because the product RemoteClient has no company endpoint.
    const {request}=await import('node:https');
    for(const path of ['/identity/company/begin','/identity/company/complete']){
      const status=await new Promise<number>((resolve,reject)=>{const req=request(server.origin+path,{method:'POST',rejectUnauthorized:false},response=>{response.resume();resolve(response.statusCode!);});req.once('error',reject);req.end('{}');});
      assert.equal(status,404);
    }
    assert.equal(called,0);
  } finally{await server.close();rmSync(home,{recursive:true,force:true});}
});
test('the shared listener caps unauthenticated sockets and expires TLS handshakes promptly',async()=>{
  const home=mkdtempSync(join(tmpdir(),'http-connections-review-'));
  // Isolate the global guard from the stricter address guard, tested below.
  const tls=await sharedCertificate(home,plaintextKeys()),server=await serveIdentityApi({host:{} as Host,tls,connectionLimitPerAddress:64});
  const {connect}=await import('node:net');const sockets:import('node:net').Socket[]=[];let closed=0;
  try{
    for(let i=0;i<65;i++){
      const socket=connect({host:'127.0.0.1',port:Number(new URL(server.origin).port)});sockets.push(socket);socket.on('error',()=>{});socket.once('close',()=>{closed++;});
      await new Promise<void>(resolve=>socket.once('connect',resolve));
    }
    await new Promise(resolve=>setTimeout(resolve,100));assert.equal(closed,1,'the 65th concurrent socket is refused');
    await new Promise(resolve=>setTimeout(resolve,5_300));assert.equal(closed,65,'incomplete TLS handshakes expire after five seconds');
  }finally{for(const socket of sockets)socket.destroy();await server.close();rmSync(home,{recursive:true,force:true});}
});
test('the shared listener expires incomplete HTTP headers promptly',async()=>{
  const home=mkdtempSync(join(tmpdir(),'http-header-review-'));
  const tls=await sharedCertificate(home,plaintextKeys()),server=await serveIdentityApi({host:{} as Host,tls});
  const {connect}=await import('node:tls');const socket=connect({host:'127.0.0.1',port:Number(new URL(server.origin).port),rejectUnauthorized:false});
  let received='';socket.on('data',chunk=>{received+=chunk;});socket.on('error',()=>{});
  let timeout:ReturnType<typeof setTimeout>|undefined;
  try{
    await new Promise<void>(resolve=>socket.once('secureConnect',resolve));
    socket.write('GET /api/events HTTP/1.1\r\nHost: localhost\r\n');
    const closed=await Promise.race([new Promise<boolean>(resolve=>socket.once('close',()=>resolve(true))),new Promise<boolean>(resolve=>{timeout=setTimeout(()=>resolve(false),7_000);})]);
    assert.equal(closed,true,'an incomplete header cannot occupy a connection for more than seven seconds');assert.match(received,/408 Request Timeout/);
  }finally{if(timeout)clearTimeout(timeout);socket.destroy();await server.close();rmSync(home,{recursive:true,force:true});}
});
test('a definite metadata refusal after project creation cannot turn the committed mutation into REFUSED',async()=>{
  const cause=new pg.DatabaseError('metadata permission denied',0,'error');cause.code='42501';cause.severity='ERROR';
  const f=fixture(new CoreRefusal('denied',cause.message,{cause}));
  const server=await serveIdentityApi({host:{callAuthenticated:f.adapter.call} as unknown as Host});
  try{
    const response=await fetch(server.origin+'/api',{method:'POST',headers:{authorization:'Bearer '+'a'.repeat(40)},body:JSON.stringify({method:'projects.create',args:{name:'Committed',kind:'folder',clientKey:'commit-once'}})});
    assert.equal(response.status,503);assert.equal((await response.json()).outcome,'UNKNOWN');assert.equal(f.dispatched,1);
  }finally{await server.close();}
});

test('one address is limited to eight pre-TLS sockets while another address can still connect',async()=>{
  const home=mkdtempSync(join(tmpdir(),'http-address-cap-'));
  const tls=await sharedCertificate(home,plaintextKeys()),server=await serveIdentityApi({host:{} as Host,tls});
  const {connect}=await import('node:net'),{networkInterfaces}=await import('node:os');
  const other=Object.values(networkInterfaces()).flat().find(address=>address?.family==='IPv4'&&!address.internal)?.address;
  const sockets:import('node:net').Socket[]=[];let closed=0;
  const open=async(localAddress='127.0.0.1')=>{
    const socket=connect({host:'127.0.0.1',port:Number(new URL(server.origin).port),localAddress});sockets.push(socket);
    socket.on('error',()=>{});socket.once('close',()=>{closed++;});
    await new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});return socket;
  };
  const statusFrom=(localAddress:string)=>new Promise<number>((resolve,reject)=>{
    const req=request(server.origin+'/api',{localAddress,agent:false,rejectUnauthorized:false},response=>{response.resume();resolve(response.statusCode!);});
    req.once('error',reject);req.end();
  });
  try{
    assert.ok(other,'the shared-service network fixture has a non-loopback IPv4 address');
    for(let n=0;n<9;n++)await open();
    const deadline=Date.now()+2_000;while(!closed&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(closed,1,'the ninth socket from one address is refused before TLS');
    assert.equal(await statusFrom(other).catch(error=>{throw new Error('Another address must still reach the API',{cause:error});}),401,'another address can complete TLS and reach the API');
    await new Promise<void>(resolve=>{sockets[0].once('close',resolve);sockets[0].destroy();});
    let status:number|undefined;const releasedBy=Date.now()+2_000;
    while(status===undefined&&Date.now()<releasedBy){
      try{status=await statusFrom('127.0.0.1');}catch(error){if((error as NodeJS.ErrnoException).code!=='ECONNRESET')throw error;await new Promise(resolve=>setTimeout(resolve,10));}
    }
    assert.equal(status,401,'closing a socket releases its address slot');
  }finally{for(const socket of sockets)socket.destroy();await server.close();rmSync(home,{recursive:true,force:true});}
});
