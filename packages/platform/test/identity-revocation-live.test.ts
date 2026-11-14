import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {startScriptedModel} from '../src/testing/scripted-model.ts';
import {hangDetector} from '../../../scripts/lib/test-hang.ts';
import {identityProviderFixture} from './identity-provider-fixture.ts';
import {open,value,idle,settings} from './helpers.ts';

for(const directory of [false,true])test(`${directory?'SCIM deletion':'membership removal'} stops a live person run and refuses all later requests before a late model answer`,async()=>{
 let entered!:()=>void,release!:()=>void;const entering=new Promise<void>(resolve=>{entered=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
 const model=await startScriptedModel('identity-security-live',()=>({text:'LATE_IDENTITY_ANSWER'}),{before:async()=>{entered();await held;}}),provider=await identityProviderFixture(),bearer=randomBytes(32).toString('base64url');
 const {host}=open(undefined,{harness:'harness-pi',...(directory?{identity:{company:{issuer:provider.issuer,clientId:'test-app',redirectUri:'http://127.0.0.1/callback',allowLoopbackHttp:true},directory:{bearer,issuer:provider.issuer}}}:{})});
 const scim=(method:string,path:string,body?:unknown)=>host.directoryRequest(new Request(`https://app.example.invalid/scim/v2/${path}`,{method,headers:{authorization:`Bearer ${bearer}`,'content-type':'application/scim+json'},body:body===undefined?undefined:JSON.stringify(body)}));
 try{
  value(await host.call('settings.model.put',{change:{route:'own',provider:'openai-compatible',baseUrl:model.url,model:model.model,key:'fake-'+randomUUID()}}));
  let joined:Awaited<ReturnType<typeof host.acceptInvitation>>;
  if(directory){const created=await scim('POST','Users',{userName:'directory-colleague',externalId:'directory-subject'});assert.equal(created.status,201);const id=(await created.json()).id;const authorization=await host.beginCompanySignIn('fixture-browser');joined=await host.completeCompanySignIn(provider.callback(authorization,'directory-subject'),'fixture-browser');assert.equal(value(joined).person.id,id);}
  else{const invitation=value(await host.call('identity.invite',{role:'member'}));joined=await host.acceptInvitation(invitation.token,'Member');}
  const member=value(joined),project=value(await host.call('projects.create',{name:'Live revocation',kind:'folder'}));
  value(await host.call('identity.share',{projectId:project.id,personId:member.person.id,access:'editor'}));
  const sent=value(await host.callAuthenticated(member.session,'turns.send',{projectId:project.id,text:'Wait for an answer',attachments:[],settings:{...settings,model:(await host.call('models.list',{}))[0].id},clientKey:randomUUID()}));
  await hangDetector(entering,'the named person reaches the held local model');
  if(directory)assert.equal((await scim('DELETE',`Users/${member.person.id}`)).status,204);else value(await host.call('identity.remove',{personId:member.person.id}));
  await assert.rejects(host.callAuthenticated(member.session,'threads.get',{id:sent.threadId,projectId:project.id} as {id:string}));
  await assert.rejects(host.callAuthenticated(member.session,'turns.send',{threadId:sent.threadId,projectId:project.id,text:'Retry after removal',attachments:[],settings,clientKey:randomUUID()}));
  release();const thread=await idle(host,sent.threadId);
  assert.notEqual(thread.turns[0].status,'done');assert.ok(!thread.turns[0].answer?.text.includes('LATE_IDENTITY_ANSWER'));
 }finally{release();await model.close();await provider.close();}
});
