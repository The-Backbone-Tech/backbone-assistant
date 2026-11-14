// Private history protocol with real durable files/locks; no connector, provider or database.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import {ConnectorObservations,type ConnectorObservationRequest,type ConnectorObservationScope,type RetainedConnectorResponse,type ConnectorObservationJournal} from '../src/composition/connector-observations.ts';
import type {MaterialReadTentative} from '../src/composition/core.ts';
import {ThreadJournal} from '../src/composition/thread-journal.ts';
import {withHomeLock} from '../src/composition/home-lock.ts';
import {sha256} from '../src/stub/fsx.ts';

const current:ConnectorObservationScope={workspace:'workspace',project:'project',thread:'thread',turn:'turn',run:'run'};
const result:RetainedConnectorResponse={status:'complete',text:'Retained result',material:{name:'answer.json',mediaType:'application/json',body:'{"answer":"Retained result"}'},episodeContent:'{"answer":"Retained result"}',preparedText:'{"status":"complete","text":"Retained result"}',transformation:{kind:'mcp-response',version:'1'}};
function request(callId='call-1',scope=current):ConnectorObservationRequest{return {scope:{...scope},origin:{engine:'codex',namespace:'native-thread/native-turn',callId},serverId:'server',serverName:'Fake server',connection:'connection',tool:'lookup',launch:'a'.repeat(64),definition:'b'.repeat(64),argsJson:'{"query":"same"}'};}
async function fixture(t:TestContext){
 const home=mkdtempSync(join(tmpdir(),'connector-observations-')),journal=new ThreadJournal(home),store=new ConnectorObservations(home,journal);
 t.after(()=>rmSync(home,{recursive:true,force:true}));await withHomeLock(home,async()=>store.startProtocol(current));return {home,journal,store,reopen:()=>new ConnectorObservations(home,journal)};
}
test('distinct native IDs distinguish two legitimate identical calls; only a durable first dispatch can invoke the fake provider',async t=>{
 const f=await fixture(t);let providers=0,first='';
 await withHomeLock(f.home,async()=>{
  const a=f.store.reserve(request()),b=f.store.reserve(request('call-2'));first=a.observation.id;
  assert.notEqual(a.observation.id,b.observation.id);assert.notEqual(a.observation.materialId,b.observation.materialId);assert.notEqual(a.observation.readKey,b.observation.readKey);
  for(const id of [a.observation.id,b.observation.id,a.observation.id])if(f.store.beginDispatch(id)){assert.equal(f.journal.read().at(-1)?.kind,'mcp.read.dispatched');providers++;}
  assert.equal(providers,2);
 });
 await withHomeLock(f.home,async()=>{const reopened=f.reopen();assert.equal(reopened.beginDispatch(first),false);const fresh=reopened.reserve(request('call-3'));assert.throws(()=>reopened.beginDispatch(fresh.observation.id),/unresolved/i);});
 assert.equal(providers,2,'reopening or new model IDs cannot heal unresolved dispatch history');
});
test('same native origin returns its exact reservation and refuses changed payload rather than matching arguments',async t=>{
 const f=await fixture(t);await withHomeLock(f.home,async()=>{
  const a=f.store.reserve(request()),size=f.journal.read().length,b=f.store.reserve(request());
  assert.equal(b.created,false);assert.deepEqual(b.observation,a.observation);assert.equal(f.journal.read().length,size);
  for(const patch of [{argsJson:'{"query":"changed"}'},{tool:'other'},{connection:'other'},{definition:'c'.repeat(64)}])assert.throws(()=>f.store.reserve({...request(),...patch}),/another.*request/i);
  assert.equal(f.journal.read().length,size);assert.equal(f.store.problem,undefined);
 });
});
test('Pi origin requires one durable batch with unique IDs and the exact owning run scope',async t=>{
 const f=await fixture(t);await withHomeLock(f.home,async()=>{
  assert.throws(()=>f.store.allocatePiBatch(current,['duplicate','duplicate']),/history|verified/i);
  const ticket=f.store.allocatePiBatch(current,['pi-1','pi-2']);
  const make=(callId:string,scope=current)=>({...request(callId,scope),origin:{engine:'pi' as const,namespace:ticket,callId}});
  assert.equal(f.store.reserve(make('pi-1')).created,true);
  assert.throws(()=>f.store.reserve(make('missing')),/batch/i);
  assert.throws(()=>f.store.reserve(make('pi-2',{...current,turn:'other-turn'})),/batch/i);
  assert.equal(f.store.problem,undefined);
 });
});
test('retained response, immutable material and tentative Core IDs survive deleted thread projections',async t=>{
 const f=await fixture(t);let id='',receipt:ReturnType<typeof tentative>;
 function tentative(readKey:string){return {workspace:current.workspace,readKey,episode:randomUUID(),receipt:randomUUID()};}
 await withHomeLock(f.home,async()=>{
  const reserved=f.store.reserve(request());id=reserved.observation.id;f.store.beginDispatch(id);
  f.store.retainResponse(id,result);f.store.retainMaterial(id,sha256(result.material.body));receipt=tentative(reserved.observation.readKey);
  f.store.retainTentative(id,receipt);f.store.confirm(id,receipt);
  f.journal.append({kind:'thread.deleted',threadId:current.thread});
 });
 const reopened=f.reopen(),view=reopened.get(id)!;assert.equal(view.phase,'confirmed');assert.deepEqual(view.confirmation,receipt!);assert.deepEqual(view.response,result);assert.equal(reopened.hasDispatchHistory(current),true);
 view.response!.text='tampered projection';assert.equal(reopened.get(id)!.response!.text,result.text);
});
test('registration-only recovery preserves multiple tentative attempts and rejects foreign or fabricated confirmations',async t=>{
 const f=await fixture(t);await withHomeLock(f.home,async()=>{
  const o=f.store.reserve(request()).observation;f.store.beginDispatch(o.id);f.store.retainResponse(o.id,result);f.store.retainMaterial(o.id,sha256(result.material.body));
  const first={workspace:current.workspace,readKey:o.readKey,episode:randomUUID(),receipt:randomUUID()};f.store.retainTentative(o.id,first);f.store.release(o.id);
  const reopened=f.reopen(),second={...first,episode:randomUUID(),receipt:randomUUID()};reopened.retainTentative(o.id,second);
  assert.throws(()=>reopened.confirm(o.id,{...second,workspace:'foreign'}),/history|verified/i);
  assert.throws(()=>reopened.confirm(o.id,{...second,receipt:randomUUID()}),/history|verified/i);
  assert.equal(reopened.get(o.id)!.phase,'tentative');assert.equal(reopened.get(o.id)!.tentatives.length,2);
  reopened.confirm(o.id,second);assert.equal(reopened.get(o.id)!.phase,'confirmed');assert.equal(reopened.beginDispatch(o.id),false);
 });
});
test('unobserved failure stays UNKNOWN with no fabricated response or material, and a new person turn has its own identity',async t=>{
 const f=await fixture(t);await withHomeLock(f.home,async()=>{
  const o=f.store.reserve(request()).observation;f.store.beginDispatch(o.id);f.store.unknown(o.id,'No verified response was retained; it was not resent.');
  assert.throws(()=>f.store.retainResponse(o.id,result),/history|verified/i);assert.equal(f.store.get(o.id)!.response,undefined);assert.equal(f.store.get(o.id)!.material,undefined);
  const next=f.store.reserve(request('new-model-id'));assert.throws(()=>f.store.beginDispatch(next.observation.id),/unresolved/i);
  const fresh={...current,turn:'new-person-turn',run:'new-run'};f.store.startProtocol(fresh);const person=f.store.reserve(request('new-model-id',fresh));assert.equal(f.store.beginDispatch(person.observation.id),true);
 });
});
test('a reserved-only observation from an earlier process is not automatically dispatched',async t=>{
 const f=await fixture(t);let id='';await withHomeLock(f.home,async()=>{id=f.store.reserve(request()).observation.id;});
 await withHomeLock(f.home,async()=>{const reopened=f.reopen();assert.equal(reopened.reserve(request()).created,false);assert.throws(()=>reopened.beginDispatch(id),/not resumed/i);});
});
test('an uncertain durable append pauses the store before the fake provider can run',async t=>{
 const f=await fixture(t),port:ConnectorObservationJournal={read:()=>f.journal.read(),append:event=>{if(event.kind==='mcp.read.dispatched')throw new Error('Synthetic fsync failed');return f.journal.append(event);}},store=new ConnectorObservations(f.home,port);let providers=0;
 await withHomeLock(f.home,async()=>{
  const o=store.reserve(request()).observation;assert.throws(()=>{if(store.beginDispatch(o.id))providers++;},/fsync/i);
  assert.ok(store.problem);assert.throws(()=>store.reserve(request('another')),/history|verified/i);
 });assert.equal(providers,0);
});
test('malformed or future MCP history pauses capability without inventing an empty replay',async t=>{
 const f=await fixture(t);f.journal.append({kind:'mcp.future',threadId:current.thread} as never);
 const reopened=f.reopen();assert.ok(reopened.problem);assert.throws(()=>reopened.forRun(current),/history|verified/i);
});
test('observation changes require the same home lock and malformed native identity has no fallback',async t=>{
 const f=await fixture(t);assert.throws(()=>f.store.reserve(request()),/lock/i);
 await withHomeLock(f.home,async()=>{assert.throws(()=>f.store.reserve({...request(),origin:{engine:'codex',namespace:'',callId:'call'}}),/identity/i);assert.equal(f.journal.read().length,1);});
});

test('exact response/material/receipt replays are idempotent, including receipt object property order',async t=>{
 const f=await fixture(t);await withHomeLock(f.home,async()=>{
  const o=f.store.reserve(request()).observation;f.store.beginDispatch(o.id);f.store.retainResponse(o.id,result);f.store.retainMaterial(o.id,sha256(result.material.body));
  const c={workspace:current.workspace,readKey:o.readKey,episode:randomUUID(),receipt:randomUUID()};f.store.retainTentative(o.id,c);f.store.confirm(o.id,c);
  const size=f.journal.read().length;f.store.retainResponse(o.id,structuredClone(result));f.store.retainMaterial(o.id,sha256(result.material.body));
  f.store.retainTentative(o.id,{receipt:c.receipt,episode:c.episode,readKey:c.readKey,workspace:c.workspace});f.store.confirm(o.id,{...c});
  assert.equal(f.journal.read().length,size);assert.equal(f.store.get(o.id)!.tentatives.length,1);
 });
});
test('a promise-returning journal never becomes a dispatch barrier',async t=>{
 const f=await fixture(t),port={read:()=>[],append:async()=>({at:new Date().toISOString()})} as unknown as ConnectorObservationJournal;
 const store=new ConnectorObservations(f.home,port);
 await withHomeLock(f.home,async()=>{assert.throws(()=>store.reserve(request()),/synchronous/i);assert.ok(store.problem);});
 assert.equal(f.journal.read().length,1);
});

test('missing protocol history for a legacy turn is not proof that no provider call happened',async t=>{
 const f=await fixture(t),legacy={...current,turn:'legacy-turn',run:'legacy-run'};
 await withHomeLock(f.home,async()=>{
  assert.equal(f.store.hasDispatchHistory(legacy),false);assert.equal(f.store.hasProtocolHistory(legacy),false);
  const o=f.store.reserve(request('new-generated-model-id',legacy)).observation;
  assert.throws(()=>f.store.beginDispatch(o.id),/earlier call cannot be ruled out/i);
  assert.equal(f.store.get(o.id)!.phase,'reserved');
 });
});
test('aliased material IDs or read keys in otherwise valid history pause replay',async t=>{
 const f=await fixture(t);let first!:ReturnType<ConnectorObservations['reserve']>,second!:ReturnType<ConnectorObservations['reserve']>;
 await withHomeLock(f.home,async()=>{first=f.store.reserve(request());second=f.store.reserve(request('second'));});
 for(const field of ['materialId','readKey'] as const){
  const port:ConnectorObservationJournal={append:event=>f.journal.append(event),read:()=>f.journal.read().map(event=>event.kind==='mcp.read.reserved'&&event.observation.id===second.observation.id?{...event,observation:{...event.observation,[field]:first.observation[field]}}:event)};
  const reopened=new ConnectorObservations(f.home,port);assert.ok(reopened.problem);assert.throws(()=>reopened.get(first.observation.id),/history|verified/i);
 }
});

test('discarding UNKNOWN preserves its original identity and history, never enables another dispatch in that turn',async t=>{
 const f=await fixture(t);let id='',before!:ReturnType<ConnectorObservations['get']>;
 await withHomeLock(f.home,async()=>{
  const o=f.store.reserve(request()).observation;id=o.id;f.store.beginDispatch(id);f.store.unknown(id,'No verified response was retained.');before=f.store.get(id);
  f.store.discard(id);const size=f.journal.read().length;f.store.discard(id);
  assert.equal(f.journal.read().length,size,'explicit discard is idempotent and appends no duplicate decision');
  assert.deepEqual(f.store.get(id),{...before,phase:'discarded'});
  assert.equal(f.store.beginDispatch(id),false);
  const next=f.store.reserve(request('after-discard')).observation;assert.throws(()=>f.store.beginDispatch(next.id),/unresolved/i);
  const fresh={...current,turn:'explicit-new-person-turn',run:'explicit-new-run'};f.store.startProtocol(fresh);
  assert.equal(f.store.beginDispatch(f.store.reserve(request('fresh-call',fresh)).observation.id),true);
 });
 const reopened=f.reopen();assert.equal(reopened.problem,undefined);assert.deepEqual(reopened.get(id),{...before,phase:'discarded'});
 assert.equal(reopened.hasDispatchHistory(current),true);
});

test('discard releases active ownership while preserving dispatched uncertainty and blocking the next call',async t=>{
 const f=await fixture(t);await withHomeLock(f.home,async()=>{
  const o=f.store.reserve(request()).observation;f.store.beginDispatch(o.id);f.store.discard(o.id);
  const next=f.store.reserve(request('next-native-id')).observation;
  assert.throws(()=>f.store.beginDispatch(next.id),/unresolved/i,'discard cannot leave an active-owner exemption');
  assert.equal(f.store.get(o.id)!.dispatched,true);assert.equal(f.store.get(o.id)!.response,undefined);
 });
});

for(const confirmed of [false,true])test(`discard preserves all retained bytes and tentative/confirmed identities (${confirmed?'confirmed':'tentative'})`,async t=>{
 const f=await fixture(t);let id='',before!:NonNullable<ReturnType<ConnectorObservations['get']>>,receipt!:MaterialReadTentative;
 await withHomeLock(f.home,async()=>{
  const o=f.store.reserve(request()).observation;id=o.id;f.store.beginDispatch(id);f.store.retainResponse(id,result);f.store.retainMaterial(id,sha256(result.material.body));
  const first={workspace:current.workspace,readKey:o.readKey,episode:randomUUID(),receipt:randomUUID()};f.store.retainTentative(id,first);
  receipt={...first,episode:randomUUID(),receipt:randomUUID()};f.store.retainTentative(id,receipt);if(confirmed)f.store.confirm(id,receipt);
  before=f.store.get(id)!;f.store.discard(id);
  assert.deepEqual(f.store.get(id),{...before,phase:'discarded'});
  for(const change of [()=>f.store.confirm(id,receipt),()=>f.store.retainTentative(id,receipt),()=>f.store.retainResponse(id,result),()=>f.store.retainMaterial(id,sha256(result.material.body)),()=>f.store.notSent(id,'No new negative proof.'),()=>f.store.unknown(id,'No state rewrite.')])assert.throws(change,/discard|history|verified/i);
  const after=f.store.get(id)!;assert.deepEqual(after,{...before,phase:'discarded'});
  assert.equal(after.confirmation?.receipt,confirmed?receipt.receipt:undefined,'discard never asserts the absence of Core registration');
  const next=f.store.reserve(request('after-historical-discard')).observation;assert.throws(()=>f.store.beginDispatch(next.id),/unresolved/i);
  f.journal.append({kind:'thread.deleted',threadId:current.thread});
 });
 const reopened=f.reopen();assert.equal(reopened.problem,undefined);assert.deepEqual(reopened.get(id),{...before,phase:'discarded'});
 await withHomeLock(f.home,async()=>{assert.throws(()=>reopened.confirm(id,receipt),/discard|history|verified/i);assert.equal(reopened.beginDispatch(id),false);});
});

test('forProject returns private cloned history across deleted threads, with exact workspace/project boundaries',async t=>{
 const f=await fixture(t);let id='';await withHomeLock(f.home,async()=>{
  id=f.store.reserve(request()).observation.id;f.store.beginDispatch(id);f.store.retainResponse(id,result);f.store.discard(id);
  f.store.reserve(request('other-workspace',{...current,workspace:'other-workspace'}));
  f.store.reserve(request('other-project',{...current,project:'other-project'}));
  f.store.reserve(request('other-thread',{...current,thread:'other-thread'}));
  f.journal.append({kind:'thread.deleted',threadId:current.thread});
 });
 const reopened=f.reopen(),views=reopened.forProject(current.workspace,current.project);
 assert.equal(views.length,2);assert.equal(views.find(value=>value.id===id)!.phase,'discarded');
 views[0].request.scope.project='caller-mutation';views.find(value=>value.id===id)!.response!.text='caller-mutation';
 assert.equal(reopened.get(id)!.response!.text,result.text);assert.equal(reopened.forProject(current.workspace,current.project).length,2);
 assert.deepEqual(reopened.forProject('missing-workspace',current.project),[]);
 assert.throws(()=>reopened.forProject('',current.project));assert.throws(()=>reopened.forProject(current.workspace,''));
});

test('originalRun returns only one original run from exact retained turn history and refuses ambiguity',async t=>{
 const f=await fixture(t),turn={workspace:current.workspace,project:current.project,thread:current.thread,turn:current.turn};
 assert.equal(f.store.originalRun(turn),undefined,'absence never invents a replacement run');
 await withHomeLock(f.home,async()=>{
  const first=f.store.reserve(request()).observation;f.store.beginDispatch(first.id);f.store.discard(first.id);
  f.store.reserve(request('same-run-another-call'));
  for(const patch of [{workspace:'other-workspace'},{project:'other-project'},{thread:'other-thread'},{turn:'other-turn'}])f.store.reserve(request('unrelated',{...current,...patch,run:'unrelated-run'}));
  f.journal.append({kind:'thread.deleted',threadId:current.thread});
 });
 const reopened=f.reopen();assert.equal(reopened.originalRun(turn),current.run);
 assert.throws(()=>reopened.originalRun({...turn,turn:''}));
 await withHomeLock(f.home,async()=>reopened.reserve(request('conflicting-original-run',{...current,run:'another-original-run'})));
 assert.throws(()=>reopened.originalRun(turn),/ambig|multiple|more than one/i);
 assert.throws(()=>f.reopen().originalRun(turn),/ambig|multiple|more than one/i);
});

test('discard requires the held home lock and a later raw confirmation cannot revive discarded history',async t=>{
 const f=await fixture(t);let id='',receipt!:MaterialReadTentative;
 await withHomeLock(f.home,async()=>{
  const o=f.store.reserve(request()).observation;id=o.id;f.store.beginDispatch(id);f.store.retainResponse(id,result);f.store.retainMaterial(id,sha256(result.material.body));
  receipt={workspace:current.workspace,readKey:o.readKey,episode:randomUUID(),receipt:randomUUID()};f.store.retainTentative(id,receipt);f.store.confirm(id,receipt);
 });
 assert.throws(()=>f.store.discard(id),/lock/i);
 await withHomeLock(f.home,async()=>{f.store.discard(id);f.journal.append({kind:'mcp.read.confirmed',threadId:current.thread,id,receipt});});
 const reopened=f.reopen();assert.ok(reopened.problem);assert.throws(()=>reopened.forProject(current.workspace,current.project),/history|verified/i);
});


test('requested time comes only from the durable reservation event and survives reopen and discard',async t=>{
 const f=await fixture(t);let id='',at='';
 await withHomeLock(f.home,async()=>{
  const forged={...request(),requestedAt:'1900-01-01T00:00:00.000Z',at:'1900-01-01T00:00:00.000Z'};
  const reserved=f.store.reserve(forged);id=reserved.observation.id;
  const event=f.journal.read().find(event=>event.kind==='mcp.read.reserved'&&event.observation.id===id)!;at=event.at;
  assert.equal(f.store.requestedAt(id),at);assert.notEqual(at,forged.requestedAt);assert.ok(Number.isFinite(Date.parse(at)));
  const count=f.journal.read().length;f.store.reserve(forged);assert.equal(f.journal.read().length,count);assert.equal(f.store.requestedAt(id),at);
  f.store.beginDispatch(id);f.store.retainResponse(id,result);f.store.discard(id);assert.equal(f.store.requestedAt(id),at);
 });
 const reopened=f.reopen();assert.equal(reopened.requestedAt(id),at);assert.equal(reopened.get(id)!.phase,'discarded');
 assert.equal(reopened.requestedAt('missing-observation'),undefined);assert.equal('requestedAt' in reopened.get(id)!.request,false,'display time is not a request payload field');
});
test('missing or malformed durable reservation time pauses replay instead of guessing from caller data',async t=>{
 const f=await fixture(t);await withHomeLock(f.home,async()=>f.store.reserve(request()));
 for(const at of [undefined,'not-a-time','2026-11-09T00:00:00']){
  const port:ConnectorObservationJournal={append:event=>f.journal.append(event),read:()=>f.journal.read().map(event=>event.kind==='mcp.read.reserved'?{...event,at}:event)};
  const reopened=new ConnectorObservations(f.home,port);assert.ok(reopened.problem);assert.throws(()=>reopened.requestedAt('anything'),/history|verified/i);
 }
});
