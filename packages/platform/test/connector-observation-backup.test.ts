// Offline export/restore boundary: real Store, journal, export and import owners; synthetic API
// and Core confirmation only. No native SQL, provider, model, client process or live home.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import type {MaterialEntry} from '../src/api.ts';
import {exportHome,inspectExport,importHome,type ExportSource,type ImportApi} from '../src/composition/backup.ts';
import {ConnectorObservations,type ConnectorObservation,type RetainedConnectorResponse} from '../src/composition/connector-observations.ts';
import {readMaterialFile} from '../src/composition/material-file-read.ts';
import type {MaterialSourceReadRequest} from '../src/composition/core.ts';
import {ThreadJournal} from '../src/composition/thread-journal.ts';
import {withHomeLock} from '../src/composition/home-lock.ts';
import {connectorMaterialLabel,MaterialStore} from '../src/stub/material.ts';
import {sha256} from '../src/stub/fsx.ts';

const WORKSPACE='11111111-1111-4111-8111-111111111111',CONNECTION='22222222-2222-4222-8222-222222222222';
const JOURNAL_ONLY='PRIVATE_JOURNAL_ONLY_RESPONSE_NOT_AN_EXPORTED_DOCUMENT';
function fixture(t:TestContext){
 const root=mkdtempSync(join(tmpdir(),'connector-observation-backup-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const home=join(root,'source'),target=join(root,'restored'),to=join(root,'export');mkdirSync(home);mkdirSync(target);
 const material=new MaterialStore(home,{},()=>{}),journal=new ThreadJournal(home),observations=new ConnectorObservations(home,journal);
 const scope={workspace:WORKSPACE,project:'source-project',thread:'source-thread',turn:'source-turn',run:'source-run'};
 const source:ExportSource={home,projects:[{id:scope.project,name:'Original project',kind:'folder'}],documents:project=>material.list(project,true),
  versionPath:(id,version)=>join(home,'material',id,'versions',String(version)),threads:[],receipts:async()=>[],secrets:async()=>[]};
 async function retain(name:string,state:'pending'|'registered'|'discarded'):Promise<{observation:ConnectorObservation;entry:MaterialEntry;body:string}>{
  return withHomeLock(home,async()=>{
   observations.startProtocol(scope);
   const o=observations.reserve({scope,origin:{engine:'codex',namespace:'synthetic-native-thread-and-turn',callId:randomUUID()},serverId:'synthetic-server',serverName:'Synthetic server',connection:CONNECTION,tool:'read',launch:'a'.repeat(64),definition:'b'.repeat(64),argsJson:'{}'}).observation;
   observations.beginDispatch(o.id);
   const body=JSON.stringify({value:name+' retained bytes'});
   const response:RetainedConnectorResponse={status:'complete',text:JOURNAL_ONLY,material:{name,mediaType:'application/json',body},episodeContent:body,preparedText:JSON.stringify({status:'complete',text:body}),transformation:{kind:'synthetic-backup-fixture',version:'1'}};
   observations.retainResponse(o.id,response);
   let entry=material.retainConnectorObservation({id:o.materialId,observation:o.id,projectId:scope.project,name,mediaType:'application/json',body,connection:CONNECTION,tool:'read'});
   observations.retainMaterial(o.id,sha256(body));
   if(state==='registered'){
    // These synthetic IDs arrange historical fixture state, never a native Core proof or grant.
    const receipt={workspace:WORKSPACE,readKey:o.readKey,episode:randomUUID(),receipt:randomUUID()};
    observations.retainTentative(o.id,receipt);observations.confirm(o.id,receipt);entry=material.registerConnectorObservation(entry.id,o.id,sha256(body));
   }else if(state==='discarded'){entry=material.withdraw(entry.id);observations.discard(o.id);}
   return {observation:observations.get(o.id)!,entry,body};
  });
 }
 function destination(){
  const restored=new MaterialStore(target,{},()=>{}),projects:{id:string;name:string;kind:string}[]=[],writes:string[]=[];
  // The public person import methods are synthetic here; actual document storage uses its owner.
  const api:ImportApi={call:(async(method:string,args:Record<string,unknown>)=>{
   if(method==='projects.list')return projects;
   if(method==='threads.list')return [];
   if(method==='memory.get')return {entries:[],proposed:[],instructions:{person:'',project:''},skills:[]};
   if(method==='projects.create'){const project={id:randomUUID(),name:String(args.name),kind:String(args.kind)};projects.push(project);writes.push(method);return {ok:true,value:project};}
   if(method==='material.attach'){writes.push(String(args.name));return {ok:true,value:restored.create(String(args.projectId),String(args.name),String(args.mediaType),Buffer.from(String(args.base64),'base64'),'original','person')};}
   throw new Error('Unexpected synthetic import API method: '+method);
  }) as ImportApi['call'],addDocument:async(...args)=>{writes.push(args[1]);return restored.importDocument(...args);},
  proposeSkill:async()=>{throw new Error('No skill was exported.');},importMemory:async()=>{throw new Error('No memory was exported.');},hasSkills:()=>false};
  return {restored,projects,writes,api};
 }
 return {root,home,target,to,material,journal,observations,scope,source,retain,destination};
}
function exportedMetadata(from:string){
 const read=inspectExport(from);
 const docs=[...read.files].filter(([path])=>/^projects\/p\d+\/documents\/d\d+\/meta\.json$/.test(path)).map(([path,data])=>({path,meta:JSON.parse(data.toString()) as Record<string,unknown>}));
 return {read,docs};
}

for(const marker of ['pending','future-unrecognized-state'])test(`backup marks ${marker} observation hidden, retains its bytes and skips it in plan and restore`,async t=>{
 const f=fixture(t),pending=await f.retain('Pending.json','pending');
 assert.equal(pending.entry.hidden,false,'the original unsafe export must be distinguished from an already hidden input');
 if(marker!=='pending')writeFileSync(join(f.home,'material',pending.entry.id,'meta.json'),JSON.stringify({...pending.entry,observation:{id:pending.observation.id,state:marker}}));
 const originalMeta=readFileSync(join(f.home,'material',pending.entry.id,'meta.json')),originalBytes=readFileSync(join(f.home,'material',pending.entry.id,'versions','1'));
 await withHomeLock(f.home,async()=>exportHome(f.source,{to:f.to}));
 const {read,docs}=exportedMetadata(f.to);
 const plan=await importHome({from:f.to,home:f.target,dryRun:true});
 const dest=f.destination();const imported=await withHomeLock(f.target,async()=>importHome({from:f.to,home:f.target,api:dest.api}));
 const project=dest.projects.find(value=>value.name==='Original project')!;assert.ok(project);
 // Exercise the full restore before the assertions: the old export must actually demonstrate
 // the unsafe admission, rather than fail only a metadata-format expectation.
 assert.deepEqual(dest.restored.available(project.id),[],'pending observation must never become restored agent input');
 assert.deepEqual(dest.restored.list(project.id,true),[]);assert.equal(dest.writes.includes('Pending.json'),false);
 assert.equal(plan.adds.documents,0);assert.equal(plan.skipped.length,1);assert.match(plan.skipped[0],/Pending\.json.*hidden/);
 assert.equal(imported.done,true);assert.equal(imported.adds.documents,0);
 assert.equal(docs.length,1);assert.equal(docs[0].meta.hidden,true);assert.equal(docs[0].meta.withdrawn,false);
 const version=docs[0].path.replace(/meta\.json$/,'v1');assert.deepEqual(read.files.get(version),originalBytes,'export remains retained inspection data');
 assert.equal(read.manifest.files[version],sha256(originalBytes));
 for(const key of ['observation','fromServer','run','runId','readKey','confirmation','receipt'])assert.equal(docs[0].meta[key],undefined,'export carries no active observation/Core grant');
 assert.deepEqual(readFileSync(join(f.home,'material',pending.entry.id,'meta.json')),originalMeta);assert.deepEqual(readFileSync(join(f.home,'material',pending.entry.id,'versions','1')),originalBytes,'source evidence is preserved');
 assert.ok(readFileSync(f.journal.path,'utf8').includes(JOURNAL_ONLY));
 assert.equal([...read.files.keys()].some(path=>path.includes('thread-journal')),false,'raw private journal is never an export input');
 assert.equal([...read.files.values()].some(data=>data.includes(Buffer.from(JOURNAL_ONLY))),false,'the raw retained response never enters export through its journal');
});

test('discarded/withdrawn observation bytes stay in export evidence but never enter restored agent material',async t=>{
 const f=fixture(t),discarded=await f.retain('Discarded.json','discarded');
 await withHomeLock(f.home,async()=>exportHome(f.source,{to:f.to}));const {read,docs}=exportedMetadata(f.to);
 assert.equal(docs[0].meta.withdrawn,true);assert.deepEqual(read.files.get(docs[0].path.replace(/meta\.json$/,'v1')),Buffer.from(discarded.body));
 const plan=await importHome({from:f.to,home:f.target,dryRun:true});assert.equal(plan.adds.documents,0);assert.match(plan.skipped[0],/Discarded\.json.*withdrawn/);
 const dest=f.destination();await withHomeLock(f.target,async()=>importHome({from:f.to,home:f.target,api:dest.api}));
 const project=dest.projects.find(value=>value.name==='Original project')!;assert.deepEqual(dest.restored.available(project.id),[]);assert.equal(dest.writes.includes('Discarded.json'),false);
 assert.equal(f.observations.get(discarded.observation.id)!.phase,'discarded');assert.deepEqual(Buffer.from(f.material.bytes(discarded.entry.id,1)),Buffer.from(discarded.body));
});

test('registered observations restore only as fresh unauthored file data, with no imported MCP or receipt authority',async t=>{
 const f=fixture(t),registered=await f.retain('Registered.json','registered');
 await withHomeLock(f.home,async()=>exportHome(f.source,{to:f.to}));const {read,docs}=exportedMetadata(f.to);
 assert.equal(docs[0].meta.hidden,false);assert.equal(docs[0].meta.withdrawn,false);
 const plan=await importHome({from:f.to,home:f.target,dryRun:true});assert.equal(plan.adds.documents,1);assert.deepEqual(plan.skipped,[]);
 const dest=f.destination();await withHomeLock(f.target,async()=>importHome({from:f.to,home:f.target,api:dest.api}));
 const project=dest.projects.find(value=>value.name==='Original project')!,entry=dest.restored.available(project.id).find(value=>value.name==='Registered.json')!;assert.ok(entry);
 assert.notEqual(entry.id,registered.entry.id);assert.equal(entry.restored,true);assert.equal(entry.fromServer,undefined);assert.equal(entry.observation,undefined);
 assert.equal(entry.versions[0].by,'agent','historical label remains data; it does not assert a Core author');
 assert.equal(JSON.stringify(entry).includes(registered.observation.readKey),false);assert.equal(JSON.stringify(entry).includes(registered.observation.confirmation!.receipt),false);
 const recorded:MaterialSourceReadRequest[]=[];
 await readMaterialFile({home:f.target,material:dest.restored,projectId:project.id,threadId:'synthetic-restored-thread',turnId:'synthetic-restored-turn',
  handle:{run:randomUUID(),fence:1,secret:'synthetic-unused'},journal:new ThreadJournal(f.target),
  link:{id:{workspace:WORKSPACE},async recordMaterialSourceRead(_handle,payload,retain,signal){signal.throwIfAborted();recorded.push(payload);const receipt={workspace:WORKSPACE,readKey:payload.readKey,episode:randomUUID(),receipt:randomUUID()};retain(receipt);return receipt;}},
 },{materialId:entry.id,name:entry.name,version:1,withdrawals:0,profile:'harness'});
 assert.equal(recorded.length,1);assert.equal(recorded[0].sourceKind,'file');assert.equal(recorded[0].authoredBy,null);assert.equal(recorded[0].connection,undefined);assert.equal(recorded[0].tool,undefined);
 // Known legacy backup limit: registration does not make export an authenticated provenance format.
 assert.equal([...read.files.keys()].some(path=>path.includes('thread-journal')),false);
 assert.equal([...read.files.values()].some(data=>data.includes(Buffer.from(JOURNAL_ONLY))),false);
});


test('a bounded label from long provider identities survives real export/restore without importing connector authority',async t=>{
 const f=fixture(t),observation='f'.repeat(64),serverName='Server/'+ '😀'.repeat(800),tool='read\\path\r\n'+ 't'.repeat(1100);
 const name=connectorMaterialLabel(serverName,tool,observation);
 const registered=await f.retain(name,'registered'),before=readFileSync(join(f.home,'material',registered.entry.id,'meta.json'));
 await withHomeLock(f.home,async()=>exportHome(f.source,{to:f.to}));
 const {read,docs}=exportedMetadata(f.to);assert.equal(docs.length,1);assert.equal(docs[0].meta.name,name);
 const originalBytes=Buffer.from(f.material.bytes(registered.entry.id,1));
 assert.deepEqual(read.files.get(docs[0].path.replace(/meta\.json$/,'v1')),originalBytes);
 const dest=f.destination();await withHomeLock(f.target,async()=>importHome({from:f.to,home:f.target,api:dest.api}));
 const project=dest.projects.find(value=>value.name==='Original project')!,restored=dest.restored.available(project.id);
 assert.equal(restored.length,1);assert.equal(restored[0].name,name);assert.equal(restored[0].restored,true);
 assert.notEqual(restored[0].id,registered.entry.id);assert.equal(restored[0].fromServer,undefined);assert.equal(restored[0].observation,undefined);
 assert.deepEqual(Buffer.from(dest.restored.bytes(restored[0].id,1)),originalBytes);
 assert.deepEqual(readFileSync(join(f.home,'material',registered.entry.id,'meta.json')),before);
});
