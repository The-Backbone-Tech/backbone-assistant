import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { admissionLanes, ADMISSION_CONNECTIONS, REQUEST_ADMISSIONS } from '../src/composition/admission-lanes.ts';
import { createIdentityHost, type IdentityHostDeps } from '../src/composition/identity-host.ts';
import type { CoreLink } from '../src/composition/core.ts';
import { serveIdentityApi } from '../src/composition/identity-http.ts';
import type { Host } from '../src/composition/host-types.ts';
import type { ApiEvent, Project } from '../src/api.ts';
import type { StoredThread } from '../src/composition/thread-journal.ts';

const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
const person={id:'colleague',name:'Colleague',role:'member' as const,status:'active' as const};
function fixture(t:TestContext){
  const home=mkdtempSync(join(tmpdir(),'shared-confirmation-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
  let visible=true,temporary=false,held:Promise<void>|undefined,active=0,maximum=0,connections=0;
  const waiting:(()=>void)[]=[],subscribers=new Set<(event:ApiEvent)=>void>(),checks=new Map<string,number>();
  const context=new AsyncLocalStorage<string>();
  const connect=admissionLanes(async()=>{
    if(connections>=ADMISSION_CONNECTIONS)await new Promise<void>(resolve=>waiting.push(resolve));
    else connections++;
    return {release(){const next=waiting.shift();if(next)next();else connections--;}} as pg.PoolClient;
  });
  const link={id:{person:person.id},person:()=>({}),identities:{requireReady(){},devicePerson:'owner',
    admit:async(token:string,work:(p:typeof person)=>Promise<unknown>,_piece?:string,lane='request')=>{
      const client=await connect(lane as 'request'|'status');
      try{return await context.run(token,()=>work(person));}finally{client.release();}
    }},read:async()=>{
      const token=context.getStore()!;
      if(token.startsWith('stream')){
        checks.set(token,(checks.get(token)??0)+1);active++;maximum=Math.max(maximum,active);
        try{await held;if(temporary)throw new Error('temporary access outage');}finally{active--;}
      }
      return {rows:[{access:visible?'editor':null}]};
    }} as unknown as CoreLink;
  const thread={summary:{id:'thread',projectId:'shared'},personId:person.id,clientKeys:[]} as unknown as StoredThread;
  const adapter=createIdentityHost({home,readOnly:false,link:async()=>link,projects:()=>[{id:'shared'} as Project],threads:new Map([['thread',thread]]),summary:async t=>t.summary,material:{} as IdentityHostDeps['material'],piece:()=>null,nativeEngine:()=>false,emit(){},abort(){},on:fn=>{subscribers.add(fn);return()=>subscribers.delete(fn);},dispatch:(async(method:string)=>method==='threads.get'?{ok:true,value:{summary:thread.summary,turns:[]}}:{ok:true}) as unknown as IdentityHostDeps['dispatch']} as IdentityHostDeps);
  return {adapter,connect,checks,get maximum(){return maximum;},reset(){checks.clear();maximum=0;},hold(){let release!:()=>void;held=new Promise<void>(resolve=>{release=resolve;});return()=>{held=undefined;release();};},fail(){temporary=true;},recover(){temporary=false;},withdraw(){visible=false;},emit(){for(const fn of subscribers)fn({topic:'threads',id:'thread'});}};
}

test('32 streaming sessions coalesce event bursts, preserve Stop/status capacity and all get rechecked',async t=>{
  const f=fixture(t),off:(()=>void)[]=[],notified=new Set<number>();
  let release=()=>{};const ordinary:pg.PoolClient[]=[];
  try{
    for(let n=0;n<32;n++)off.push(f.adapter.onAuthenticated('stream-'+n,event=>{if(event.topic==='threads')notified.add(n);}));
    await settle();f.reset();
    // Fill most ordinary slots as if requests were waiting for a write.
    for(let n=0;n<REQUEST_ADMISSIONS-2;n++)ordinary.push(await f.connect('request'));
    release=f.hold();f.emit();await settle();
    for(let n=0;n<100;n++)f.emit();
    await settle();
    const served=Promise.all([f.adapter.call('control','turns.stop',{threadId:'thread'}),f.adapter.call('control','threads.get',{id:'thread'})]);
    let timeout:ReturnType<typeof setTimeout>|undefined;
    try{assert.equal(await Promise.race([served.then(()=>true),new Promise<boolean>(resolve=>{timeout=setTimeout(()=>resolve(false),500);})]),true,'Stop and status answer while audience checks are held');}
    finally{if(timeout)clearTimeout(timeout);}
    assert.ok(f.maximum<=2,`audience concurrency is bounded, observed ${f.maximum}`);
    release();await settle();
    assert.equal(f.checks.size,32,'every queued session was rechecked');
    assert.equal(notified.size,32,'every session receives its checked event');
    assert.ok([...f.checks.values()].every(count=>count<=2),'each session has at most one pending recheck after the burst');
  }finally{release();for(const client of ordinary)client.release();for(const unsubscribe of off)unsubscribe();await settle();}
});

test('a failed first recheck keeps the projects captured at stream admission',async t=>{
  const f=fixture(t),notices:ApiEvent[]=[];
  const off=f.adapter.onAuthenticated('stream-outage',event=>notices.push(event));
  try{
    // Admission establishes a baseline before the transport declares the stream open.
    await off.ready;
    f.fail();f.emit();await settle();
    assert.match(notices[0]?.urgent??'',/Temporary/);
    f.withdraw();f.recover();f.emit();await settle();
    assert.deepEqual(notices.at(-1),{topic:'identity',urgent:'Access ended. Sign in again.'});
  }finally{off();}
});


test('stream admission waits for its project snapshot and releases a failed subscription',async t=>{
  const f=fixture(t),server=await serveIdentityApi({host:{callAuthenticated:f.adapter.call,onAuthenticated:f.adapter.onAuthenticated} as unknown as Host});
  const token='stream-'+ 'x'.repeat(32);
  const connect=()=>fetch(server.origin+'/api/events',{headers:{authorization:`Bearer ${token}`}});
  let release=()=>{},body:ReadableStream<Uint8Array>|null=null;
  try{
    release=f.hold();let answered=false;
    const opening=connect().then(response=>{answered=true;return response;});
    const deadline=Date.now()+2_000;while(!f.checks.size&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(f.checks.size,1,'the initial project snapshot is being read');
    assert.equal(answered,false,'HTTP does not admit the stream before its snapshot');
    f.fail();release();const refused=await opening;
    assert.equal(refused.status,503);assert.equal((await refused.json()).outcome,'UNKNOWN');
    const checks=f.checks.get(token);f.emit();await settle();assert.equal(f.checks.get(token),checks,'failed opening unsubscribed');
    f.recover();const reopened=await connect();body=reopened.body;assert.equal(reopened.status,200);
  }finally{release();await body?.cancel();await server.close();}
});
