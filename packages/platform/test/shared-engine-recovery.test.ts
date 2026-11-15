import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { withHomeLock, assertHomeWriteAdmission } from '../src/composition/home-lock.ts';
import { createIdentityHost, type IdentityHostDeps } from '../src/composition/identity-host.ts';
import { pieceOnDisk, PIECE_DIRS, PIECES } from '../src/composition/pieces.ts';
import { recoveryRefusal, IdentityRefused, SharedEngineRequired, PersonalConversationRequired } from '../src/composition/identity-core.ts';
import { createSharedEngine } from '../src/composition/shared-engine.ts';
import { applyEvent, ThreadJournal, type StoredThread } from '../src/composition/thread-journal.ts';
import type { CoreLink } from '../src/composition/core.ts';
import { CredentialStore } from '../src/credentials/store.ts';
import type { Turn } from '../src/api.ts';
import { freshHome } from './helpers.ts';

for (const actor of ['owner','colleague','automation']) test(`recovery retains shared carrier for ${actor} and rechecks live access`, async () => {
  let shared = false, access = 'editor', invoked = 0, required = false;
  const person = actor === 'owner' ? 'owner' : 'colleague';
  const automation = {id:'automation',person,project:'project',revoked:false};
  const thread = {summary:{id:'thread',projectId:'project'},personId:person,...(actor === 'automation' ? {automationId:'automation'} : {}),turns:[],sideTurns:[],clientKeys:[]} as unknown as StoredThread;
  const link = {id:{workspace:'workspace',person}, deviceAvailable:false, person:()=>({}),
    identities:{devicePerson:'owner',requireReady(){},admitPerson:async (_person:string,work:()=>Promise<void>)=>work(),asPerson:async (_person:string,work:()=>Promise<void>,piece:string)=>{assert.equal(piece,'shared-piece');return work();},asAutomation:async (_automation:unknown,work:()=>Promise<void>)=>{assert.equal(shared,true);return work();}},
    read:async (_actor:unknown,sql:string)=>({rows:sql.includes('identity_automations') ? [automation] : [{access}]})} as unknown as CoreLink;
  const adapter = createIdentityHost({home:freshHome(),readOnly:false,link:async()=>link,projects:()=>[],threads:new Map(),summary:async t=>t.summary,material:{} as IdentityHostDeps['material'],piece:()=>shared?'shared-piece':'personal-piece',nativeEngine:()=>false,
    sharedWork:async (work,needsShared)=>{required=!!needsShared;shared=true;try{return await work();}finally{shared=false;}},emit(){},abort(){},on:()=>()=>{},dispatch:async()=>assert.fail('recovery cannot dispatch a replacement send')});
  await adapter.resumeAsActor(thread,async()=>{assert.equal(shared,true);invoked++;},true);
  assert.equal(required,true); assert.equal(invoked,1);
  access = 'viewer';
  await assert.rejects(adapter.resumeAsActor(thread,async()=>{invoked++;},true),/identity or project permission/);
  assert.equal(invoked,1);
});

test('a shared turn cannot recover on a personal route after the shared choice is cleared', async () => {
  const home = freshHome();
  const engine = createSharedEngine({home},new CredentialStore(home,async()=>randomBytes(32)),()=>true);
  let ran = false;
  await assert.rejects(engine.run(async()=>{ran=true;},true),/was not sent.*shared model/);
  assert.equal(ran,false);
});

test('journal replay restores shared provenance even when the thread cache lost it', async () => {
  const home = freshHome();
  const turn = {id:'turn',status:'running',sharedEngine:'harness-pi',user:{text:'Work'},work:{steps:[]},effects:[]} as unknown as Turn;
  const thread = {summary:{id:'thread',projectId:'project'},turns:[{...turn,sharedEngine:undefined}],sideTurns:[],clientKeys:['key']} as unknown as StoredThread;
  const threads = new Map([['thread',thread]]);
  const journal = new ThreadJournal(home);
  await withHomeLock(home,async()=>{assertHomeWriteAdmission(home);journal.append({kind:'turn.reserved',threadId:'thread',turn,clientKey:'key',created:{summary:thread.summary}});});
  journal.rebuild(threads);
  assert.equal(threads.get('thread')?.turns[0].sharedEngine,'harness-pi');
  applyEvent(threads,{kind:'turn.reserved',threadId:'thread',turn:{...turn,sharedEngine:undefined},clientKey:'key'});
  assert.equal(threads.get('thread')?.turns[0].sharedEngine,undefined,'only the durable reservation decides');
});


test('shared dispatch refuses an unconfigured tool-bringing owner engine even without a caller precheck', async () => {
  const home = freshHome();
  const engine = createSharedEngine({home},new CredentialStore(home,async()=>Buffer.alloc(32,1)),()=>false);
  let ran = false;
  await assert.rejects(engine.run(async()=>{ran=true;}),/was not sent/);
  assert.equal(ran,false);
});

for (const lost of ['route','key']) test(`a colleague resume refuses when the shared ${lost} disappears after the caller check`, async () => {
  const home=freshHome(),credentials=new CredentialStore(home,async()=>Buffer.alloc(32,2));
  const engine=createSharedEngine({home},credentials,()=>false);
  await engine.routes.change({route:'own',provider:'openai',key:'shared-key',model:'shared'});
  const handle=engine.routes.resolve()!.credential!;
  let ran=false;
  const checked=pieceOnDisk(PIECE_DIRS['harness-pi'],PIECES['harness-pi'].id);
  const link={id:{person:'colleague'},deviceAvailable:true,person:()=>({}),identities:{devicePerson:'owner',requireReady(){}},pieceMandate:async()=>true,read:async()=>({rows:[{id:'shared-piece',digest:checked.digest,standing:true}]})} as unknown as CoreLink;
  await engine.prepare(link);assert.equal(engine.available(),true,'the shared carrier is loaded before either route or key is removed');
  const adapter=createIdentityHost({home,readOnly:false,link:async()=>link,projects:()=>[],threads:new Map(),summary:async t=>t.summary,material:{} as IdentityHostDeps['material'],piece:()=>null,nativeEngine:()=>false,
    sharedWork:async work=>{if(lost==='route')await engine.routes.change({route:'own',clear:true});else await withHomeLock(home,async()=>{credentials.revoke(handle);});return engine.run(work);},emit(){},abort(){},on:()=>()=>{},dispatch:async()=>assert.fail('no replacement send')});
  const thread={summary:{id:'thread',projectId:'project'},personId:'colleague'} as StoredThread;
  await assert.rejects(adapter.resumeAsActor(thread,async()=>{ran=true;}),/was not sent/);
  assert.equal(ran,false);await engine.close();
});

test('a missing shared route gives the automation owner a setup error', async () => {
  const home=freshHome(),engine=createSharedEngine({home},new CredentialStore(home,async()=>Buffer.alloc(32,3)),()=>false);
  const adapter=createIdentityHost({home,readOnly:false,link:async()=>assert.fail('no Core call before carrier admission'),projects:()=>[],threads:new Map(),summary:async t=>t.summary,material:{} as IdentityHostDeps['material'],piece:()=>null,nativeEngine:()=>true,sharedWork:engine.run,emit(){},abort(){},on:()=>()=>{},dispatch:async()=>assert.fail('no dispatch')});
  await assert.rejects(adapter.handlers['identity.automation.create']({personId:'colleague',projectId:'project',name:'Worker'}),error=>{
    assert.match(String(error),/Automation was not created.*Shared work/);
    assert.doesNotMatch(String(error),/Your message was not sent/);return true;
  });
});

test('a resumed turn retains its first route and journals both carriers without endpoint or credential', async () => {
  const { recordCarrier } = await import('../src/composition/shared-history.ts');
  const turn={id:'turn',status:'running',work:{steps:[],harness:'Pi'},user:{text:'Work'}} as unknown as Turn;
  const personal={kind:'endpoint' as const,provider:'openai-compatible' as const,baseUrl:'http://127.0.0.1:1234/v1',model:'original',label:'Original route',credential:null};
  recordCarrier(turn,'harness-pi',personal,false);
  recordCarrier(turn,'harness-pi',{...personal,baseUrl:'http://127.0.0.1:4321/v1',model:'shared',label:'Shared route'},true);
  assert.deepEqual(turn.work.carriers?.map(route=>route.model),['original','shared']);
  assert.doesNotMatch(JSON.stringify(turn.work.carriers),/127\.0\.0\.1|credential/);
  const replay={summary:{id:'thread',projectId:'project'},turns:[{...turn,work:{...turn.work,carriers:undefined}}]} as StoredThread;
  applyEvent(new Map([['thread',replay]]),{kind:'turn.closed',threadId:'thread',turnId:'turn',state:{status:'done',effects:[],carriers:turn.work.carriers}});
  assert.deepEqual(replay.turns[0].work.carriers,turn.work.carriers);
});


for(const status of ['done','stopped','running'] as const) test(`a refused recovery is journalled separately and preserves the original ${status} receipt`, () => {
  const turn={id:'turn',status,completed:status==='done',unknownOutcome:status!=='done',answer:{text:'Original answer',files:[]},work:{steps:[]},effects:[]} as unknown as Turn;
  const thread={summary:{id:'thread',projectId:'project',running:true},turns:[turn]} as StoredThread;
  const attempt={detail:'Recovery did not start. Earlier work is retained.',at:'2026-11-14T09:00:00Z'};
  const threads=new Map([['thread',thread]]);
  applyEvent(threads,{kind:'turn.recovery.refused',threadId:'thread',turnId:'turn',attempt});
  applyEvent(threads,{kind:'turn.recovery.refused',threadId:'thread',turnId:'turn',attempt});
  assert.equal(turn.status,status==='running'?'stopped':status);assert.equal(turn.answer?.text,'Original answer');assert.equal(turn.unknownOutcome,status!=='done');
  assert.deepEqual(turn.recoveryAttempt,attempt);assert.equal(thread.summary.running,false);
  assert.equal(turn.work.steps.length,1,'replay does not duplicate the note');
});


for (const relation of ['child','review','fork','handover'] as const) test(`personal ${relation} context cannot cross to another shared route`, async () => {
  const {assertSharedHistory,recordCarrier}=await import('../src/composition/shared-history.ts');
  const route={kind:'endpoint' as const,provider:'openai-compatible' as const,baseUrl:'http://127.0.0.1:1234/v1',model:'shared',label:'Shared route',credential:null};
  const root={summary:{id:'root'},turns:[{id:'root-turn',work:{steps:[]}}],sideTurns:[]} as unknown as StoredThread;
  const other={summary:{id:'other'},turns:[{id:'other-turn',work:{steps:[]}}],sideTurns:[]} as unknown as StoredThread;
  recordCarrier(root.turns[0],'harness-pi',route,false);recordCarrier(other.turns[0],'harness-pi',{...route,model:'personal'},false);
  if(relation==='child')other.child={parentThreadId:'root'} as StoredThread['child'];
  if(relation==='review')root.child={reviews:'other'} as StoredThread['child'];
  if(relation==='fork')root.forkedFrom={threadId:'other'};
  if(relation==='handover')root.turns[0].handovers=[{threadId:'other',turnId:'other-turn'}];
  assert.throws(()=>assertSharedHistory(root,route,new Map([['root',root],['other',other]])),/This conversation was started/);
});

test('a remote shared scope does not adopt an owner personal checkpoint even on the same model', async () => {
  let ran=false;
  const link={id:{person:'owner'},identities:{devicePerson:'owner',requireReady(){}},legacyDeviceOnly:async()=>true} as unknown as CoreLink;
  const adapter=createIdentityHost({home:freshHome(),readOnly:false,link:async()=>link,projects:()=>[],threads:new Map(),summary:async t=>t.summary,material:{} as IdentityHostDeps['material'],piece:()=>null,nativeEngine:()=>false,sharedActive:()=>true,emit(){},abort(){},on:()=>()=>{},dispatch:async()=>assert.fail('no replacement send')});
  await assert.rejects(adapter.resumeAsActor({summary:{id:'thread',projectId:'project'},personId:'owner'} as StoredThread,async()=>{ran=true;}),/This conversation was started/);
  assert.equal(ran,false);
});

test('invalid shared configuration remains a definite refusal at shared dispatch', async () => {
  const {writeFileSync}=await import('node:fs');const {join}=await import('node:path');
  const {SharedEngineRequired}=await import('../src/composition/identity-core.ts');
  const home=freshHome(),engine=createSharedEngine({home},new CredentialStore(home,async()=>Buffer.alloc(32,8)),()=>true);
  await withHomeLock(home,async()=>{assertHomeWriteAdmission(home);writeFileSync(join(home,'shared-model-route.json'),JSON.stringify({native:{provider:'codex',model:'personal'}}));});
  await assert.rejects(engine.run(async()=>assert.fail('invalid configuration ran')),error=>error instanceof SharedEngineRequired);
});

test('the recovery note gives the plain reason for each kind of refusal', () => {
  const personal = recoveryRefusal(new PersonalConversationRequired());
  assert.match(personal,/started on the owner's computer with its own model.*Continue it there/);
  assert.doesNotMatch(personal,/recorded identity and project access/);
  const shared = recoveryRefusal(new SharedEngineRequired());
  assert.match(shared,/Restore Shared work in Settings › AI and models/);
  const other = recoveryRefusal(new IdentityRefused());
  assert.match(other,/recorded identity and project access/);
});
