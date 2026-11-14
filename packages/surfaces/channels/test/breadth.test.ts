import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHost, removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { startScriptedModel } from '@backbone-next/platform/testing';
import { startChannels, serveChannels } from '../src/index.ts';
import { breadthEndpoint, breadthRequest, discordMessage, teamsMessage, verifyRelay } from './breadth-fixtures.ts';

for(const provider of ['discord','teams'] as const)test(`${provider} authenticates and binds a private conversation, runs one Host turn, replies and survives restart`,async()=>{
 const home=freshDataHome(`channel-${provider}`),fake=await breadthEndpoint();
 const model=await startScriptedModel(`breadth-${provider}`,()=>({text:'A completed channel job.'}));
 process.env.BACKBONE_MODEL_ENDPOINT=model.url;process.env.BACKBONE_MODEL_ID=model.model;
 const host=createHost({home,harness:'harness-pi'});let service:Awaited<ReturnType<typeof startChannels>>|undefined;
 try{
  const project=await host.call('projects.create',{name:'Channel breadth',kind:'folder'});assert.ok(project.ok);
  const options={home,projectId:project.value.id,settings:{permission:'ask',model:model.model,effort:3,mode:'chat',runsOn:'this-computer'} as const,
   ...(provider==='discord'?{discord:{token:'fake-discord-token',applicationId:'app-id',publicKey:'a'.repeat(64),apiUrl:fake.url}}:{teams:{appId:'app-id',password:'synthetic-password',tenantId:'tenant-one',apiUrl:fake.url,token:()=> `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')}.synthetic`,webhookVerifier:verifyRelay}})};
  const payload=(id:number,text:string,extra={})=>provider==='discord'?discordMessage(id,text,extra):teamsMessage(id,text,fake.url,extra);
  service=await startChannels(host,options);
  const emit=(id:number,text:string,extra={},valid=true)=>service!.webhook(provider,breadthRequest(provider,payload(id,text,extra),valid));
  assert.equal((await emit(1,'spoof',{},false)).status,401);assert.equal(service.ledger.intakeCount(),0);
  await emit(2,'group',provider==='discord'?{guild_id:'guild-one',channel_type:0}:{conversation:{id:'19:group',conversationType:'groupChat'}});
  await service.idle();assert.equal(service.ledger.intakeCount(),0);assert.equal(fake.posts().length,0);
  await emit(3,service.ledger.invite());await service.idle();
  assert.equal(service.ledger.bound(provider,provider==='teams'?'tenant-one:U1':'U1'),true);
  assert.equal((await emit(4,'Do this work')).status,200);await emit(4,'Do this work');
  for(let n=0;n<600;n++){const threads=await host.call('threads.list',{});if(threads.length){const view=await host.call('threads.get',{id:threads[0].id});if(view.ok&&view.value.turns.some(t=>t.completed))break;}await new Promise(r=>setTimeout(r,10));}
  await service.idle();const threads=await host.call('threads.list',{});assert.equal(threads.length,1);
  const view=await host.call('threads.get',{id:threads[0].id});assert.ok(view.ok);assert.equal(view.value.turns.length,1);assert.equal(view.value.turns[0].answer?.text,'A completed channel job.');
  const replies=()=>fake.posts().filter(r=>[r.body.text,r.body.content].includes('A completed channel job.'));
  assert.equal(replies().length,1,JSON.stringify(fake.requests));
  await service.close();service=await startChannels(host,options);await emit(4,'Do this work');await service.idle();assert.equal(replies().length,1,JSON.stringify(fake.requests));
  const listener=await serveChannels(service,0);
  try {assert.equal((await fetch(`http://127.0.0.1:${listener.port}/channels/${provider}`,{method:'POST',body:'{}'})).status,401);}finally{await listener.close();}
 }finally{await service?.close();host.close();await removeDataHome(home);await fake.close();await model.close();delete process.env.BACKBONE_MODEL_ENDPOINT;delete process.env.BACKBONE_MODEL_ID;}
});
