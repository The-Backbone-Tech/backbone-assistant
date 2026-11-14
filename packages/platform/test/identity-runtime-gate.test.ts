import assert from 'node:assert/strict';
import {test} from 'node:test';
import {IdentityCore} from '../src/composition/identity-core.ts';
const actor={workspace:'workspace',person:'owner',system:'system',agent:'agent',mandate:'mandate'};
for(const entry of ['resolve','admit','admitPerson','asPerson','asAutomation'] as const)test(`unverified identity ${entry} refuses a typed paused state before any connection or work`,async()=>{
 let connections=0,entered=false;
 const identity=new IdentityCore(async()=>{connections++;throw new Error('Unexpected connection');},actor,()=>actor,async(_actor,work)=>work());
 const work=async()=>{entered=true;};
 const result=entry==='resolve'?identity.resolve(undefined):entry==='admit'?identity.admit(undefined,work):entry==='admitPerson'?identity.admitPerson(actor.person,work):entry==='asPerson'?identity.asPerson(actor.person,work):identity.asAutomation({id:'automation',name:'Fixture',project:'project',person:'member',mandate:'mandate',piece:null,revoked:false},work);
 await assert.rejects(result,error=>error instanceof Error&&'reason' in error&&error.reason==='paused');
 assert.equal(connections,0);assert.equal(entered,false);
});

test('all Host identity entry points and HTTP refuse a paused runtime without provider or write work',async()=>{
 const {createIdentityHost}=await import('../src/composition/identity-host.ts');
 const {serveIdentityApi}=await import('../src/composition/identity-http.ts');
 const {freshHome}=await import('./helpers.ts');
 const identity=new IdentityCore(async()=>{assert.fail('No connection before runtime readiness');},actor,()=>actor,async(_actor,work)=>work());
 const adapter=createIdentityHost({home:freshHome(),readOnly:false,link:async()=>({identities:identity}) as never,projects:()=>[],threads:new Map(),summary:async thread=>thread.summary,material:{} as never,piece:()=>null,nativeEngine:()=>false,emit(){assert.fail('No mutation while paused');},abort(){assert.fail('No abort while paused');},on:()=>()=>{},dispatch:async()=>assert.fail('No dispatch while paused'),configuration:{directory:{bearer:'fixture-directory-secret',issuer:'https://issuer.example.invalid'}}});
 const entries=[()=>adapter.call('fixture-session','identity.get',{}),()=>adapter.acceptInvitation('fixture-code','Person'),()=>adapter.beginCompanySignIn('fixture-browser'),()=>adapter.completeCompanySignIn(new URL('https://host.example.invalid/callback'),'fixture-browser'),()=>adapter.directoryRequest(new Request('https://host.example.invalid/scim/v2/Users'))];
 for(const entry of entries)await assert.rejects(entry(),error=>error instanceof Error&&'reason' in error&&error.reason==='paused');
 const host={onAuthenticated:adapter.onAuthenticated,callAuthenticated:(token:string,method:Parameters<typeof adapter.call>[1],args:never)=>adapter.call(token,method,args),acceptInvitation:adapter.acceptInvitation,beginCompanySignIn:adapter.beginCompanySignIn,completeCompanySignIn:adapter.completeCompanySignIn,directoryRequest:adapter.directoryRequest} as unknown as import('../src/composition/host-types.ts').Host;
 const server=await serveIdentityApi({host});
 try{
  for(const [path,body]of [['/api',{method:'identity.get',args:{}}],['/identity/accept',{invitation:'fixture-code',name:'Person'}],['/identity/company/begin',{}]] as const){
   const response=await fetch(server.origin+path,{method:'POST',headers:{authorization:'Bearer '+'a'.repeat(40),'content-type':'application/json'},body:JSON.stringify(body)});
   assert.equal(response.status,503);const value=await response.json();assert.equal(value.outcome,'REFUSED');assert.equal(value.availability.state,'paused');
  }
  for(const path of ['/api/events','/scim/v2/Users']){
   const response=await fetch(server.origin+path,{headers:{authorization:'Bearer '+'a'.repeat(40)}});assert.equal(response.status,503);assert.equal((await response.json()).availability.state,'paused');
  }
 }finally{await server.close();}
});

test('a predecessor qualification result cannot stand in for runtime readiness',async()=>{
 let entered=false;
 const identity=new IdentityCore(async()=>{assert.fail('A predecessor does not open an admission connection');},actor,()=>actor,async(_actor,work)=>work(),undefined,{state:'verified',reason:'Exact predecessor'} as never);
 await assert.rejects(identity.admit(undefined,async()=>{entered=true;}),error=>error instanceof Error&&'reason' in error&&error.reason==='paused');assert.equal(entered,false);
});
