// Driver-protocol controls only; native authorization has its own real PostgreSQL suite.
// @ts-nocheck -- Fake driver rows deliberately violate the runtime protocol below.
import assert from 'node:assert/strict';
import {it,vi} from 'vitest';
vi.mock('../src/db/material-closure-status.ts',()=>({verifyMaterialClosure:async client=>({state:(await client.query('SELECT synthetic_profile_state')).rows[0].state,reason:'Synthetic profile only.'})}));
import {prepareTracedRecall,recallThroughBoundedTransport} from '../src/db/material-closure-read.ts';
const uuid=n=>'00000000-0000-0000-0000-'+String(n).padStart(12,'0');
const workspace=uuid(1),handle={run:uuid(2),fence:7,secret:'synthetic-private-run-secret'};
const privateWords='Synthetic native knowledge words remain private until commit.';
const row=()=>({read_id:uuid(3),knowledge_id:uuid(4),candidate_id:uuid(5),read_seq:'9007199254740993',statement:privateWords,topic:'synthetic'});
const deferred=()=>{let release;const promise=new Promise(r=>release=r);return {promise,release};};
function fake({rows=[row()],profile='verified',commit='COMMIT',block,afterRead,afterCommit,errorAt,error}={}){
 const queries=[];
 return {queries,async query(sql,params){
  const text=typeof sql==='string'?sql:sql.text;
  const stage=text.startsWith('BEGIN')?'begin':text==='SELECT synthetic_profile_state'?'profile':text.includes('set_config')?'identity':text.includes('recall_knowledge_traced_v1')?'read':text==='COMMIT'?'commit':'unexpected';
  queries.push({stage,text,params:params??sql.values});
  if(stage===errorAt)throw error;
  if(stage==='profile')return {command:'SELECT',rowCount:1,rows:[{state:profile}]};
  if(stage==='read'){afterRead?.();return {command:'SELECT',rowCount:rows.length,rows};}
  if(stage==='commit'){await block?.promise;afterCommit?.();return {command:commit,rowCount:null,rows:[]};}
  return {command:stage==='begin'?'BEGIN':'SELECT',rowCount:1,rows:[]};
 }};
}
const reject=async(run,reason='paused')=>assert.rejects(run,error=>{
 assert.equal(error.reason,reason);
 const serialized=JSON.stringify({message:error.message,reason:error.reason,stack:error.stack,cause:error.cause,detail:error.detail});
 assert.equal(serialized.includes(privateWords),false);assert.equal(serialized.includes(handle.secret),false);
 assert.equal(error.cause,undefined);assert.equal(error.detail,undefined);
 return true;
});
function test(name,run){it(name,run);}
await test('rows and native identities remain private until confirmed COMMIT',async()=>{
 const block=deferred(),client=fake({block}),controller=new AbortController();let exposed;
 const pending=prepareTracedRecall(workspace,handle,['native'],3,controller.signal)(client).then(rows=>{exposed=rows;return rows;});
 // Wait for the independently observable protocol point, never a timing sleep.
 while(client.queries.at(-1)?.stage!=='commit')await new Promise(resolve=>setImmediate(resolve));
 assert.equal(exposed,undefined);block.release();const rows=await pending;
 assert.equal(rows[0].statement,privateWords);assert.equal(rows[0].read_seq,'9007199254740993');
 assert.equal(Object.isFrozen(rows),true);assert.equal(Object.isFrozen(rows[0]),true);
});
await test('ROLLBACK command tag exposes no words or receipt',async()=>reject(()=>prepareTracedRecall(workspace,handle,[],2,new AbortController().signal)(fake({commit:'ROLLBACK'}))));
await test('lost COMMIT reply exposes no words or receipt and no retry',async()=>{
 const error=new Error(privateWords);error.detail=handle.secret;
 const client=fake({errorAt:'commit',error});
 await reject(()=>prepareTracedRecall(workspace,handle,[],2,new AbortController().signal)(client));
 assert.equal(client.queries.filter(q=>q.stage==='read').length,1);assert.equal(client.queries.filter(q=>q.stage==='commit').length,1);
});
await test('stop after SELECT refuses before COMMIT',async()=>{
 const controller=new AbortController(),client=fake({afterRead:()=>controller.abort()});
 await reject(()=>prepareTracedRecall(workspace,handle,[],2,controller.signal)(client),'cancelled');
 assert.equal(client.queries.some(q=>q.stage==='commit'),false);
});
await test('stop after confirmed COMMIT still withholds this handover',async()=>{
 const controller=new AbortController(),client=fake({afterCommit:()=>controller.abort()});
 await reject(()=>prepareTracedRecall(workspace,handle,[],2,controller.signal)(client),'cancelled');
});
await test('stop during transport cleanup after COMMIT still withholds handover',async()=>{
 const cleanup=deferred(),entered=deferred(),controller=new AbortController(),client=fake();
 const transport=async(signal,perform)=>{const rows=await perform(client);entered.release();await cleanup.promise;return rows;};
 const pending=recallThroughBoundedTransport(transport,workspace,handle,[],2,controller.signal);
 await entered.promise;controller.abort();cleanup.release();await reject(()=>pending,'cancelled');
});
await test('transport-level errors never expose retained row text or secrets',async()=>{
 const transport=async()=>{throw Object.assign(new Error(privateWords),{cause:row(),detail:handle.secret});};
 await reject(()=>recallThroughBoundedTransport(transport,workspace,handle,[],2,new AbortController().signal));
});
await test('capture run secret fence and words before first transport await',async()=>{
 const h={...handle},words=['original'],perform=prepareTracedRecall(workspace,h,words,2,new AbortController().signal);
 h.run=uuid(9);h.fence=99;h.secret='changed';words[0]='changed';
 const client=fake();await perform(client);
 assert.deepEqual(client.queries.find(q=>q.stage==='identity').params,[workspace,'',handle.run,handle.secret]);
 assert.deepEqual(client.queries.find(q=>q.stage==='read').params,[handle.run,7,['original'],2]);
 assert.equal(client.queries.some(q=>q.text.includes(handle.secret)),false);
});
await test('one transport closure cannot blindly replay an uncertain attempt',async()=>{
 const perform=prepareTracedRecall(workspace,handle,[],2,new AbortController().signal),client=fake({commit:'ROLLBACK'});
 await reject(()=>perform(client));const count=client.queries.length;
 await reject(()=>perform(client));assert.equal(client.queries.length,count);
});
for(const [name,mutate] of [
 ['int8 coerced to Number',r=>r.read_seq=9007199254740992],
 ['int8 above PostgreSQL range',r=>r.read_seq='9223372036854775808'],
 ['malformed native ID',r=>r.read_id='text-is-no-identity'],
 ['unexpected extra output column',r=>r.unreviewed_dependency='not-in-contract'],
 ['missing statement',r=>delete r.statement],
])await test(name+' refuses the complete batch',async()=>{
 const bad=row();mutate(bad);const client=fake({rows:[bad]});
 await reject(()=>prepareTracedRecall(workspace,handle,[],2,new AbortController().signal)(client));
 assert.equal(client.queries.some(q=>q.stage==='commit'),false);
});
await test('duplicate read identity and duplicate knowledge identity refuse',async()=>{
 for(const field of ['read_id','knowledge_id']){
  const other={...row(),read_id:uuid(6),knowledge_id:uuid(7)};other[field]=row()[field];
  await reject(()=>prepareTracedRecall(workspace,handle,[],2,new AbortController().signal)(fake({rows:[row(),other]})));
 }
});
await test('mismatched native batch cut refuses',async()=>reject(()=>prepareTracedRecall(workspace,handle,[],2,new AbortController().signal)(fake({rows:[row(),{...row(),read_id:uuid(6),knowledge_id:uuid(7),read_seq:'42'}]}))));
await test('driver errors discard dynamic message/detail/cause',async()=>{
 const error=new Error('denied: '+privateWords);error.detail=handle.secret;error.cause=row();
 await reject(()=>prepareTracedRecall(workspace,handle,[],2,new AbortController().signal)(fake({errorAt:'read',error})),'denied');
});
await test('pre-stopped call and invalid inputs issue no query',async()=>{
 const controller=new AbortController();controller.abort();
 assert.throws(()=>prepareTracedRecall(workspace,handle,[],2,controller.signal),e=>e.reason==='cancelled');
 for(const h of [{...handle,fence:0},{...handle,fence:9007199254740992},{...handle,secret:''}])
  assert.throws(()=>prepareTracedRecall(workspace,h,[],2,new AbortController().signal),e=>e.reason==='invalid');
 assert.throws(()=>prepareTracedRecall(workspace,handle,['\0'],2,new AbortController().signal),e=>e.reason==='invalid');
 assert.throws(()=>prepareTracedRecall(workspace,handle,[],101,new AbortController().signal),e=>e.reason==='invalid');
});
await test('new ABI search budgets match PostgreSQL character counts',async()=>{
 const s=new AbortController().signal;
 await prepareTracedRecall(workspace,handle,['😀'.repeat(256)],1,s)(fake());
 await prepareTracedRecall(workspace,handle,Array(64).fill('x'.repeat(128)),1,s)(fake());
 for(const words of [Array(65).fill('x'),['😀'.repeat(257)],Array(33).fill('x'.repeat(256))])
  assert.throws(()=>prepareTracedRecall(workspace,handle,words,1,s),e=>e.reason==='invalid');
});

it('refuses oversized returned topic bytes before COMMIT or handover',async()=>{
 const client=fake({rows:[{...row(),topic:'x'.repeat(2097153)}]});
 await reject(()=>prepareTracedRecall(workspace,handle,[],1,new AbortController().signal)(client));
 assert.equal(client.queries.some(q=>q.stage==='commit'),false);
});

it('qualifies the actual profile inside the transaction before sending local run credentials',async()=>{
 const client=fake();
 await recallThroughBoundedTransport(async(_signal,perform)=>perform(client),workspace,handle,[],2,new AbortController().signal);
 assert.deepEqual(client.queries.map(q=>q.stage),['begin','profile','identity','read','commit']);
 const identity=client.queries.find(q=>q.stage==='identity');
 assert.equal((identity.text.match(/,true\)/g)??[]).length,4);
 assert.equal(identity.text.includes(',false)'),false);
});
it('a paused profile is inspected after BEGIN and refuses before credentials, recall or COMMIT',async()=>{
 const client=fake({profile:'paused'});
 await reject(()=>recallThroughBoundedTransport(async(_signal,perform)=>perform(client),workspace,handle,[],2,new AbortController().signal));
 assert.deepEqual(client.queries.map(q=>q.stage),['begin','profile']);
});
