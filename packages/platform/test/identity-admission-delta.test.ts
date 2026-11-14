import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {IdentityCore} from '../src/composition/identity-core.ts';
import {pendingTurnStops} from '../src/composition/turn-stops.ts';
import {hangDetector} from '../../../scripts/lib/test-hang.ts';
import {open,value,idle,settings} from './helpers.ts';

test('invalid-token Stops change nothing and cannot hold sends to their thread or an unrelated thread',async t=>{
 const {host}=open(),project=value(await host.call('projects.create',{name:'Stop isolation',kind:'folder'}));
 const first=value(await host.call('turns.send',{projectId:project.id,text:'First',attachments:[],settings,clientKey:randomUUID()}));await idle(host,first.threadId);
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),entering=new Promise<void>(resolve=>{entered=resolve;});
 const original=IdentityCore.prototype.admit,token='invalid-session-'+randomUUID();
 t.mock.method(IdentityCore.prototype,'admit',async function<T>(this:IdentityCore,...args:Parameters<typeof original<T>>){if(args[0]===token){entered();await gate;}return Reflect.apply(original,this,args);});
 const pending:Promise<unknown>[]=[];const invalid=()=>{pending.push(host.callAuthenticated(token,'turns.stop',{threadId:first.threadId}).then(()=>assert.fail('An invalid Stop was accepted'),()=>{}));};
 invalid();await entering;const timer=setInterval(invalid,15);
 const sends=Promise.all([host.call('turns.send',{projectId:project.id,threadId:first.threadId,text:'Continues',attachments:[],settings,clientKey:randomUUID()}),host.call('turns.send',{projectId:project.id,text:'Unrelated',attachments:[],settings,clientKey:randomUUID()})]);
 try{const results=await hangDetector(sends,'both sends complete while invalid Stop authentication remains held');for(const result of results)value(result);}
 finally{clearInterval(timer);release();await Promise.all(pending);await sends;}
 const continued=value((await sends)[0]);await idle(host,continued.threadId);
 const thread=value(await host.call('threads.get',{id:first.threadId}));assert.equal(thread.turns.length,2);assert.ok(thread.turns.every(turn=>turn.status==='done'&&!turn.stopRequested));
});

test('automation reuses one identity admission when an exclusive revocation is queued',async t=>{
 const {host}=open(),project=value(await host.call('projects.create',{name:'Automation admission',kind:'folder'}));
 const invitation=value(await host.call('identity.invite',{role:'member'})),member=value(await host.acceptInvitation(invitation.token,'Named member'));
 value(await host.call('identity.share',{projectId:project.id,personId:member.person.id,access:'editor'}));
 const automation=value(await host.call('identity.automation.create',{personId:member.person.id,projectId:project.id,name:'Admission fixture'}));
 const original=IdentityCore.prototype.admitPerson,scope=new AsyncLocalStorage<{active:boolean}>();let admissions=0;
 t.mock.method(IdentityCore.prototype,'admitPerson',async function<T>(this:IdentityCore,person:string,work:()=>Promise<T>){
  if(scope.getStore()?.active)throw new Error('A second shared lock would wait behind the queued revoker');
  admissions++;const held={active:true};
  return Reflect.apply(original,this,[person,async()=>{try{return await scope.run(held,work);}finally{held.active=false;}}]);
 });
 const sent=value(await host.call('identity.automation.run',{id:automation.id,text:'Check the admission'}));
 assert.equal(admissions,1,'the running admin and named person are checked under one shared admission');
 await idle(host,sent.threadId);
});

test('pending Stop waits snapshot one batch and expire rather than chasing replacement requests',async()=>{
 const stops=pendingTurnStops(20),end=stops.begin('thread'),waiting=stops.wait('thread');
 const later=stops.begin('thread');end();await waiting;
 assert.equal(stops.has('thread'),true,'a later Stop is not part of the completed wait snapshot');
 await stops.wait('thread');assert.equal(stops.has('thread'),true,'the deadline does not claim the Stop finished');
 later();assert.equal(stops.has('thread'),false);
});
