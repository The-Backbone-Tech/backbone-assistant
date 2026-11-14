import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RendererIdentitySessions } from '../electron/identity-session.ts';
import { createViewerLayoutWriter } from '../src/lib/viewer-layout.ts';
import type { Host } from '@backbone-next/platform/composition';
import type { ApiEvent } from '@backbone-next/platform';

test('revocation retains a pending layout locally and close drains without using the ended session',async()=>{
  let event!:(event:ApiEvent)=>void,requests=0;
  const host={on:()=>()=>{},onAuthenticated:(_token:string,listener:typeof event)=>{event=listener;return()=>{};},acceptInvitation:async()=>({ok:true,value:{session:'bound-session',person:{id:'viewer',name:'Viewer',role:'guest',status:'active'}}}),callAuthenticated:async()=>{requests++;return{};}} as unknown as Host;
  const retained:string[]=[];
  const sessions=new RendererIdentitySessions(host);
  const writer=createViewerLayoutWriter<string>({delay:60_000,write:async prefs=>{await sessions.call(1,'viewer.put',{prefs:JSON.parse(prefs)});},retain:prefs=>{retained.push(prefs);}});
  sessions.bind({id:1,prepare:async()=>true,reload:async()=>{},failed(){},event:message=>{if(message.topic==='identity'&&message.urgent)void writer.endAccess();}},false);
  await sessions.join(1,'invitation','Viewer');
  const saved=writer.set('viewer',JSON.stringify({selectedProjectId:'shared-project'}));
  event({topic:'identity',urgent:'Access ended'});
  await writer.flush();await saved;
  assert.equal(sessions.signedIn(1),false);assert.equal(requests,0);
  assert.deepEqual(retained,[JSON.stringify({selectedProjectId:'shared-project'})]);
  await assert.rejects(sessions.call(1,'projects.list',{}));
});

test('an in-flight refused layout is retained on revocation without retrying its unknown request',async()=>{
  let fail!:(error:Error)=>void,entered!:()=>void;
  const entering=new Promise<void>(resolve=>{entered=resolve;});
  const flight=new Promise<void>((_,reject)=>{fail=reject;});
  const retained:string[]=[];let writes=0;
  const writer=createViewerLayoutWriter<string>({delay:60_000,write:async()=>{writes++;entered();await flight;},retain:prefs=>{retained.push(prefs);}});
  const pending=writer.set('viewer','latest layout'),flush=writer.flush();await entering;
  const retired=writer.endAccess();fail(new Error('The session ended'));
  await Promise.all([pending,flush,retired]);
  assert.equal(writes,1);assert.deepEqual(retained,['latest layout']);
});

test('an ordinary persistence failure still blocks layout drain and keeps the original pending value',async()=>{
  const writer=createViewerLayoutWriter<string>({delay:60_000,write:async()=>{throw new Error('Storage unavailable');},retain:()=>{assert.fail('Access has not ended');}});
  const pending=writer.set('viewer','unchanged');void pending.catch(()=>{});
  await assert.rejects(writer.flush(),/Storage unavailable/);assert.equal(writer.get('viewer'),'unchanged');
});

test('retained layout belongs to its person across sign-ins in the same window',async()=>{
 const entries=new Map<string,string>(),storage={getItem:(key:string)=>entries.get(key)??null,setItem:(key:string,value:string)=>{entries.set(key,value);},removeItem:(key:string)=>{entries.delete(key);}};
 const {retainedViewerLayout}=await import('../src/lib/viewer-layout.ts');
 const retained=retainedViewerLayout<{selectedThreadId:string}>(storage),prefs={selectedThreadId:'person-A-private-thread'};
 const writer=createViewerLayoutWriter<typeof prefs>({delay:60_000,write:async()=>assert.fail('Retired identity must not be used'),retain:value=>retained.retain('person-A',value)});
 const saving=writer.set('viewer',prefs);await writer.endAccess();await saving;
 assert.equal(retained.read('person-B'),undefined);
 retained.clear('person-B');assert.deepEqual(retained.read('person-A'),prefs);
 storage.setItem('viewer-left',JSON.stringify(prefs));assert.equal(retained.read('person-C'),undefined,'an old unbound layout cannot be assigned to a new person');
});
