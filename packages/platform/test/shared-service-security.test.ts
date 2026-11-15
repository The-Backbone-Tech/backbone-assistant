import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { serveIdentityApi } from '../src/composition/identity-http.ts';
import { createIdentityHost, type IdentityHostDeps } from '../src/composition/identity-host.ts';
import { IdentityRefused } from '../src/composition/identity-core.ts';
import type { CoreLink } from '../src/composition/core.ts';
import type { Project, ApiEvent } from '../src/api.ts';
import type { Host } from '../src/composition/host-types.ts';
import { open, value, freshHome } from './helpers.ts';

const person={id:'colleague',name:'Colleague',role:'member' as const,status:'active' as const};
function boundary(native=false){
  let live=true, visible=true, listener:((event:ApiEvent)=>void)|undefined;
  const link={id:{person:person.id},person:()=>({}),identities:{requireReady(){},devicePerson:'owner',admit:async(_token:string,work:(p:typeof person)=>Promise<unknown>)=>{if(!live)throw new IdentityRefused();return work(person);}},read:async()=>({rows:[{access:visible?'editor':null}]})} as unknown as CoreLink;
  const adapter=createIdentityHost({home:freshHome(),readOnly:false,link:async()=>link,projects:()=>[{id:'shared'} as Project],threads:new Map(),summary:async t=>t.summary,material:{} as IdentityHostDeps['material'],piece:()=>null,nativeEngine:()=>native,emit(){},abort(){},on:fn=>{listener=fn;return()=>{listener=undefined;};},dispatch:async()=>assert.fail('The member cannot dispatch to this native engine.')});
  return {adapter,expire:()=>{live=false;},withdraw:()=>{visible=false;listener?.({topic:'identity'});}};
}
test('a native-account engine refusal tells the colleague the message was not sent and what the owner does',async()=>{
  const {adapter}=boundary(true);
  const server=await serveIdentityApi({host:{callAuthenticated:adapter.call} as unknown as Host});
  try{
    const response=await fetch(server.origin+'/api',{method:'POST',headers:{authorization:'Bearer '+'a'.repeat(40)},body:JSON.stringify({method:'turns.send',args:{projectId:'shared',text:'Hello',attachments:[],settings:{},clientKey:randomUUID()}})});
    assert.equal(response.status,409);
    assert.match((await response.json()).error,/was not sent.*workspace owner.*backbone model shared local/);
  }finally{await server.close();}
});
for(const action of ['expire','withdraw'] as const)test(`an idle stream ends after ${action} without needing a model event`,async t=>{
  t.mock.timers.enable({apis:['setInterval']});
  const fixture=boundary(), notices:ApiEvent[]=[];
  const off=fixture.adapter.onAuthenticated('session',event=>notices.push(event));
  try{
    // Allow initial audience admission, then test expiry without an event at all.
    await off.ready; fixture[action]();
    t.mock.timers.tick(5_000);await new Promise<void>(resolve=>setImmediate(resolve));
    assert.deepEqual(notices,[{topic:'identity',urgent:'Access ended. Sign in again.'}]);
  }finally{off();}
});
test('sign-out ends only the presented session and refuses later requests',async()=>{
  const {host}=open(), first=value(await host.acceptInvitation(value(await host.call('identity.invite',{role:'member'})).token,'First'));
  const second=value(await host.acceptInvitation(value(await host.call('identity.invite',{role:'member'})).token,'Second'));
  const server=await serveIdentityApi({host});
  try{
    const response=await fetch(server.origin+'/identity/sign-out',{method:'POST',headers:{authorization:`Bearer ${first.session}`},body:'{}'});
    assert.equal(response.status,200); assert.deepEqual(await response.json(),{ok:true,value:{ended:true}});
    await assert.rejects(host.callAuthenticated(first.session,'identity.get',{}));
    assert.equal(value(await host.callAuthenticated(second.session,'identity.get',{})).person.id,second.person.id);
  }finally{await server.close();}
});
test('a public address cannot start a plain HTTP listener',async()=>{
  await assert.rejects(serveIdentityApi({host:{} as Host,address:'0.0.0.0'}),/requires TLS/);
});
