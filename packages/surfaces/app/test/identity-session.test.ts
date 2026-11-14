import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RendererIdentitySessions } from '../electron/identity-session.ts';
import type { Host } from '@backbone-next/platform/composition';

test('a renderer binds its accepted session after draining drafts and never restores owner authority on empty or unknown sessions', async () => {
  const calls: string[]=[];
  const host={
    call:async()=>{calls.push('owner');return[];},callAuthenticated:async(token:string)=>{calls.push(token);return[];},
    on:()=>()=>{},onAuthenticated:()=>()=>{},
    acceptInvitation:async()=>{calls.push('accept');return{ok:true,value:{session:'bound-session',person:{id:'person',name:'Person',role:'guest',status:'active'}}};},
  } as unknown as Host;
  const sessions=new RendererIdentitySessions(host);
  sessions.bind({id:1,prepare:async()=>{calls.push('drain');return true;},reload:async()=>{calls.push('reload');},failed(){},event(){}},true);
  await sessions.call(1,'projects.list',{});
  await sessions.join(1,'one-use-invitation','Person');
  await sessions.call(1,'projects.list',{});
  assert.deepEqual(calls,['owner','drain','accept','reload','bound-session']);
  assert.equal(sessions.deviceOwner(1),false);
  await assert.rejects(sessions.call(99,'projects.list',{}));
  sessions.bind({id:2,prepare:async()=>true,reload:async()=>{},failed(){},event(){}},false);
  await assert.rejects(sessions.call(2,'projects.list',{}));
  assert.equal(sessions.deviceOwner(2),false);
});

test('device access repair refuses signed-in, signed-out and unknown windows before reaching the trusted Host method',async()=>{
 let repairs=0,available=false;
 const host={call:async()=>{throw Object.assign(new Error('Access ended'),{name:'IdentityRefused'});},deviceRecoveryStatus:async()=>({available}),restoreDeviceAccess:async()=>{repairs++;},on:()=>()=>{},onAuthenticated:()=>()=>{},acceptInvitation:async()=>({ok:true,value:{session:'colleague-session',person:{id:'colleague',name:'Colleague',role:'owner',status:'active'}}})} as unknown as Host;
 const sessions=new RendererIdentitySessions(host);
 const window=(id:number)=>({id,prepare:async()=>true,reload:async()=>{},failed(){},event(){}});
 sessions.bind(window(1),true);sessions.bind(window(2),false);sessions.bind(window(3),false);
 await sessions.join(3,'invitation','Colleague');
 for(const id of [2,3,99])await assert.rejects(sessions.restoreDeviceAccess(id));
 assert.equal(repairs,0);await assert.rejects(sessions.restoreDeviceAccess(1),/not available/);available=true;await assert.rejects(sessions.restoreDeviceAccess(1),/access failure/);await assert.rejects(sessions.call(1,'identity.get',{}));await sessions.restoreDeviceAccess(1);assert.equal(repairs,1);
});

test('native repair IPC checks the device binding and the failure state offers the plain recovery action',async()=>{
 const {readFileSync}=await import('node:fs');
 const main=readFileSync(new URL('../electron/main.ts',import.meta.url),'utf8');
 const repair=main.slice(main.indexOf("ipcMain.handle('identity-restore-device'"),main.indexOf("ipcMain.handle('identity-configuration'"));
 assert.match(repair,/refuseOthers\(e\)/);assert.match(repair,/identitySessions\.restoreDeviceAccess\(e\.sender\.id\)/);assert.match(repair,/app\.relaunch\(\)/);
 const page=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
 assert.match(page,/identityRecovery\?\.available&&<button[^>]*disabled=\{repairing\}/);
 assert.match(page,/>Restore my access on this Mac<\/button>/);
});
