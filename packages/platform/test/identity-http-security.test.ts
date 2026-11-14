import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {test} from 'node:test';
import type {Host} from '../src/composition/host-types.ts';
import {serveIdentityApi} from '../src/composition/identity-http.ts';
import {open,value} from './helpers.ts';

test('revocation ends an authenticated event stream after one urgent notice',async()=>{
 const {host}=open();const invite=value(await host.call('identity.invite',{role:'member'})),joined=value(await host.acceptInvitation(invite.token,'Stream member'));
 const server=await serveIdentityApi({host});let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 try{
  const response=await fetch(server.origin+'/api/events',{headers:{authorization:`Bearer ${joined.session}`}});assert.equal(response.status,200);
  reader=response.body!.getReader();await reader.read();
  value(await host.call('identity.remove',{personId:joined.person.id}));
  let text='';const closed=(async()=>{while(true){const next=await reader!.read();if(next.done)return true;text+=new TextDecoder().decode(next.value);}})();
  assert.equal(await Promise.race([closed,new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),5_000);})]),true);
  assert.equal((text.match(/Access ended/g)??[]).length,1);
 }finally{if(timer)clearTimeout(timer);await reader?.cancel();await server.close();}
});

test('one unauthenticated client is rate limited before it fills company sign-in attempts',async()=>{
 let starts=0;const host={beginCompanySignIn:async()=>{starts++;return new URL('https://provider.example.invalid/authorize');}} as unknown as Host;
 const server=await serveIdentityApi({host});
 try{
  const begin=()=>fetch(server.origin+'/identity/company/begin',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  for(let n=0;n<8;n++)assert.equal((await begin()).status,200);
  const limited=await begin();assert.equal(limited.status,429);assert.ok(Number(limited.headers.get('retry-after'))>0);assert.equal(starts,8);
 }finally{await server.close();}
});

for(const property of ['userName','externalId'] as const)test(`SCIM repeated ${property} creation is a known uniqueness refusal`,async()=>{
 const bearer=randomBytes(32).toString('base64url'),{host}=open(undefined,{identity:{directory:{bearer,issuer:'https://directory.example.invalid'}}});
 const request=(userName:string,externalId:string)=>host.directoryRequest(new Request('https://host.example.invalid/scim/v2/Users',{method:'POST',headers:{authorization:`Bearer ${bearer}`,'content-type':'application/scim+json'},body:JSON.stringify({userName,externalId})}));
 assert.equal((await request('original','subject')).status,201);
 const response=await request(property==='userName'?'original':'different',property==='externalId'?'subject':'different');
 assert.equal(response.status,409);
});

test('SCIM deletion returns no user and cannot recreate its reserved account binding',async()=>{
 const bearer=randomBytes(32).toString('base64url'),{host}=open(undefined,{identity:{directory:{bearer,issuer:'https://directory.example.invalid'}}});
 const request=(method:string,path:string,body?:unknown)=>host.directoryRequest(new Request(`https://host.example.invalid/scim/v2/${path}`,{method,headers:{authorization:`Bearer ${bearer}`,'content-type':'application/scim+json'},body:body===undefined?undefined:JSON.stringify(body)}));
 const made=await request('POST','Users',{userName:'original',externalId:'subject'}),id=(await made.json()).id;
 assert.equal((await request('DELETE',`Users/${id}`)).status,204);
 assert.equal((await request('GET',`Users/${id}`)).status,404);
 assert.equal((await request('DELETE',`Users/${id}`)).status,404);
 assert.equal((await request('POST','Users',{userName:'original',externalId:'subject'})).status,409);
});
