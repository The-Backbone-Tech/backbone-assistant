import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { open,value } from './helpers.ts';
import { serveIdentityApi } from '../src/composition/identity-http.ts';

test('the team HTTP service never inherits owner authority and scopes directory sync to its configured issuer',async()=>{
  const bearer=randomBytes(32).toString('base64url'),issuer='https://company.example.invalid';
  const {host}=open(undefined,{identity:{directory:{bearer,issuer}}});
  const server=await serveIdentityApi({host});
  try{
    const call=(method:string,session?:string)=>fetch(server.origin+'/api',{method:'POST',headers:{'content-type':'application/json',...(session?{authorization:`Bearer ${session}`}:{})},body:JSON.stringify({method,args:{}})});
    assert.equal((await call('projects.list')).status,401);
    assert.equal((await call('projects.list','invalid-session-that-is-long-enough')).status,403);
    const invitation=value(await host.call('identity.invite',{role:'member'}));
    const response=await fetch(server.origin+'/identity/accept',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({invitation:invitation.token,name:'HTTP member'})});
    const joined=await response.json();assert.equal(joined.ok,true);
    assert.equal((await call('projects.list',joined.value.session)).status,200);
    assert.equal((await call('identity.invite',joined.value.session)).status,403);
    const scim=(method:string,path:string,body?:unknown,credential=bearer)=>fetch(server.origin+'/scim/v2/'+path,{method,headers:{authorization:`Bearer ${credential}`,'content-type':'application/scim+json'},body:body===undefined?undefined:JSON.stringify(body)});
    assert.equal((await scim('POST','Users',{userName:'directory-person',externalId:'subject-one'},'wrong')).status,401);
    const made=await scim('POST','Users',{userName:'directory-person',externalId:'subject-one',displayName:'Directory person'});
    assert.equal(made.status,201);
    const id=(await made.json()).id as string;
    assert.equal((await scim('DELETE',`Users/${joined.value.person.id}`)).status,404,'a directory cannot remove people it did not provision');
    const deleted=await scim('PATCH',`Users/${id}`,{schemas:['urn:ietf:params:scim:api:messages:2.0:PatchOp'],Operations:[{op:'replace',path:'active',value:false}]});
    assert.equal(deleted.status,200);
    assert.equal((await deleted.json()).active,false);
    assert.equal((await scim('PUT',`Users/${id}`,{userName:'directory-person',externalId:'subject-one',active:true})).status,409);
    value(await host.call('identity.remove',{personId:joined.value.person.id}));
    assert.equal((await call('projects.list',joined.value.session)).status,403);
  }finally{await server.close();}
});
