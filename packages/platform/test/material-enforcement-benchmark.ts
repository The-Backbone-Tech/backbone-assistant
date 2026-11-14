// Explicit dated qualification benchmark; intentionally outside the ordinary *.test.ts suite.
// Native disposable PostgreSQL only, after independent frozen-source approval. No provider.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {test,type TestContext} from 'node:test';
import pg from 'pg';
import {CoreLink} from '../src/composition/core.ts';
import {verifyMaterialEnforcement} from '@backbone/core/db';
import {dataHomeAdminUrl} from '@backbone/core/testing';
import {freshHome} from './helpers.ts';

const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
const READ='SELECT * FROM gov.record_material_source_read($1::text,$2::text,$3::integer,$4::integer,$5::text,$6::text,$7::jsonb,$8::text,$9::text,$10::text,$11::uuid,$12::uuid,$13::uuid,$14::uuid,$15::text)';
interface Memory {total:number;used:number}
interface Sample {kind:'ordinary'|'reserved';enabled:boolean;rows:number;payloadBytes:number;statementMs:number;commitMs:number;totalMs:number;before:Memory;queued:Memory;after:Memory}
async function context(t:TestContext){
 const home=freshHome();let link:CoreLink|undefined;const admin=new pg.Client({connectionString:dataHomeAdminUrl(home),connectionTimeoutMillis:2000});
 admin.on('error',()=>{});t.after(async()=>{if(link){await link.close();await CoreLink.whenClosed(home);}await admin.end();});
 await admin.connect();link=await CoreLink.open({home});assert.equal(link.materialEnforcement.state,'verified');
 const handle=await link.startRun(await link.createTask('Synthetic material benchmark'));
 return {home,link,admin,handle};
}
type Context=Awaited<ReturnType<typeof context>>;
async function memory(c:Context):Promise<Memory>{
 // Read this same backend's contexts as the fixture administrator. This is not an app grant.
 await c.admin.query('RESET ROLE');
 const row=(await c.admin.query(`SELECT sum(total_bytes)::text AS total,sum(used_bytes)::text AS used FROM pg_catalog.pg_get_backend_memory_contexts()`)).rows[0];
 const result={total:Number(row.total),used:Number(row.used)};
 assert.ok(Number.isSafeInteger(result.total)&&Number.isSafeInteger(result.used));return result;
}
async function measure(c:Context,kind:Sample['kind'],enabled:boolean,rows:number,payloadBytes:number,perform:()=>Promise<void>):Promise<Sample>{
 await c.admin.query(`ALTER TABLE app.episodes ${enabled?'ENABLE ALWAYS':'DISABLE'} TRIGGER material_source_receipt`);
 await c.admin.query('BEGIN ISOLATION LEVEL READ COMMITTED');
 try{
  await c.admin.query("SET LOCAL statement_timeout='120s'; SET LOCAL lock_timeout='5s'");
  await c.admin.query(`SELECT set_config('backbone.workspace',$1,true),set_config('backbone.principal',$2,true),set_config('backbone.run','',true),set_config('backbone.secret','',true)`,[c.link.id.workspace,c.link.id.system]);
  const before=await memory(c);await c.admin.query('SET LOCAL ROLE backbone_app');
  const started=performance.now();await perform();const inserted=performance.now();
  const queued=await memory(c);await c.admin.query('SET LOCAL ROLE backbone_app');const committing=performance.now();
  assert.equal((await c.admin.query('COMMIT')).command,'COMMIT');const committed=performance.now();const after=await memory(c);
  return {kind,enabled,rows,payloadBytes,statementMs:inserted-started,commitMs:committed-committing,totalMs:(inserted-started)+(committed-committing),before,queued,after};
 }finally{await c.admin.query('ROLLBACK').catch(()=>{});await c.admin.query('RESET ROLE');}
}
function summary(samples:Sample[]){
 const keys=[...new Set(samples.map(s=>JSON.stringify([s.kind,s.enabled,s.rows,s.payloadBytes])))];
 const median=(xs:number[])=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)];
 return keys.map(key=>{
  const matching=samples.filter(s=>JSON.stringify([s.kind,s.enabled,s.rows,s.payloadBytes])===key),first=matching[0];
  return {kind:first.kind,enabled:first.enabled,rows:first.rows,payloadBytes:first.payloadBytes,rounds:matching.length,
   medianStatementMs:median(matching.map(s=>s.statementMs)),medianCommitMs:median(matching.map(s=>s.commitMs)),
   medianTotalNsPerRow:median(matching.map(s=>s.totalMs*1e6/s.rows)),
   medianQueuedUsedDeltaBytes:median(matching.map(s=>s.queued.used-s.before.used)),
   medianQueuedTotalDeltaBytes:median(matching.map(s=>s.queued.total-s.before.total))};
 });
}
function report(t:TestContext,samples:Sample[]){
 t.diagnostic(JSON.stringify({benchmark:'material-enforcement-F7',clock:'performance.now',memory:'same-backend pg_get_backend_memory_contexts total/used before statement, while events queued, after COMMIT',samples,summary:summary(samples),
  qualification:'Administrator session SET LOCAL ROLE backbone_app executes crossings; memory temporarily resets to administrator. This is not a new service privilege or a true app-login authorization control.',
  limits:'Backend memory contexts exclude shared buffers, client memory and full OS RSS. Samples are not a peak allocator trace. Test cluster may disable fsync/synchronous_commit; no physical durability or production-latency claim. Role/memory sampling excluded from reported statement+COMMIT time. No arbitrary performance threshold.'}));
}

test('F7: ordinary 1, 1000 and 100000 inserts per transaction, ALWAYS versus disabled, elapsed time and queued backend memory',{timeout:20*60_000},async t=>{
 const c=await context(t),samples:Sample[]=[];
 try{
  // Small warmup does not hide the large transaction's queued-event cost.
  for(const enabled of [false,true])await measure(c,'ordinary',enabled,10,Buffer.byteLength('Ordinary source'),async()=>{
   const result=await c.admin.query("SELECT gov.record_source('message','synthetic-benchmark','Ordinary source',NULL,NULL,NULL) FROM generate_series(1,10)");assert.equal(result.rows.length,10);
  });
  for(const rows of [1,1000,100000])for(let round=0;round<3;round++)for(const enabled of round%2?[true,false]:[false,true]){
   t.diagnostic(JSON.stringify({benchmark:'material-enforcement-F7-progress',kind:'ordinary',round,enabled,rows,statementBatchRows:1000,phase:'starting'}));
   const sample=await measure(c,'ordinary',enabled,rows,Buffer.byteLength('Ordinary source'),async()=>{
    // Bound only each SQL statement, never the transaction: all rows and deferred trigger
    // events remain in ONE transaction until measure() commits. Both conditions use the
    // same command batches, including every real record_source crossing and ledger append.
    let inserted=0;
    for(let offset=0;offset<rows;offset+=1000){
     const count=Math.min(1000,rows-offset);
     const result=await c.admin.query("SELECT gov.record_source('message','synthetic-benchmark','Ordinary source',NULL,NULL,NULL) FROM generate_series(1,$1::integer)",[count]);
     assert.equal(result.rows.length,count);inserted+=result.rows.length;
    }
    assert.equal(inserted,rows);
   });
   samples.push(sample);
   t.diagnostic(JSON.stringify({benchmark:'material-enforcement-F7-sample',round,statementBatchRows:1000,statements:Math.ceil(rows/1000),sample}));
  }
 }finally{
  await c.admin.query('ALTER TABLE app.episodes ENABLE ALWAYS TRIGGER material_source_receipt');
  // Keep every completed sample even when a later size reaches a genuine resource limit.
  report(t,samples);
 }
 assert.equal((await verifyMaterialEnforcement(c.admin)).state,'verified');
});

function payload(bytes:number){
 const lines:string[]=[];let length=0;
 for(let i=0;length<bytes;i++){const line=`Synthetic record ${i}: ${digest(String(i))}\n`;lines.push(line);length+=line.length;}
 return lines.join('').slice(0,bytes);
}
test('F7: reserved typed material with varied 4 KiB, 64 KiB and 1 MiB content, validation cost and backend memory',{timeout:20*60_000},async t=>{
 const c=await context(t),samples:Sample[]=[];
 try{
  for(const payloadBytes of [4096,65536,1048576]){
   const text=payload(payloadBytes);assert.equal(Buffer.byteLength(text),payloadBytes);
   for(let round=0;round<3;round++)for(const enabled of round%2?[true,false]:[false,true]){
    const rows=10,plans=Array.from({length:rows},()=>{
     const material=randomUUID();return ['synthetic-benchmark-project',material,1,0,digest(material),digest(text),JSON.stringify({kind:'synthetic-benchmark',version:'1'}),'file',text,text,null,c.handle.run,null,null,null];
    });
    samples.push(await measure(c,'reserved',enabled,rows,payloadBytes,async()=>{for(const plan of plans)assert.equal((await c.admin.query(READ,plan)).rows.length,1);}));
   }
  }
 }finally{await c.admin.query('ALTER TABLE app.episodes ENABLE ALWAYS TRIGGER material_source_receipt');}
 assert.equal((await verifyMaterialEnforcement(c.admin)).state,'verified');report(t,samples);
});
