import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { CoreLink } from '../src/composition/core.ts';
import { withHomeLock,inActiveHomeLockScope } from '../src/composition/home-lock.ts';
import { hangDetector } from '../../../scripts/lib/test-hang.ts';
import { open,value,idle,settings } from './helpers.ts';

test('turn admission opens and crosses Core outside the home lock and keeps a repeated client key on one turn',async t=>{
  const opening=CoreLink.open;
  t.mock.method(CoreLink,'open',function(...args:Parameters<typeof opening>){
    assert.equal(inActiveHomeLockScope(args[0].home),false,'Core opened while the home lock is held');
    return Reflect.apply(opening,CoreLink,args);
  });
  const {host,home}=open();
  const project=value(await host.call('projects.create',{name:'Unlocked reservation',kind:'folder'}));
  let crossings=0;
  for(const method of ['call','read'] as const){
    const original=CoreLink.prototype[method];
    t.mock.method(CoreLink.prototype,method,function(this:CoreLink,...args:Parameters<typeof original>){
      assert.equal(inActiveHomeLockScope(home),false,'Core crossing awaited while the home lock is held');
      crossings++;return Reflect.apply(original,this,args);
    });
  }
  const args={projectId:project.id,text:'Write a brief',attachments:[],settings,clientKey:randomUUID()};
  const receipts=await Promise.all([host.call('turns.send',args),host.call('turns.send',args)]);
  const first=value(receipts[0]);assert.deepEqual(value(receipts[1]),first);
  await idle(host,first.threadId);
  assert.ok(crossings>0);
  const next=value(await host.call('turns.send',{...args,threadId:first.threadId,clientKey:randomUUID()}));
  await idle(host,next.threadId);
  const destination=value(await host.call('projects.create',{name:'Moved conversation',kind:'folder'}));
  value(await host.call('threads.update',{id:next.threadId,patch:{projectId:destination.id}}));
  value(await host.call('threads.delete',{id:next.threadId}));
});

test('Core preparation releases the home for withdrawal and revalidates the attachment before reserving a turn',async t=>{
  const {host,home}=open();
  const project=value(await host.call('projects.create',{name:'Concurrent withdrawal',kind:'folder'}));
  const file=value(await host.call('material.attach',{projectId:project.id,name:'input.txt',base64:Buffer.from('Human source').toString('base64'),mediaType:'text/plain'}));
  let entered!:()=>void,release!:()=>void;
  const entering=new Promise<void>(resolve=>{entered=resolve;});
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const create=CoreLink.prototype.createTask;
  t.mock.method(CoreLink.prototype,'createTask',async function(this:CoreLink,...args:Parameters<typeof create>){entered();await gate;return Reflect.apply(create,this,args);});
  const send=host.call('turns.send',{projectId:project.id,text:'Use the source',attachments:[file.id],settings,clientKey:randomUUID()});
  try{
    await hangDetector(entering,'turn reaches Core preparation');
    await hangDetector(withHomeLock(home,async()=>{assert.equal(inActiveHomeLockScope(home),true);}), 'a different local writer obtains the home during Core preparation');
    value(await host.call('material.lifecycle',{id:file.id,version:file.current,state:'withdrawn',lifecycle:file.lifecycle??0}));
  }finally{release();}
  assert.equal((await send).ok,false);
  assert.deepEqual(await host.call('threads.list',{}),[],'no turn or producer is reserved from a withdrawn source');
});

test('concurrent sends leave admission capacity for an authenticated Stop',async t=>{
  const {host}=open();const project=value(await host.call('projects.create',{name:'Stop capacity',kind:'folder'}));
  const first=value(await host.call('turns.send',{projectId:project.id,text:'First',attachments:[],settings,clientKey:randomUUID()}));await idle(host,first.threadId);
  let entered!:()=>void,release!:()=>void;
  const entering=new Promise<void>(resolve=>{entered=resolve;});const gate=new Promise<void>(resolve=>{release=resolve;});
  const say=CoreLink.prototype.say;
  t.mock.method(CoreLink.prototype,'say',async function(this:CoreLink,...args:Parameters<typeof say>){if(args[1]==='Pending'){entered();await gate;}return Reflect.apply(say,this,args);});
  const args={projectId:project.id,threadId:first.threadId,text:'Pending',attachments:[],settings,clientKey:randomUUID()};
  const sends=Array.from({length:8},()=>host.call('turns.send',args));
  try{await hangDetector(entering,'concurrent sends reach preparation');await hangDetector(host.call('turns.stop',{threadId:first.threadId}),'Stop authenticates while sends wait');}finally{release();}
  assert.ok((await Promise.all(sends)).every(result=>!result.ok));
  assert.equal(value(await host.call('threads.get',{id:first.threadId})).turns.length,1);
});
