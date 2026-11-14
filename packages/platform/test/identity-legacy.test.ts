import assert from 'node:assert/strict';
import {test} from 'node:test';
import {IdentityCore,IdentityUnavailable,LegacyIdentityUnavailable} from '../src/composition/identity-core.ts';
import {createIdentityHost,type IdentityHostDeps} from '../src/composition/identity-host.ts';
import {freshHome,open,value} from './helpers.ts';
import {CoreLink} from '../src/composition/core.ts';
import {hostClosed} from '../src/composition/host.ts';
import {DEFAULT_PREFS} from '../src/api.ts';
function boundary(solo:boolean){
 const actor={workspace:'workspace',person:'owner',system:'system',agent:'agent',mandate:'mandate'};
 const identities=new IdentityCore(async()=>assert.fail('C1 must not connect while paused'),actor,()=>actor,async(_actor,work)=>work());
 const project={id:'legacy-project',name:'Legacy project'};
 const deps:IdentityHostDeps={home:freshHome(),readOnly:false,link:async()=>({identities,identityStatus:{state:'paused'},legacyDeviceOnly:async()=>solo,legacyDeviceCall:async<T>(work:()=>Promise<T>)=>solo?{legacy:true,value:await work()}:{legacy:false}}) as never,projects:()=>[],threads:new Map(),summary:async thread=>thread.summary,material:{} as never,piece:()=>null,nativeEngine:()=>false,emit(){assert.fail('No C1 mutation');},abort(){assert.fail('No C1 mutation');},on:()=>()=>{},dispatch:(async()=>[project]) as IdentityHostDeps['dispatch']};
 return {adapter:createIdentityHost(deps),deps,project};
}
test('a confirmed sole-device home keeps legacy reads while every C1 or authenticated entry stays paused',async()=>{
 const {adapter,project}=boundary(true);
 assert.deepEqual(await adapter.call(undefined,'projects.list',{}),[project]);
 await assert.rejects(adapter.call(undefined,'identity.get',{}),error=>error instanceof LegacyIdentityUnavailable&&error.reason==='paused');
 await assert.rejects(adapter.call('fixture-session','projects.list',{}),error=>error instanceof IdentityUnavailable);
 await assert.rejects(adapter.call(undefined,'identity.invite',{role:'member'}),error=>error instanceof IdentityUnavailable);
});
test('a home with past or current other people cannot take the legacy device path',async()=>{
 const {adapter}=boundary(false);
 await assert.rejects(adapter.call(undefined,'projects.list',{}),error=>error instanceof IdentityUnavailable&&!(error instanceof LegacyIdentityUnavailable));
});
test('legacy dispatch retains the original key or home refusal when Core cannot open',async()=>{
 const {deps}=boundary(true),failure=Object.assign(new Error('Fixture key refusal'),{name:'KeysRefused'});
 deps.link=async()=>{throw failure;};deps.dispatch=async()=>{throw failure;};
 await assert.rejects(createIdentityHost(deps).call(undefined,'projects.list',{}),error=>error===failure);
});
test('close drains an admitted identity lookup before closing its Core pool',async t=>{
 const {host,home}=open();value(await host.call('projects.create',{name:'Close control',kind:'folder'}));
 const original=CoreLink.prototype.legacyDeviceOnly;
 let enter!:()=>void,release!:()=>void;
 const entered=new Promise<void>(resolve=>{enter=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
 t.mock.method(CoreLink.prototype,'legacyDeviceOnly',async function(this:CoreLink){enter();await held;return original.call(this);});
 const pending=host.call('projects.list',{});const outcome=pending.then(()=>false,()=>true);await entered;
 host.close();let closed=false;const stopped=hostClosed(home).then(()=>{closed=true;});
 await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(closed,false,'an admitted call must settle before pool shutdown');
 release();assert.equal(await outcome,true,'the close recheck refuses late publication');await stopped;
});
test('enabling a second person preserves the device owner preferences without sharing them',async()=>{
 const {host}=open(),prefs={...DEFAULT_PREFS,theme:'dark' as const};
 value(await host.call('identity.get',{}));
 const project=value(await host.call('projects.create',{name:'Created after identity startup',kind:'folder'}));
 await host.call('viewer.put',{prefs});
 const invitation=value(await host.call('identity.invite',{role:'guest'}));
 const guest=value(await host.acceptInvitation(invitation.token,'Second person'));
 value(await host.call('identity.share',{projectId:project.id,personId:guest.person.id,access:'viewer'}));
 assert.ok((await host.callAuthenticated(guest.session,'projects.list',{})).some(row=>row.id===project.id));
 assert.deepEqual(await host.call('viewer.get',{}),prefs);
 assert.deepEqual(await host.callAuthenticated(guest.session,'viewer.get',{}),DEFAULT_PREFS);
});

test('a sole-device request keeps account acceptance outside its admission until it settles',async t=>{
 const {host}=open();value(await host.call('identity.get',{}));
 const invitation=value(await host.call('identity.invite',{role:'guest'}));
 const original=CoreLink.prototype.legacyDeviceOnly;
 let enter!:(link:CoreLink)=>void,release!:()=>void,heldOnce=false;
 const entered=new Promise<CoreLink>(resolve=>{enter=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
 t.mock.method(CoreLink.prototype,'legacyDeviceOnly',async function(this:CoreLink){
  const solo=await original.call(this);
  if(solo&&!heldOnce){heldOnce=true;enter(this);await held;}
  return solo;
 });
 const pending=host.call('projects.list',{}),link=await entered;
 try{
  const probe=await link.read<{acquired:boolean}>(link.worker(),"SELECT pg_try_advisory_xact_lock(hashtextextended('identity:'||$1,17)) AS acquired",[link.id.workspace]);
  assert.equal(probe.rows[0]?.acquired,false,'account acceptance must wait for the sole-device request');
 }finally{release();await pending;}
 assert.ok(value(await host.acceptInvitation(invitation.token,'Second person')).session);
});
