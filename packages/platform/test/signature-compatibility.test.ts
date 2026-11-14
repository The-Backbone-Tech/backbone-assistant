// Explicitly replace the shared template with released SQL: no signature objects or receipt.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs,{existsSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {assertHomeWriteAdmission,HomeWriteUnavailable,withHomeLock} from '../src/composition/home-lock.ts';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import {buildBaseline,upgradeMaterialGuard,upgradeMaterialLink,upgradeMaterialEnforcement,upgradeSignatureLedger} from '@backbone/core/db';
import {dataHomeAdminUrl} from '@backbone/core/testing';
import {CoreLink,CoreRefusal} from '../src/composition/core.ts';
import {ConnectorService,type ConnectorCore} from '../src/connectors/service.ts';
import {defaultToolEnv} from '../src/tools/places.ts';
import {freshDir,freshHome,value} from './helpers.ts';
import {legacyCoreDatabase} from './fixtures/legacy-core.ts';
const id='claude-code:notes';
async function fixture(t:TestContext,withStep=false){
 const home=freshHome(),legacy=JSON.parse(readFileSync(new URL('./fixtures/material-guard-legacy.json',import.meta.url),'utf8')).sqlLines.join('\n')+'\n';
 const admin=await legacyCoreDatabase(dataHomeAdminUrl(home),legacy);t.after(()=>admin.end());
 for(const install of [upgradeMaterialGuard,upgradeMaterialLink,upgradeMaterialEnforcement,...(withStep?[upgradeSignatureLedger]:[])]){
  const status=await install(admin,buildBaseline().sql);assert.equal(status.state,'verified',status.reason);
 }
 assert.equal((await admin.query("SELECT to_regprocedure('gov.give_connector_signature(uuid,text,text)') IS NOT NULL AS installed")).rows[0].installed,withStep);
 const link=await CoreLink.open({home});t.after(()=>link.close());
 const person=freshDir('signature-compat-'),log=join(person,'calls.jsonl');
 writeFileSync(join(person,'.claude.json'),JSON.stringify({mcpServers:{notes:{command:process.execPath,args:[join(import.meta.dirname,'fake-mcp-server.ts')],env:{FAKE_MCP_LOG:log}}}}));
 let activeLink=link;
 const service=new ConnectorService({home,env:()=>defaultToolEnv({HOME:person,PATH:process.env.PATH}),link:async()=>activeLink});t.after(()=>service.close());
 value(await service.refresh(id));value(await service.set(id,{enabled:true}));value(await service.set(id,{tool:{name:'draft_note',enabled:true}}));value(await service.set(id,{egress:true,seal:service.doorSeal(id)!}));
 let n=0;
 // The effect branch must never enter a read port.
 const core={readObserved:async()=>{throw new Error('effect entered read port');}} as unknown as ConnectorCore;
 const call=async(text:string)=>{const offered=service.offered().find(t=>t.tool==='draft_note')!;return service.call(offered,{text},core,{threadId:'synthetic',turnId:`turn-${++n}`,seq:n},new AbortController().signal);};
 const held=()=>service.list().held.find(h=>h.state==='waiting')!;
 const sign=()=>{const shown=service.toolView(id,'draft_note')!;return service.set(id,{seal:shown.seal,tool:{name:'draft_note',standing:{stamp:shown.stamp}}});};
 const file=join(home,'connectors','mcp.json'),read=()=>JSON.parse(readFileSync(file,'utf8'));
 const calls=()=>existsSync(log)?readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)):[];
 const seedSignature=(coreMarker:boolean)=>{const s=read(),c=s.servers[id],tool=c.tools.draft_note;tool.standing={...(coreMarker?{core:1}:{}),id:randomUUID(),definition:tool.definition,seal:c.egressSeal,home:realpathSync(home),at:'2026-11-01T00:00:00Z'};writeFileSync(file,JSON.stringify(s));};
 return {home,admin,link,service,call,held,sign,file,read,calls,seedSignature,restoreTo:(next:CoreLink)=>{activeLink=next;}};
}
test('without the step a per-call release sends once through the unchanged ABI and discard works',async t=>{
 const p=await fixture(t);assert.equal((await p.call('release')).outcome,'HELD');const h=p.held();
 assert.equal(value(await p.service.decide(h.effect,h.argsHash,'release')).state,'sent');
 assert.equal(value(await p.service.decide(h.effect,h.argsHash,'release')).state,'sent');assert.equal(p.calls().length,1);
 const answers=(await p.link.read<{payload:Record<string,unknown>}>(p.link.person(),"SELECT payload FROM app.ledger WHERE entry_type='decision.answered'")).rows;
 assert.equal(answers.length,1);assert.equal(answers[0].payload.basis,undefined,'the released four-argument ABI is used');
 assert.equal((await p.call('discard')).outcome,'HELD');const discard=p.held();
 assert.equal(value(await p.service.decide(discard.effect,discard.argsHash,'discard')).state,'discarded');assert.equal(p.calls().length,1);
});
test('without the step signing and standing release return refusal receipts without changing the held call',async t=>{
 const p=await fixture(t);const refused=await p.sign();assert.equal(refused.ok,false);
 assert.match(refused.ok?'':refused.detail,/connector-signature-ledger-v1.*incomplete.*backbone doctor.*Update.*operator.*individual/s);assert.equal(p.read().servers[id].tools.draft_note.standing,undefined);
 await p.call('standing attempt');const h=p.held();p.seedSignature(true);const before=p.read().held;
 const resolve=p.service as unknown as {resolve(effect:string,hash:string,verdict:string,standing:boolean):ReturnType<ConnectorService['decide']>};
 const result=await resolve.resolve(h.effect,h.argsHash,'release',true);assert.equal(result.ok,false);assert.match(result.ok?'':result.detail,/Update this home's Core/);
 assert.deepEqual(p.read().held,before);assert.equal(p.calls().length,0);
 assert.equal(value(await p.service.decide(h.effect,h.argsHash,'release')).state,'sent');
});
test('a legacy signed tool in a released home is retired, held and releasable per call',async t=>{
 const p=await fixture(t);p.seedSignature(false);await p.service.ready();assert.equal(p.read().servers[id].tools.draft_note.standing,undefined);
 assert.equal((await p.call('legacy')).outcome,'HELD');assert.equal(p.calls().length,0);const h=p.held();
 assert.equal(value(await p.service.decide(h.effect,h.argsHash,'release')).state,'sent');assert.equal(p.calls().length,1);
});
test('with the step standing and per-call answers keep their structured basis',async t=>{
 const p=await fixture(t,true);value(await p.sign());assert.equal((await p.call('signed')).outcome,'SENT');
 value(await p.service.set(id,{tool:{name:'draft_note',standing:false}}));await p.call('person');const h=p.held();value(await p.service.decide(h.effect,h.argsHash,'release'));
 const answers=(await p.link.read<{method:string}>(p.link.person(),"SELECT payload->'basis'->>'method' AS method FROM app.ledger WHERE entry_type='decision.answered' ORDER BY seq")).rows;
 assert.deepEqual(answers.map(a=>a.method),['standing_signature','person']);assert.equal(p.calls().length,2);
});


test('a failing ready leaves the same held call decidable again in the same process',async t=>{
 const p=await fixture(t,true);await p.call('ready recovery');const h=p.held(),ready=p.service.ready.bind(p.service);
 p.service.ready=async()=>{throw new Error('synthetic ready failure');};
 await assert.rejects(p.service.decide(h.effect,h.argsHash,'release'),/synthetic ready failure/);
 p.service.ready=ready;
 assert.equal(value(await p.service.decide(h.effect,h.argsHash,'release')).state,'sent');assert.equal(p.calls().length,1);
});
test('structured answer failure withholds backend text and leaves the held call recoverable',async t=>{
 const p=await fixture(t,true),call=p.link.call.bind(p.link),secret='opaque-answer-credential-95';
 await p.call('answer privacy');const h=p.held();
 p.link.call=(async(...args:Parameters<CoreLink['call']>)=>{
  if(String(args[1]).includes('answer_decision_with_basis'))throw Error(`backend ${secret}`);
  return call(...args);
 }) as CoreLink['call'];
 await assert.rejects(p.service.decide(h.effect,h.argsHash,'release'),error=>{
  assert.ok(error instanceof Error);assert.equal(error.message.includes(secret),false);assert.match(error.message,/Core answer could not be confirmed/);return true;
 });
 assert.equal(p.read().held.find((x:{effect:string})=>x.effect===h.effect).state,'waiting');assert.equal(p.calls().length,0);
 p.link.call=call;assert.equal(value(await p.service.decide(h.effect,h.argsHash,'release')).state,'sent');
});
async function foreignGrant(link:CoreLink){
 // This fixture deliberately tests both the released pre-identity ABI and current Core.
 const addPerson=link.identityStatus.state==='verified'?'gov.identity_add_person':'gov.add_person';
 const other=await link.call<string>(link.person(),`SELECT ${addPerson}('Other','other@example.test','member')`);
 const connection=await link.call<string>(link.person(),"SELECT gov.register_connection('Shared','shared',NULL,'workspace','none')");
 await link.call(link.system(),"SELECT gov.record_connection_tools($1,'ok','[{\"name\":\"draft_note\"}]',NULL)",[connection]);
 return link.call<string>({workspace:link.id.workspace,principal:other},'SELECT gov.give_connector_signature($1,$2,$3)',[connection,'draft_note','b'.repeat(64)]);
}
test('pending end conflicts keep only the structured id, reason, outcome and time',async t=>{
 const p=await fixture(t,true),id=await foreignGrant(p.link),s=p.read(),secret='opaque-conflict-credential-96';
 s.pendingEnds=[{id,reason:'person_revoked',serverName:secret,env:{TOKEN:secret},argv:[secret]}];
 await withHomeLock(p.home,async()=>{assertHomeWriteAdmission(p.home,join(p.home,'connectors'));writeFileSync(p.file,JSON.stringify(s));});await p.service.ready();
 assert.equal(p.read().pendingEnds,undefined);
 assert.deepEqual(Object.keys(p.read().signatureEndConflicts[0]).sort(),['at','id','outcome','reason']);
 assert.equal(JSON.stringify(p.read().signatureEndConflicts).includes(secret),false);
});
for(const outcome of ['not_found','someone_else'] as const)for(const restore of [false,true])
 test(`pending ${outcome} ends are dropped without blocking work, simulated restore=${restore}`,async t=>{
 const p=await fixture(t,true);
 const target=restore?await CoreLink.open({home:freshHome()}):p.link;if(restore)t.after(()=>target.close());
 const id=outcome==='not_found'?randomUUID():await foreignGrant(target);
 const s=p.read();s.pendingEnds=[{id,reason:'person_revoked'}];writeFileSync(p.file,JSON.stringify(s));
 if(restore)p.restoreTo(target); // Persisted connector file now faces a restored Core identity/state.
 await p.service.ready();assert.equal(p.read().pendingEnds,undefined);
 if(outcome==='someone_else'){
  assert.deepEqual(p.read().signatureEndConflicts.map((x:{id:string;reason:string;outcome:string})=>({id:x.id,reason:x.reason,outcome:x.outcome})),[{id,reason:'person_revoked',outcome}]);
  assert.equal((await target.read(target.person(),"SELECT subject FROM app.ledger WHERE entry_type='signature.ended' AND subject=$1",[id])).rows.length,0,'no false Core end is claimed');
 }else assert.equal(p.read().signatureEndConflicts,undefined);
 value(await p.service.set('claude-code:notes',{tool:{name:'draft_note',enabled:true}}));
 if(!restore){await p.call('after pending recovery');const h=p.held();assert.equal(value(await p.service.decide(h.effect,h.argsHash,'release')).state,'sent');}
});

for(const standing of [true,false])test(`transient middle verification refuses standing and preserves person fallback, standing=${standing}`,async t=>{
 const p=await fixture(t,true);
 if(standing)value(await p.sign());
 // Hold first without auto-answering, then exercise resolve's status sequence directly.
 const target=p.service as unknown as {
  signatureStatus(link:CoreLink):Promise<{state:string;reason:string}>;
  resolve(effect:string,hash:string,verdict:string,standing:boolean):ReturnType<ConnectorService['decide']>;
 };
 const original=target.signatureStatus.bind(p.service);
 if(standing){const s=p.read();delete s.servers[id].tools.draft_note.standing;writeFileSync(p.file,JSON.stringify(s));}
 await p.call('transient status');const h=p.held();
 if(standing){const grant=(await p.admin.query('SELECT id FROM app.connector_signatures WHERE ended_at IS NULL')).rows[0].id;
  const s=p.read(),c=s.servers[id],tool=c.tools.draft_note;
  tool.standing={core:1,id:grant,definition:tool.definition,seal:c.egressSeal,home:realpathSync(p.home),at:'2026-11-01T00:00:00Z'};writeFileSync(p.file,JSON.stringify(s));
 }
 let checks=0;
 target.signatureStatus=async link=>++checks===2?{state:'paused',reason:'Synthetic transient inspection failure.'}:original(link);
 if(!standing)assert.equal((await target.signatureStatus(p.link)).state,'verified');
 const result=await target.resolve(h.effect,h.argsHash,'release',standing);
 if(standing){
  assert.equal(result.ok,false,'a failed verification must never downgrade a standing answer to the old ABI');
  assert.equal(result.ok?'':result.reason,'NOT_AVAILABLE');assert.equal(p.calls().length,0);
  assert.equal(p.read().held.find((x:{effect:string})=>x.effect===h.effect).state,'waiting');
  assert.equal((await p.admin.query("SELECT count(*)::int n FROM app.ledger WHERE entry_type='decision.answered'")).rows[0].n,0);
 }else{
  assert.equal(value(result).state,'sent');assert.equal(p.calls().length,1);
  assert.deepEqual(await p.link.call(p.link.person(),'SELECT gov.decision_answer_basis($1)',[(await p.admin.query('SELECT decision_id FROM app.effects WHERE id=$1',[h.effect])).rows[0].decision_id]),{method:'person'});
 }
 assert.equal(checks,2,'no successful reinspection may erase the observed pause');
 assert.equal((await target.signatureStatus(p.link)).state,'verified');
 target.signatureStatus=original;
 if(standing){assert.equal(value(await p.service.decide(h.effect,h.argsHash,'release')).state,'sent');assert.equal(p.calls().length,1);}
});

for(const action of ['discard','call'] as const)test(`withdrawn admission refuses ${action} before any Core crossing and preserves every home byte`,async t=>{
 const p=await fixture(t,true);
 await p.call('held before withdrawal');const held=p.held();
 const crossings:string[]=[];
 const watched=new Proxy(p.link,{get(target,key){const value=Reflect.get(target,key,target);if(typeof value!=='function')return value;
  return(...args:unknown[])=>{if(!['person','system'].includes(String(key)))crossings.push(String(key));return value.apply(target,args);};
 }});
 p.restoreTo(watched);
 const snapshot=(dir:string):unknown=>fs.readdirSync(dir).sort().map(name=>{const file=join(dir,name),stat=fs.lstatSync(file);return [name,stat.mode,stat.isDirectory()?snapshot(file):fs.readFileSync(file).toString('hex')];});
 const before=snapshot(p.home),statfs=fs.statfsSync;
 t.mock.method(fs,'statfsSync',((path:fs.PathLike)=>({...statfs(path),type:String(path)===join(p.home,'connectors')?0x6969:statfs(path).type})) as typeof fs.statfsSync);
 await assert.rejects(action==='discard'?p.service.decide(held.effect,held.argsHash,'discard'):p.call('new after withdrawal'),error=>error instanceof HomeWriteUnavailable);
 assert.deepEqual(crossings,[],'admission refuses before proposal, answer, or even a Core query');
 assert.deepEqual(snapshot(p.home),before);
});

for(const withStep of [false,true])test(`answer diagnostic retains only a Core reason code, step=${withStep}`,async t=>{
 const p=await fixture(t,withStep),call=p.link.call.bind(p.link),secret='opaque-fallback-credential-96';
 await p.call('safe answer diagnostic');const h=p.held();
 p.link.call=(async(...args:Parameters<CoreLink['call']>)=>{
  if(String(args[1]).includes('gov.answer_decision'))throw new CoreRefusal('denied',`backend ${secret}`);
  return call(...args);
 }) as CoreLink['call'];
 await assert.rejects(p.service.decide(h.effect,h.argsHash,'release'),error=>{
  assert.ok(error instanceof Error);assert.match(error.message,/Core answer could not be confirmed/);
  assert.equal((error as CoreRefusal).reason,'denied');assert.equal(JSON.stringify(error).includes(secret),false);
  assert.equal(error.message.includes(secret),false);assert.equal(error.cause,undefined);return true;
 });
 assert.equal(p.held().state,'waiting');assert.equal(p.calls().length,0);
 p.link.call=call;assert.equal(value(await p.service.decide(h.effect,h.argsHash,'release')).state,'sent');
});
