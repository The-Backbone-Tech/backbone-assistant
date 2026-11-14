import { waitFor } from '../../../scripts/lib/test-hang.ts';
import { hangDetector } from '../../../scripts/lib/test-hang.ts';
// Removal is local even without Core; reads never reconcile a connector record.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs,{readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import type {Receipt,ConnectorServer} from '../src/api.ts';
import {CoreLink} from '../src/composition/core.ts';
import {createHost,hostClosed} from '../src/composition/host.ts';
import {assertHomeWriteAdmission,withHomeLock} from '../src/composition/home-lock.ts';
import {ConnectorService,type ConnectorCore} from '../src/connectors/service.ts';
import {writeJson} from '../src/stub/fsx.ts';
import {defaultToolEnv} from '../src/tools/places.ts';
import {freshDir,freshHome,value} from './helpers.ts';
const server='claude-code:notes';

function bytes(home:string):string {const walk=(at:string):unknown=>fs.readdirSync(at).sort().map(name=>{const path=join(at,name),s=fs.lstatSync(path);return [name,s.mode,s.isDirectory()?walk(path):s.isFile()?readFileSync(path).toString('hex'):'special'];});return JSON.stringify(walk(home));}
async function fixture(t:TestContext){
 const home=freshHome(),person=freshDir('connector-offline-person-'),file=join(home,'connectors','mcp.json'),config=join(person,'.claude.json'),log=join(person,'calls.jsonl');
 writeFileSync(config,JSON.stringify({mcpServers:{notes:{command:process.execPath,args:[join(import.meta.dirname,'fake-mcp-server.ts')],env:{FAKE_MCP_LOG:log}}}}));
 const link=await CoreLink.open({home});t.after(()=>link.close());
 let obtain:()=>Promise<CoreLink>=async()=>link;
 const env=defaultToolEnv({HOME:person,PATH:process.env.PATH});
 // Complete first run before installing the legacy/pending authority fixture. A reader must
 // inspect that record without also being responsible for creating the home's local stores.
 const seed=createHost({home,harness:'stub',connectors:{env,sources:['claude-code']}});
 try{await seed.call('projects.list',{});}finally{seed.close();await hostClosed(home);}
 const make=()=>new ConnectorService({home,env:()=>env,link:()=>obtain()});
 const service=make();t.after(()=>service.close());
 value(await service.refresh(server));value(await service.set(server,{enabled:true}));value(await service.set(server,{tool:{name:'draft_note',enabled:true}}));
 value(await service.set(server,{egress:true,seal:service.doorSeal(server)!}));
 const sign=()=>{const shown=service.toolView(server,'draft_note')!;return service.set(server,{seal:shown.seal,tool:{name:'draft_note',standing:{stamp:shown.stamp}}});};
 const read=()=>JSON.parse(readFileSync(file,'utf8'));
 return {home,person,file,config,log,link,env,make,service,sign,read,offline:(mode:string)=>{obtain=mode==='reject'?async()=>{throw Error('Synthetic Core unavailable');}:()=>new Promise(()=>{});},online:()=>{obtain=async()=>link;},linkFrom:(pending:Promise<CoreLink>)=>{obtain=()=>pending;}};
}
for(const mode of ['reject','never'])for(const action of ['door','server','tool','signature','connection'])test(`${action} removal is local with ${mode} Core and drains after restart`,async t=>{
 const p=await fixture(t);value(await p.sign());const id=p.read().servers[server].tools.draft_note.standing.id;
 const offered=p.service.offered().find(x=>x.tool==='draft_note')!;
 p.offline(mode);
 if(action==='connection')writeFileSync(p.config,JSON.stringify({mcpServers:{}}));
 const operation=action==='connection'?p.service.ready():p.service.set(server,action==='door'?{egress:false}:action==='server'?{enabled:false}:action==='tool'?{tool:{name:'draft_note',enabled:false}}:{tool:{name:'draft_note',standing:false}});
 const result=await hangDetector<void | Receipt<ConnectorServer>>(operation,'removal waited for Core');if(result)value(result);
 const state=p.read();assert.equal(state.servers[server].tools.draft_note.standing,undefined);
 assert.deepEqual(state.pendingEnds,[{id,reason:action==='connection'?'connection_removed':'person_revoked'}]);
 const core={readObserved:async()=>{throw Error('effect entered the read port');}} as unknown as ConnectorCore;
 const call=await hangDetector(p.service.call(offered,{text:'must not send'},core,{threadId:'synthetic',turnId:'offline',seq:1},new AbortController().signal),'call waited indefinitely for Core');
 assert.ok(call.outcome==='HELD'||call.outcome==='REFUSED');assert.equal(fs.existsSync(p.log),false);
 await p.service.close();p.online();const restarted=p.make();t.after(()=>restarted.close());await restarted.ready();
 assert.equal(p.read().pendingEnds,undefined);
 assert.deepEqual((await p.link.read<{payload:unknown}>(p.link.person(),"SELECT payload FROM app.ledger WHERE entry_type='signature.ended' AND subject=$1",[id])).rows,[{payload:{signature:id,reason:action==='connection'?'connection_removed':'person_revoked'}}]);
});
for(const mode of ['reject','never'])test(`giving without ${mode} Core refuses plainly without changing any home byte`,async t=>{
 const p=await fixture(t);p.offline(mode);const before=bytes(p.home);
 const result=await hangDetector(p.sign(),'give waited indefinitely for Core');
 assert.equal(result.ok,false);assert.equal(result.ok?'':result.reason,'NOT_AVAILABLE');assert.match(result.ok?'':result.detail,/Core.*unavailable|Core.*not.*available/);
 assert.equal(bytes(p.home)===before,true,'home bytes changed');
});
for(const kind of ['legacy','pending'])test(`read-only Host lists ${kind} authority without any write or Core query; writable startup reconciles`,async t=>{
 const p=await fixture(t);value(await p.sign());await p.service.close();
 const id=p.read().servers[server].tools.draft_note.standing.id;
 await withHomeLock(p.home,async()=>{
  const state=p.read();if(kind==='legacy'){delete state.servers[server].tools.draft_note.standing.core;state.servers[server].tools.draft_note.standing.id=randomUUID();}
  else{delete state.servers[server].tools.draft_note.standing;state.pendingEnds=[{id,reason:'person_revoked'}];}
  state.ver=(state.ver??0)+1;assertHomeWriteAdmission(p.home,join(p.home,'connectors'));writeJson(p.file,state);
 });
 let host=createHost({home:p.home,readOnly:true,harness:'stub',connectors:{env:p.env,sources:['claude-code']}});
 try{
  await host.call('core.signatureStatus',{});
  let queries=0;const original=CoreLink.prototype.read;
  t.mock.method(CoreLink.prototype,'read',function(this:CoreLink,...args:Parameters<typeof original>){queries++;return original.apply(this,args);});
  const before=bytes(p.home);
  const view=await host.call('connectors.list',{});assert.equal(view.servers[0].tools.find(x=>x.name==='draft_note')!.standing,undefined);
  host.connectorDoorView(server);host.connectorToolView(server,'draft_note');
  assert.equal(queries,0);assert.equal(bytes(p.home)===before,true,'home bytes changed');
  t.mock.restoreAll();
 }finally{host.close();await hostClosed(p.home);}
 host=createHost({home:p.home,harness:'stub',connectors:{env:p.env,sources:['claude-code']}});
 try{
  await host.call('core.signatureStatus',{});
  await waitFor(()=>!p.read().pendingEnds?.length&&!p.read().servers[server].tools.draft_note.standing,'connector closure after Host reopen',{diagnostic:()=>JSON.stringify({pending:p.read().pendingEnds?.length})});
  assert.equal(p.read().pendingEnds,undefined);assert.equal(p.read().servers[server].tools.draft_note.standing,undefined);
  if(kind==='pending'){
   const link=await CoreLink.open({home:p.home});try{assert.equal((await link.read(link.person(),"SELECT subject FROM app.ledger WHERE entry_type='signature.ended' AND subject=$1",[id])).rows.length,1);}finally{await link.release();}
  }
 }finally{host.close();await hostClosed(p.home);}
});
test('read helpers on missing or invalid seal keys are conservative and never create a key',async t=>{
 const p=await fixture(t);await p.service.close();const key=join(p.home,'connectors','.seal-key');
 for(const state of ['missing','invalid']){
  if(state==='missing')fs.rmSync(key);else writeFileSync(key,'invalid');
  const reader=new ConnectorService({home:p.home,reconcileOnOpen:false,env:()=>p.env,link:()=>{throw Error('read asked for Core');}});t.after(()=>reader.close());
  const before=bytes(p.home);reader.list();reader.offered();reader.doorView(server);reader.doorSeal(server);reader.toolView(server,'draft_note');reader.readNeedsAsking(server,'draft_note');void reader.used;
  assert.equal(bytes(p.home)===before,true,'home bytes changed');assert.equal(reader.doorView(server),null);
 }
});

test('a link arriving after local closure drains the pending end without another mutation',async t=>{
 const p=await fixture(t);value(await p.sign());const id=p.read().servers[server].tools.draft_note.standing.id;
 let arrive!:(link:CoreLink)=>void;const pending=new Promise<CoreLink>(resolve=>{arrive=resolve;});p.linkFrom(pending);
 value(await hangDetector(p.service.set(server,{egress:false}),'closure waited for the arriving Core'));
 assert.notEqual(p.read().servers[server].egress,true);assert.deepEqual(p.read().pendingEnds,[{id,reason:'person_revoked'}]);
 arrive(p.link);
 await waitFor(()=>!p.read().pendingEnds?.length,'connector closure after Core arrives',{diagnostic:()=>JSON.stringify({pending:p.read().pendingEnds?.length})});
 assert.equal(p.read().pendingEnds,undefined);
 assert.equal((await p.link.read(p.link.person(),"SELECT subject FROM app.ledger WHERE entry_type='signature.ended' AND subject=$1",[id])).rows.length,1);
});

test('the first local-only mutation retires legacy authority even without a Core link',async t=>{
 const p=await fixture(t);value(await p.sign());await p.service.close();
 await withHomeLock(p.home,async()=>{const state=p.read();delete state.servers[server].tools.draft_note.standing.core;assertHomeWriteAdmission(p.home,join(p.home,'connectors'));writeJson(p.file,state);});
 const writer=new ConnectorService({home:p.home,reconcileOnOpen:false,env:()=>p.env,link:()=>new Promise(()=>{})});t.after(()=>writer.close());
 value(await hangDetector(writer.set(server,{tool:{name:'plain',enabled:false}}),'local-only mutation waited for Core'));
 assert.equal(p.read().servers[server].tools.draft_note.standing,undefined);
 assert.equal(p.read().pendingEnds,undefined,'a legacy file id never becomes a Core end');
});
