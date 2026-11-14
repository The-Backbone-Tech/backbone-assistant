// Boundaries use the same proxy fault injection as connectors.test.ts; no real account or provider.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs,{readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import pg from 'pg';
import {dataHomeAdminUrl} from '@backbone/core/testing';
import {HomeWriteUnavailable,inActiveHomeLockScope} from '../src/composition/home-lock.ts';
import {CoreLink,CoreRefusal} from '../src/composition/core.ts';
import {ConnectorService} from '../src/connectors/service.ts';
import {defaultToolEnv} from '../src/tools/places.ts';
import {freshDir,freshHome,value} from './helpers.ts';
const id='claude-code:notes';
type Fault='before-give'|'after-give'|'after-give-file'|'before-end'|'after-end'|'after-end-file';
type Signature={id:string;core?:1;home:string};
type RecordFile={ver?:number;pendingEnds?:{id:string;reason:string}[];servers:Record<string,{tools:Record<string,{standing?:Signature}>}>};
async function fixture(t:TestContext){
 const home=freshHome(),personHome=freshDir('signature-person-'),config=join(personHome,'.claude.json');
 const write=(variant='plain')=>writeFileSync(config,JSON.stringify({mcpServers:{notes:{command:process.execPath,args:[join(import.meta.dirname,'fake-mcp-server.ts')],env:{FAKE_MCP_VARIANT:variant}}}}));write();
 const real=await CoreLink.open({home});t.after(()=>real.close());
 const file=join(home,'connectors','mcp.json');const record=()=>JSON.parse(readFileSync(file,'utf8')) as RecordFile;
 let fault:Fault|undefined,faultText:string|undefined;
 const fire=(point:Fault)=>{if(fault===point){fault=undefined;throw new Error(faultText??`crash:${point}`);}};
 const watched=new Proxy(real,{get(target,key){const v=Reflect.get(target,key,target);if(typeof v!=='function')return v;
 if(key!=='call')return v.bind(target);
 return async(...args:unknown[])=>{
 const sql=String(args[1]);if(sql.includes('give_connector_signature'))fire('before-give');if(sql.includes('end_connector_signature')){assert.notEqual(record().servers[id].tools.draft_note.standing?.id,(args[2] as string[])[0],'old authority closes before Core end');assert.ok(record().pendingEnds?.length);fire('before-end');}
 const result=await v.apply(target,args);
 if(sql.includes('give_connector_signature'))fire('after-give');if(sql.includes('end_connector_signature'))fire('after-end');return result;
 };}}) as CoreLink;
 const env=defaultToolEnv({HOME:personHome,PATH:process.env.PATH});
 const make=()=>{const service=new ConnectorService({home,env:()=>env,link:async()=>watched,emit:()=>{
 const s=record();if(s.pendingEnds?.length)fire('after-end-file');else if(s.servers[id]?.tools.draft_note?.standing)fire('after-give-file');
 }});t.after(()=>service.close());return service;};
 const service=make();value(await service.refresh(id));value(await service.set(id,{enabled:true}));
 for(const name of ['draft_note','plain'])value(await service.set(id,{tool:{name,enabled:true}}));
 value(await service.set(id,{egress:true,seal:service.doorSeal(id)!}));
 const sign=()=>{const shown=service.toolView(id,'draft_note')!;return service.set(id,{seal:shown.seal,tool:{name:'draft_note',standing:{stamp:shown.stamp}}});};
 const ledger=async(type:string)=>(await real.read<{subject:string;payload:Record<string,unknown>}>(real.person(),'SELECT subject,payload FROM app.ledger WHERE entry_type=$1 ORDER BY seq',[type])).rows;
 return {home,file,record,real,service,make,sign,ledger,write,setFault:(f:Fault,text?:string)=>{fault=f;faultText=text;}};
}
test('signing records Core first and stores its UUID; every explicit end path records one terminal end',async t=>{
 const p=await fixture(t);
 const ends:[string,()=>Promise<unknown>,string][]=[
 ['explicit',()=>p.service.set(id,{tool:{name:'draft_note',standing:false}}),'person_revoked'],
 ['tool disabled',()=>p.service.set(id,{tool:{name:'draft_note',enabled:false}}),'person_revoked'],
 ['classification',()=>p.service.set(id,{tool:{name:'draft_note',override:'effect'}}),'definition_changed'],
 ['door closed',()=>p.service.set(id,{egress:false}),'person_revoked'],
 ['server disabled',()=>p.service.set(id,{enabled:false}),'person_revoked'],
 ];
 for(const [name,end,reason] of ends){
 value(await p.service.set(id,{enabled:true}));value(await p.service.set(id,{tool:{name:'draft_note',enabled:true}}));value(await p.service.set(id,{egress:true,seal:p.service.doorSeal(id)!}));
 value(await p.sign());const signature=p.record().servers[id].tools.draft_note.standing!;assert.equal(signature.core,1);
 assert.equal((await p.ledger('signature.given')).at(-1)!.subject,signature.id);
 await end();assert.equal(p.record().servers[id].tools.draft_note.standing,undefined,name);assert.equal(p.record().pendingEnds,undefined,name);
 assert.deepEqual((await p.ledger('signature.ended')).at(-1)!.payload,{signature:signature.id,reason},name);
 }
});
for(const point of ['before-give','after-give','after-give-file'] as const)test(`crash at ${point}: no unrecorded signature becomes usable`,async t=>{
 const p=await fixture(t);p.setFault(point);await assert.rejects(p.sign(),point==='after-give-file'?/crash:after-give-file/:/Core signature could not be confirmed/);
 const written=p.record().servers[id].tools.draft_note.standing,given=await p.ledger('signature.given');
 if(point==='before-give'){assert.equal(given.length,0);assert.equal(written,undefined);}
 else if(point==='after-give'){assert.equal(given.length,1);assert.equal(written,undefined);}
 else {assert.equal(given.length,1);assert.equal(written?.id,given[0].subject);}
 const reopened=p.make();await reopened.ready();assert.equal(!!reopened.list().servers[0].tools.find(t=>t.name==='draft_note')!.standing,point==='after-give-file');
});
for(const point of ['after-end-file','before-end','after-end'] as const)test(`crash at ${point}: local authority stays closed and Core end retries once`,async t=>{
 const p=await fixture(t);value(await p.sign());const signature=p.record().servers[id].tools.draft_note.standing!.id;
 p.setFault(point);await assert.rejects(p.service.set(id,{tool:{name:'draft_note',standing:false}}),point==='after-end-file'?/crash:after-end-file/:/signature end could not be confirmed/);
 assert.equal(p.record().servers[id].tools.draft_note.standing,undefined);assert.deepEqual(p.record().pendingEnds,[{id:signature,reason:'person_revoked'}]);
 const reopened=p.make();await reopened.ready();assert.equal(p.record().pendingEnds,undefined);
 assert.deepEqual((await p.ledger('signature.ended')).map(r=>r.payload),[{signature,reason:'person_revoked'}]);
 assert.equal(await p.real.call(p.real.person(),'SELECT gov.verify_ledger()'),null);
});
test('replacement ends the old UUID and cannot replay it; definition, missing connection and moved home end durably',async t=>{
 const p=await fixture(t);value(await p.sign());const first=p.record().servers[id].tools.draft_note.standing!.id;
 value(await p.sign());const second=p.record().servers[id].tools.draft_note.standing!.id;assert.notEqual(second,first);
 assert.deepEqual((await p.ledger('signature.ended')).at(-1)!.payload,{signature:first,reason:'superseded'});
 const moved=p.record();moved.servers[id].tools.draft_note.standing!.home='/synthetic/moved-home';writeFileSync(p.file,JSON.stringify(moved));await p.service.ready();
 assert.deepEqual((await p.ledger('signature.ended')).at(-1)!.payload,{signature:second,reason:'home_moved'});
 value(await p.sign());const third=p.record().servers[id].tools.draft_note.standing!.id;
 p.write('swapped');value(await p.service.refresh(id));
 // The fake variant changes search, so change the signed tool's saved definition explicitly and relist.
 const changed=p.record() as RecordFile & {servers:Record<string,{tools:Record<string,{definition:string;standing?:Signature}>}>};
 if(changed.servers[id].tools.draft_note.standing){changed.servers[id].tools.draft_note.definition='0'.repeat(64);writeFileSync(p.file,JSON.stringify(changed));value(await p.service.refresh(id));}
 assert.deepEqual((await p.ledger('signature.ended')).find(r=>r.subject===third)?.payload,{signature:third,reason:'definition_changed'});
 value(await p.service.set(id,{enabled:true}));value(await p.service.set(id,{egress:true,seal:p.service.doorSeal(id)!}));
 value(await p.service.set(id,{tool:{name:'draft_note',enabled:true}}));value(await p.sign());const fourth=p.record().servers[id].tools.draft_note.standing!.id;
 // Remove the configured connection; reopening cannot resurrect its signature.
 const absent=new ConnectorService({home:p.home,env:()=>defaultToolEnv({HOME:freshDir('signature-empty-'),PATH:process.env.PATH}),link:async()=>p.real});t.after(()=>absent.close());await absent.ready();
 assert.deepEqual((await p.ledger('signature.ended')).find(r=>r.subject===fourth)?.payload,{signature:fourth,reason:'connection_removed'});
});
test('an upgraded record with a legacy signature loses it; an empty record gains no authority',async t=>{
 const p=await fixture(t);assert.equal((await p.ledger('signature.given')).length,0);await p.service.ready();assert.equal((await p.ledger('signature.given')).length,0);
 value(await p.sign());const legacy=p.record(),signature=legacy.servers[id].tools.draft_note.standing!;delete signature.core;signature.id=randomUUID();writeFileSync(p.file,JSON.stringify(legacy));
 assert.equal(p.service.list().servers[0].tools.find(t=>t.name==='draft_note')!.standing,undefined,'without core: 1 it is never usable, even before ready retires it');
 const reopened=p.make();await reopened.ready();assert.equal(p.record().servers[id].tools.draft_note.standing,undefined);
 assert.equal(reopened.list().servers[0].tools.find(t=>t.name==='draft_note')!.standing,undefined);
 const shown=reopened.toolView(id,'draft_note')!;value(await reopened.set(id,{seal:shown.seal,tool:{name:'draft_note',standing:{stamp:shown.stamp}}}));
 assert.equal(p.record().servers[id].tools.draft_note.standing!.core,1);assert.equal((await p.ledger('signature.given')).length,2);
});

test('a changed give body cannot mint file authority without its given ledger row',async t=>{
 const p=await fixture(t),admin=new pg.Client({connectionString:dataHomeAdminUrl(p.home)});await admin.connect();t.after(()=>admin.end());
 const original=(await admin.query("SELECT pg_get_functiondef('gov.give_connector_signature(uuid,text,text)'::regprocedure) AS sql")).rows[0].sql;
 try{
 await admin.query("CREATE OR REPLACE FUNCTION gov.give_connector_signature(p_connection uuid,p_tool text,p_definition text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN RETURN gen_random_uuid(); END $$");
 const refused=await p.sign();assert.equal(refused.ok,false);assert.match(refused.ok?'':refused.detail,/Signature definitions differ/);
 assert.equal(p.record().servers[id].tools.draft_note.standing,undefined);assert.equal((await p.ledger('signature.given')).length,0);
 }finally{await admin.query(original);}
 value(await p.sign());assert.equal((await p.ledger('signature.given')).length,1);
});

for(const pending of [false,true])test(`connector record and pending ends require admitted connector storage, pending=${pending}`,async t=>{
 const p=await fixture(t);value(await p.sign());
 if(pending){p.setFault('before-end');await assert.rejects(p.service.set(id,{tool:{name:'draft_note',standing:false}}),/signature end could not be confirmed/);}
 const before=readFileSync(p.file,'utf8'),ends=await p.ledger('signature.ended'),statfs=fs.statfsSync;
 t.mock.method(fs,'statfsSync',((path:fs.PathLike)=>({...statfs(path),type:String(path)===join(p.home,'connectors')?0x6969:statfs(path).type})) as typeof fs.statfsSync);
 await assert.rejects(pending?p.service.ready():p.service.set(id,{tool:{name:'draft_note',standing:false}}),error=>error instanceof HomeWriteUnavailable&&error.code==='filesystem');
 assert.equal(readFileSync(p.file,'utf8'),before,'no grant, pending end, or version write outside admission');
 assert.deepEqual(await p.ledger('signature.ended'),ends,'admission precedes crossing the end into Core');
});
for(const point of ['before-give','before-end'] as const)test(`signature crossing error text is withheld at ${point}`,async t=>{
 const p=await fixture(t),secret='opaque-backend-credential-94';
 if(point==='before-end')value(await p.sign());
 p.setFault(point,`backend context: server=${secret} argv=${secret} env=${secret}`);
 await assert.rejects(point==='before-give'?p.sign():p.service.set(id,{tool:{name:'draft_note',standing:false}}),error=>{
  assert.ok(error instanceof Error);assert.equal(error.message.includes(secret),false);
  assert.match(error.message,/could not be confirmed/);return true;
 });
 if(point==='before-end')assert.equal(p.record().pendingEnds?.length,1);
 else assert.equal(p.record().servers[id].tools.draft_note.standing,undefined);
});

test('give and end diagnostics retain only a recognised Core reason code',async t=>{
 const p=await fixture(t),call=p.real.call.bind(p.real),secret='opaque-signature-diagnostic-97';
 let failing='give_connector_signature',reason='denied';
 p.real.call=(async(...args:Parameters<CoreLink['call']>)=>{
  if(String(args[1]).includes(failing))throw new CoreRefusal(reason,`backend ${secret}`);
  return call(...args);
 }) as CoreLink['call'];
 const safe=(expected:string)=>(error:unknown)=>{
  assert.ok(error instanceof Error);assert.equal((error as CoreRefusal).reason,expected);
  assert.equal(JSON.stringify(error).includes(secret),false);assert.equal(error.message.includes(secret),false);assert.equal(error.cause,undefined);return true;
 };
 await assert.rejects(p.sign(),safe('denied'));
 reason=secret;await assert.rejects(p.sign(),safe('unclassified'));
 failing='unused';value(await p.sign());failing='end_connector_signature';reason='denied';
 await assert.rejects(p.service.set(id,{tool:{name:'draft_note',standing:false}}),safe('denied'));
 assert.equal(p.record().servers[id].tools.draft_note.standing,undefined);assert.ok(p.record().pendingEnds?.length);
 assert.equal(readFileSync(p.file,'utf8').includes(secret),false);
 p.real.call=call;await p.service.ready();assert.equal(p.record().pendingEnds,undefined);
});

test('signature give, end and decision crossings never wait under the home lock',async t=>{
 const p=await fixture(t),call=p.real.call.bind(p.real),read=p.real.read.bind(p.real);
 p.real.call=(async(...args:Parameters<CoreLink['call']>)=>{
  assert.equal(inActiveHomeLockScope(p.home),false,`Core call under home lock: ${String(args[1])}`);return call(...args);
 }) as CoreLink['call'];
 p.real.read=(async(...args:Parameters<CoreLink['read']>)=>{
  assert.equal(inActiveHomeLockScope(p.home),false,`Core read under home lock: ${String(args[1])}`);return read(...args);
 }) as CoreLink['read'];
 value(await p.sign());value(await p.service.set(id,{tool:{name:'draft_note',standing:false}}));
 const core={readObserved:async()=>{throw Error('unexpected read');}} as unknown as import('../src/connectors/service.ts').ConnectorCore;
 const offered=p.service.offered().find(t=>t.tool==='draft_note')!;
 assert.equal((await p.service.call(offered,{text:'lock boundary'},core,{threadId:'t',turnId:'lock-boundary',seq:1},new AbortController().signal)).outcome,'HELD');
 const held=p.service.list().held[0];value(await p.service.decide(held.effect,held.argsHash,'discard'));
});
test('a local narrowing during Core give prevents the tentative signature from being persisted',async t=>{
 const p=await fixture(t),call=p.real.call.bind(p.real);let changed=false;
 p.real.call=(async(...args:Parameters<CoreLink['call']>)=>{
  const result=await call(...args);
  if(!changed&&String(args[1]).includes('give_connector_signature')){
   changed=true;value(await p.service.set(id,{tool:{name:'draft_note',enabled:false}}));
  }
  return result;
 }) as CoreLink['call'];
 const signed=await p.sign();assert.equal(changed,true);assert.equal(signed.ok,false);
 assert.equal(p.record().servers[id].tools.draft_note.standing,undefined);
 assert.equal(p.service.offered().some(t=>t.tool==='draft_note'),false);
 assert.equal((await p.ledger('signature.given')).length,1,'the unused Core grant is evidence, not local authority');
});
