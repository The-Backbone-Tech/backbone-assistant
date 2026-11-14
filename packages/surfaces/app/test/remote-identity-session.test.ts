import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Host } from '@backbone-next/platform/composition';
import { RemoteClient, RemoteError } from '@backbone-next/platform/remote/client';
import { RendererIdentitySessions, type RemoteWorkspace } from '../electron/identity-session.ts';

function fixture() {
  const calls:string[]=[],events:unknown[]=[];let leaveError:Error|undefined;
  const host={call:async()=>{calls.push('owner');return[];},callAuthenticated:async()=>{calls.push('local member');return[];},on:()=>()=>{},onAuthenticated:()=>()=>{}} as unknown as Host;
  const client={target:{origin:'https://127.0.0.1:8443'},call:async()=>{calls.push('remote');return[];},async *events(signal:AbortSignal){await new Promise<void>(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true});});}} as unknown as RemoteClient;
  const remote={join:async()=>{calls.push('join');return{id:'person',name:'Colleague',role:'member',status:'active'};},client:async()=>client,leave:async()=>{if(leaveError)throw leaveError;calls.push('leave');}} as RemoteWorkspace;
  const sessions=new RendererIdentitySessions(host,async()=>remote);
  const window=(id:number)=>({id,prepare:async()=>{calls.push('drain');return true;},reload:async()=>{calls.push('reload');},failed(){},event:(value:unknown)=>events.push(value)});
  return {calls,events,sessions,client,window,failLeave:(error:Error)=>{leaveError=error;}};
}
test('remote joining drains drafts, routes only its window and keeps secrets out of its view',async()=>{
  const {sessions,window,calls}=fixture();
  try {
    sessions.bind(window(1),true);sessions.bind(window(2),false,true);
    await sessions.joinRemote(2,'private-link','Colleague');
    await sessions.call(1,'projects.list',{});await sessions.call(2,'projects.list',{});
    assert.deepEqual(calls.slice(0,5),['drain','join','reload','owner','remote']);
    assert.equal(sessions.deviceOwner(2),false);assert.equal(sessions.signedIn(2),true);
    assert.deepEqual(Object.keys(sessions.remoteView(2)!).sort(),['connection','origin']);
    await sessions.leaveRemote(2);await assert.rejects(sessions.call(2,'projects.list',{}),/Sign in/);assert.equal(sessions.deviceOwner(2),false);
    await sessions.call(1,'projects.list',{});assert.equal(calls.at(-1),'owner');
  } finally {sessions.close();sessions.forget(1);sessions.forget(2);}
});
test('uncertain leave preserves the route; confirmed access-ended alone ends it',async()=>{
  const {sessions,window,failLeave,client}=fixture();
  try {
    sessions.bind(window(2),false,true);await sessions.restoreRemote(2);
    failLeave(new RemoteError('Unknown sign-out','UNKNOWN'));await assert.rejects(sessions.leaveRemote(2));assert.equal(sessions.signedIn(2),true);
    client.call=async()=>{throw new RemoteError('Access ended.','REFUSED',403,true);};
    await assert.rejects(sessions.call(2,'projects.list',{}));assert.equal(sessions.signedIn(2),false);
    await assert.rejects(sessions.call(2,'projects.list',{}),/Sign in/);assert.equal(sessions.deviceOwner(2),false);
  } finally {sessions.close();sessions.forget(2);}
});
test('a temporary stream notice keeps the session and unknown sends are never retried',async()=>{
  const {sessions,window,client,events}=fixture();let sends=0;
  client.events=async function*(signal?:AbortSignal){yield {topic:'identity',urgent:'Temporary workspace problem. Retry shortly.'};await new Promise<void>(resolve=>signal?.addEventListener('abort',()=>resolve(),{once:true}));};
  client.call=async()=>{sends++;throw new RemoteError('The send outcome is unknown. Check the conversation.','UNKNOWN');};
  try {
    sessions.bind(window(2),false,true);await sessions.restoreRemote(2);await new Promise(resolve=>setImmediate(resolve));
    assert.equal(sessions.signedIn(2),true);assert.ok(events.length);
    const args={projectId:'p',text:'hello',attachments:[],settings:{permission:'full' as const,model:'stub',effort:3 as const,runsOn:'this-computer' as const,mode:'chat' as const},clientKey:'same-send'};
    await assert.rejects(sessions.call(2,'turns.send',args),/unknown/i);
    await assert.rejects(sessions.call(2,'turns.send',args),/unknown/i);assert.equal(sends,1);
  } finally {sessions.close();sessions.forget(2);}
});

test('overlapping joins cannot replace another window’s identity while drafts drain',async()=>{
  const {sessions,window,calls}=fixture();let release!:()=>void;
  try {
    sessions.bind({...window(2),prepare:async()=>{await new Promise<void>(resolve=>{release=resolve;});return true;}},false,true);sessions.bind(window(3),false,true);
    const first=sessions.joinRemote(2,'first','First');await new Promise(resolve=>setImmediate(resolve));
    await assert.rejects(sessions.joinRemote(3,'second','Second'));release();await first;
    assert.equal(calls.filter(value=>value==='join').length,1);assert.equal(sessions.signedIn(3),false);
    assert.throws(()=>sessions.deviceSignal(2),/Device owner/);
  }finally{sessions.close();sessions.forget(2);sessions.forget(3);sessions.forget(4);sessions.forget(5);}
});

test('temporary transport failure reconnects one stream and preserves access',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const {sessions,window,client,events}=fixture();let opens=0;
  client.events=async function*(signal?:AbortSignal){opens++;if(opens===1)throw new RemoteError('Temporary transport problem','UNKNOWN');yield {topic:'identity'};await new Promise<void>(resolve=>signal?.addEventListener('abort',()=>resolve(),{once:true}));};
  try {
    sessions.bind(window(2),false,true);await sessions.restoreRemote(2);await new Promise(resolve=>setImmediate(resolve));
    assert.equal(sessions.remoteView(2)?.connection,'temporary');assert.equal(sessions.signedIn(2),true);
    t.mock.timers.tick(5_000);await new Promise(resolve=>setImmediate(resolve));assert.equal(opens,2);assert.equal(sessions.remoteView(2)?.connection,'online');assert.equal(sessions.signedIn(2),true);assert.ok(events.length>=2);
  }finally{sessions.close();sessions.forget(2);}
});

test('a delayed access-ended error from the prior stream cannot end the newly joined session',async()=>{
  const {sessions,window,client}=fixture();let release!:()=>void,opens=0;
  client.events=async function*(signal?:AbortSignal){
    opens++;if(opens===1){await new Promise<void>(resolve=>{release=resolve;});throw new RemoteError('Old access ended','REFUSED',403,true);}
    await new Promise<void>(resolve=>signal?.addEventListener('abort',()=>resolve(),{once:true}));
  };
  try {
    sessions.bind(window(2),false,true);await sessions.restoreRemote(2);await sessions.joinRemote(2,'new-link','New colleague');release();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(sessions.signedIn(2),true);assert.notEqual(sessions.remoteView(2)?.connection,'ended');
  }finally{sessions.close();sessions.forget(2);}
});

test('company remote restore and join refuse unsigned people and another person; local sign-out ends the remote window',async()=>{
  const callbacks=new Map<string,(event:any)=>void>();let remoteCalls=0,joins=0;
  const host={on:()=>()=>{},onAuthenticated:(token:string,callback:(event:any)=>void)=>{callbacks.set(token,callback);return()=>callbacks.delete(token);},callAuthenticated:async(token:string)=>({ok:true,value:{person:{id:token,name:token,role:'member',status:'active'}}})} as unknown as Host;
  const client={target:{origin:'https://127.0.0.1:8443'},call:async()=>{remoteCalls++;return[];},async *events(signal:AbortSignal){await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));}} as unknown as RemoteClient;
  const workspace={owner:()=> 'a',appClient:async(owner:string)=>{assert.equal(owner,'a');return client;},client:async()=>client,join:async()=>{joins++;return{id:'remote',name:'Remote',role:'member',status:'active'};},leave:async()=>{throw new Error('Should not leave');}} as RemoteWorkspace;
  const sessions=new RendererIdentitySessions(host,async()=>workspace,true);
  const window=(id:number)=>({id,prepare:async()=>true,reload:async()=>{},failed(){},event(){}});
  const activate=(id:number,person:string)=>sessions.activate(id,async()=>({ok:true,value:{session:person,person:{id:person,name:person,role:'member',status:'active'}}}));
  try{
    sessions.bind(window(1),false);await assert.rejects(sessions.restoreRemote(1));await assert.rejects(sessions.joinRemote(1,'link','name'));
    sessions.bind(window(2),false);await activate(2,'b');await assert.rejects(sessions.restoreRemote(2));await assert.rejects(sessions.joinRemote(2,'link','Other'));assert.equal(joins,0);await assert.rejects(sessions.leaveRemote(2));
    sessions.bindWorkspace(window(4),2);await assert.rejects(sessions.restoreRemote(4),/person who joined/);await assert.rejects(sessions.joinRemote(4,'link','Other'),/person who joined/);assert.equal(joins,0);
    sessions.bind(window(5),false,true);await assert.rejects(sessions.restoreRemote(5),/Sign in locally/);await assert.rejects(sessions.joinRemote(5,'link','Unsigned'),/Sign in locally/);
    await activate(1,'a');sessions.bindWorkspace(window(3),1);await sessions.restoreRemote(3);
    await sessions.call(3,'projects.list',{});assert.equal(remoteCalls,1);
    callbacks.get('a')!({topic:'identity',urgent:'Access ended. Sign in again.'});
    assert.equal(sessions.signedIn(3),false);await assert.rejects(sessions.call(3,'projects.list',{}));assert.equal(remoteCalls,1);
  }finally{sessions.close();sessions.forget(1);sessions.forget(2);sessions.forget(3);sessions.forget(4);sessions.forget(5);}
});

test('company sign-in keeps local projects and only an explicitly opened workspace window restores the saved session',async()=>{
  const localCalls:string[]=[],callbacks=new Map<string,Set<(event:any)=>void>>();let admissions=0,remoteCalls=0;
  const host={on:()=>()=>{},onAuthenticated:(token:string,callback:(event:any)=>void)=>{const listeners=callbacks.get(token)??new Set();listeners.add(callback);callbacks.set(token,listeners);return()=>listeners.delete(callback);},callAuthenticated:async(token:string,method:string)=>{if(method==='identity.get'){admissions++;return{ok:true,value:{person:{id:token}}};}localCalls.push(token);return[];}} as unknown as Host;
  const client={target:{origin:'https://127.0.0.1:8443'},call:async()=>{remoteCalls++;return[];},async *events(signal:AbortSignal){await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));}} as unknown as RemoteClient;
  const workspace={owner:()=> 'a',appClient:async()=>client,client:async()=>client} as RemoteWorkspace;
  const sessions=new RendererIdentitySessions(host,async()=>workspace,true);
  const window=(id:number)=>({id,prepare:async()=>true,reload:async()=>{},failed(){},event(){}});
  const activate=(id:number,person:string)=>sessions.activate(id,async()=>({ok:true,value:{session:person,person:{id:person,name:person,role:'member',status:'active'}}}));
  try{
    sessions.bind(window(1),false);await activate(1,'a');assert.equal(sessions.remoteView(1),undefined);
    await sessions.call(1,'projects.list',{});assert.deepEqual(localCalls,['a']);
    await assert.rejects(sessions.restoreRemote(1),/dedicated workspace window/);
    await assert.rejects(sessions.joinRemote(1,'link','Name'),/dedicated workspace window/);
    sessions.bindWorkspace(window(2),1);await sessions.restoreRemote(2);const resolved=admissions;assert.equal(resolved,1);
    await sessions.call(2,'projects.list',{});await sessions.call(2,'threads.list',{});assert.equal(admissions,resolved);assert.equal(remoteCalls,2);
    await sessions.call(1,'projects.list',{});assert.deepEqual(localCalls,['a','a']);
    const stale=[...callbacks.get('a')!];
    await activate(2,'b');assert.equal(sessions.remoteView(2),undefined);
    for(const callback of stale)callback({topic:'identity',urgent:'Access ended. Sign in again.'});
    await sessions.call(2,'projects.list',{});assert.equal(localCalls.at(-1),'b');
    sessions.bindWorkspace(window(3),2);await assert.rejects(sessions.restoreRemote(3),/person who joined/);assert.equal(admissions,resolved+1);
    await activate(1,'a');assert.equal(sessions.remoteView(1),undefined);
    sessions.bindWorkspace(window(4),1);await sessions.restoreRemote(4);
    for(const callback of [...callbacks.get('a')!])callback({topic:'identity',urgent:'Access ended. Sign in again.'});
    await assert.rejects(sessions.call(4,'projects.list',{}));assert.equal(remoteCalls,2);
  }finally{sessions.close();for(const id of [1,2,3,4])sessions.forget(id);}
});

test('a same-Mac member cannot join or open a workspace as the device owner',async()=>{
  const {sessions,window,calls}=fixture();
  try{
    sessions.bind(window(1),true);sessions.bind(window(2),false);
    await sessions.activate(2,async()=>({ok:true,value:{session:'member',person:{id:'member',name:'Member',role:'member',status:'active'}}}));
    await assert.rejects(sessions.joinRemote(2,'link','Member'),/device owner/);
    assert.throws(()=>sessions.bindWorkspace(window(3),2),/device owner/);
    assert.equal(calls.includes('join'),false);
    sessions.bindWorkspace(window(4),1);await sessions.joinRemote(4,'link','Owner');assert.equal(calls.includes('join'),true);
  }finally{sessions.close();for(const id of [1,2,3,4])sessions.forget(id);}
});

test('remote polling resolves its company owner once and local access end invalidates that binding',async()=>{
  let admissions=0,remoteCalls=0;let ended:((event:any)=>void)|undefined;
  const host={on:()=>()=>{},onAuthenticated:(_token:string,callback:(event:any)=>void)=>{ended=callback;return()=>{};},callAuthenticated:async()=>{admissions++;return{ok:true,value:{person:{id:'a'}}};}} as unknown as Host;
  const client={target:{origin:'https://127.0.0.1:8443'},call:async()=>{remoteCalls++;return[];},async *events(signal:AbortSignal){await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));}} as unknown as RemoteClient;
  const sessions=new RendererIdentitySessions(host,async()=>({owner:()=> 'a',client:async()=>client} as RemoteWorkspace),true);
  try{
    sessions.bind({id:1,prepare:async()=>true,reload:async()=>{},failed(){},event(){}},false,true);
    await sessions.activate(1,async()=>({ok:true,value:{session:'token',person:{id:'a',name:'A',role:'member',status:'active'}}}));
    sessions.bindWorkspace({id:2,prepare:async()=>true,reload:async()=>{},failed(){},event(){}},1);await sessions.restoreRemote(2);
    const resolved=admissions;
    await sessions.call(2,'projects.list',{});await sessions.call(2,'threads.list',{});
    assert.equal(admissions,resolved);assert.equal(remoteCalls,2);
    ended!({topic:'identity',urgent:'Access ended. Sign in again.'});
    await assert.rejects(sessions.call(2,'projects.list',{}));assert.equal(remoteCalls,2);
  }finally{sessions.close();sessions.forget(1);sessions.forget(2);}
});

test('a company person joins from a dedicated window while their local window keeps working',async()=>{
  let joins=0,admissions=0,localCalls=0,leaves=0,releases=0;let savedOwner:string|undefined;
  const person={id:'local-person',name:'Person',role:'member' as const,status:'active' as const};
  const host={on:()=>()=>{},onAuthenticated:()=>()=>{},callAuthenticated:async(_token:string,method:string)=>{if(method==='identity.get'){admissions++;return{ok:true,value:{person}};}localCalls++;return[];}} as unknown as Host;
  const client={target:{origin:'https://127.0.0.1:8443'},call:async()=>[],async *events(signal:AbortSignal){await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));}} as unknown as RemoteClient;
  const workspace={owner:()=>savedOwner,join:async(_link:string,_name:string,owner:string)=>{joins++;savedOwner=owner;return person;},client:async()=>client,leave:async(owner:string)=>{assert.equal(owner,person.id);leaves++;},releaseAppSend:async(owner:string)=>{assert.equal(owner,person.id);releases++;}} as RemoteWorkspace;
  const sessions=new RendererIdentitySessions(host,async()=>workspace,true);
  const window=(id:number)=>({id,prepare:async()=>true,reload:async()=>{},failed(){},event(){}});
  try{
    sessions.bind(window(1),false);await sessions.activate(1,async()=>({ok:true,value:{session:'local-token',person}}));
    sessions.bindWorkspace(window(2),1);await assert.rejects(sessions.call(2,'projects.list',{}),/Sign in/);
    await sessions.joinRemote(2,'link','Name');assert.equal(joins,1);assert.equal(savedOwner,person.id);
    await sessions.call(1,'projects.list',{});assert.equal(localCalls,1);assert.equal(sessions.remoteView(1),undefined);
    await sessions.call(2,'projects.list',{});await sessions.releaseRemoteSend(2,'checked');await sessions.leaveRemote(2);
    assert.equal(admissions,1);assert.equal(releases,1);assert.equal(leaves,1);
    await sessions.call(1,'projects.list',{});assert.equal(localCalls,2);
  }finally{sessions.close();sessions.forget(1);sessions.forget(2);}
});
