import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createIdentityHost,type IdentityHostDeps} from '../src/composition/identity-host.ts';
import {withIdentityLocal} from '../src/composition/identity-local.ts';
import {withHomeLock} from '../src/composition/home-lock.ts';
import type {CoreLink} from '../src/composition/core.ts';
import type {StoredThread} from '../src/composition/thread-journal.ts';
import type {Project,WorkNow} from '../src/api.ts';
import {freshHome} from './helpers.ts';

test('a shared project Now view withholds owner connector actions while retaining ordinary notices',async()=>{
 const viewer={id:'viewer',name:'Viewer',role:'guest',status:'active'};
 const link={id:{person:'viewer'},person:()=>({}),identities:{requireReady(){},devicePerson:'owner',admit:async(_token:string,work:(person:typeof viewer)=>Promise<unknown>)=>work(viewer)},read:async()=>({rows:[{access:'viewer'}]})} as unknown as CoreLink;
 const now={needsYou:[{kind:'connector',title:'PERSONAL_CONNECTOR_CANARY',detail:'Owner pending action'},{kind:'connector-read',title:'PERSONAL_CONNECTOR_CANARY',detail:'Owner read question'},{kind:'stopped',title:'Stopped work',detail:'Inspect the stopped turn'}]} as WorkNow;
 const identity=createIdentityHost({home:freshHome(),readOnly:true,link:async()=>link,projects:()=>[{id:'shared'} as Project],threads:new Map(),summary:async thread=>thread.summary,material:{} as IdentityHostDeps['material'],piece:()=>null,nativeEngine:()=>false,emit(){},abort(){},on:()=>()=>{},dispatch:(async()=>now) as IdentityHostDeps['dispatch']});
 const view=await identity.call('session','work.now',{projectId:'shared'});
 assert.doesNotMatch(JSON.stringify(view),/PERSONAL_CONNECTOR_CANARY/);
 assert.deepEqual(view.needsYou.map(item=>item.kind),['stopped']);
 assert.equal(now.needsYou.length,3,'filtering a viewer does not remove the owner pending actions');
});

test('a resource moved during a home lock wait refuses before the local write and the guard expires with its request',async()=>{
 const home=freshHome();let project='authorized',writes=0,entered!:()=>void,release!:()=>void;
 const held=new Promise<void>(resolve=>{release=resolve;}),holding=new Promise<void>(resolve=>{entered=resolve;});
 const holder=withHomeLock(home,async()=>{entered();await held;project='private';});await holding;
 let releaseLate!:()=>void,detached!:Promise<void>;const late=new Promise<void>(resolve=>{releaseLate=resolve;});
 const request=withIdentityLocal(home,()=>{assert.equal(project,'authorized');},()=>{detached=late.then(()=>withHomeLock(home,async()=>{writes++;}));return withHomeLock(home,async()=>{writes++;});});
 const rejected=assert.rejects(request);release();await holder;await rejected;assert.equal(writes,0);
 releaseLate();await detached;assert.equal(writes,1);
 await withHomeLock(home,async()=>{writes++;});assert.equal(writes,2);
});

test('a committed write keeps its receipt after a resource moves but a read still refuses changed content',async()=>{
 const person={id:'member',name:'Member',role:'member',status:'active'};
 const thread={summary:{id:'thread',projectId:'shared'},personId:person.id} as StoredThread;
 const link={id:{person:person.id},person:()=>({}),identities:{requireReady(){},devicePerson:'owner',admit:async(_token:string,work:(actor:typeof person)=>Promise<unknown>)=>work(person)},read:async()=>({rows:[{access:'editor'}]})} as unknown as CoreLink;
 let committed=false;const projects:Project[]=[],threads=new Map<string,StoredThread>();
 const identity=createIdentityHost({home:freshHome(),readOnly:false,link:async()=>link,projects:()=>projects,threads,summary:async t=>t.summary,material:{} as IdentityHostDeps['material'],piece:()=>null,nativeEngine:()=>false,emit(){},abort(){},on:()=>()=>{},dispatch:(async(method:string)=>{if(method==='models.list')return[];committed=true;thread.summary.projectId='moved';return method==='threads.get'?{secret:'changed content'}:{ok:true,value:{...thread.summary}};}) as IdentityHostDeps['dispatch']});
 await identity.call('session','models.list',{});projects.push({id:'shared'} as Project);threads.set('thread',thread);
 const receipt=await identity.call('session','threads.update',{id:'thread',patch:{title:'Committed rename'}});
 assert.equal(committed,true);assert.equal(receipt.ok,true,'a committed rename must not be relabeled refused');
 thread.summary.projectId='shared';
 await assert.rejects(identity.call('session','threads.get',{id:'thread'}),'a read may not return substituted content');
});
