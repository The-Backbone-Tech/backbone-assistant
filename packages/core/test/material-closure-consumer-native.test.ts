// Real Native database plus the production Core typed consumer. No Host/model wiring is claimed.
import pg from 'pg';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {startTestPostgres,type TestPostgres} from '../src/db/testing.ts';
import {recallThroughBoundedTransport,TracedRecallRefusal,type BoundedTracedTransport} from '../src/db/material-closure-read.ts';
import {closureFixture,type ClosureFixture,type ClaimedRun} from './material-closure-fixture.ts';

let postgres:TestPostgres,c:ClosureFixture;
beforeAll(async()=>{postgres=await startTestPostgres();});afterAll(async()=>{await postgres?.stop();});
beforeEach(async()=>{c=await closureFixture(postgres);});afterEach(async()=>{await c?.close();});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
function handle(r:ClaimedRun){const fence=Number(r.fence);expect(Number.isSafeInteger(fence)).toBe(true);return {run:r.id,fence,secret:r.secret};}
const counts=async()=>(await c.admin.query(`SELECT
 (SELECT count(*)::integer FROM app.knowledge_reads WHERE workspace_id=$1) AS reads,
 (SELECT count(*)::integer FROM app.ledger WHERE workspace_id=$1 AND entry_type='knowledge.recalled') AS events`,[c.ws])).rows[0];
async function accepted(){const input=await c.personal('Private Native helper output stays inside the consumer until confirmed COMMIT.');await c.accept(input);return {input,r:await c.run()};}
async function safeRefusal(pending:Promise<unknown>,r:ClaimedRun,statement:string,reason='paused'){
 const error=await pending.then(()=>undefined,e=>e);expect(error).toBeInstanceOf(TracedRecallRefusal);expect(error.reason).toBe(reason);
 const visible=JSON.stringify({name:error.name,message:error.message,reason:error.reason,stack:error.stack,detail:error.detail,cause:error.cause});
 for(const secret of [r.secret,r.id,c.ws,statement])expect(visible.includes(secret)).toBe(false);
 expect(error.detail).toBeUndefined();expect(error.cause).toBeUndefined();return error;
}
interface Trace {credentialQueries:number;recalls:number;commitAttempts:number;cleaned:boolean}
/** This test transport owns a fresh bounded client and checks the actual role's log policy. */
function transport(options:{
 beforeConnect?:()=>Promise<void>;
 atCommit?:(client:pg.Client,query:(...args:any[])=>Promise<any>)=>Promise<any>;
 afterCleanup?:()=>Promise<void>;
}={}):{run:BoundedTracedTransport;trace:Trace}{
 const trace={credentialQueries:0,recalls:0,commitAttempts:0,cleaned:false};
 const run:BoundedTracedTransport=async(_signal,perform)=>{
  await options.beforeConnect?.();const client=await c.connect();
  try{
   const logs=(await client.query(`SELECT current_setting('log_parameter_max_length') AS parameters,
    current_setting('log_parameter_max_length_on_error') AS errors`)).rows[0];
   expect(logs).toEqual({parameters:'0',errors:'0'});
   await client.query("SET statement_timeout='5s'; SET lock_timeout='2s'");
   const query=client.query.bind(client) as (...args:any[])=>Promise<any>;
   client.query=(async(...args:any[])=>{
    const sql=typeof args[0]==='string'?args[0]:args[0].text;
    if(sql.includes("set_config('backbone.secret'"))trace.credentialQueries++;
    if(sql.includes('FROM gov.recall_knowledge_traced_v1('))trace.recalls++;
    if(sql==='COMMIT'){trace.commitAttempts++;if(options.atCommit)return options.atCommit(client,query);}
    return query(...args);
   }) as typeof client.query;
   return await perform(client);
  }finally{await client.end();trace.cleaned=true;await options.afterCleanup?.();}
 };
 return {run,trace};
}

describe('material closure: actual typed Core consumer handover',()=>{
 it('keeps actual returned words/IDs private while COMMIT is held, then releases only frozen confirmed rows',async()=>{
  const {input,r}=await accepted(),entered=deferred(),release=deferred();
  const t=transport({atCommit:async(_client,query)=>{entered.resolve();await release.promise;return query('COMMIT');}});
  let exposed:unknown;const pending=recallThroughBoundedTransport(t.run,c.ws,handle(r),[],100,new AbortController().signal).then(rows=>{exposed=rows;return rows;});
  void pending.catch(()=>entered.resolve());
  try{
   await entered.promise;expect(exposed).toBeUndefined();expect(await counts()).toEqual({reads:0,events:0});release.resolve();
   const rows=await pending;expect(rows).toHaveLength(1);expect(rows[0].statement).toBe(input.statement);expect(typeof rows[0].read_seq).toBe('string');
   expect(Object.isFrozen(rows)).toBe(true);expect(Object.isFrozen(rows[0])).toBe(true);expect(t.trace.cleaned).toBe(true);
   expect(await counts()).toEqual({reads:1,events:1});expect(t.trace).toMatchObject({recalls:1,commitAttempts:1,credentialQueries:1});
  }finally{release.resolve();await pending.catch(()=>{});}
 });
 it.each(['COMMIT','ROLLBACK'])('run credentials are transaction-local after actual %s, before the dedicated client is discarded',async outcome=>{
  const {input,r}=await accepted();let cleared:unknown;
  const t=transport({atCommit:async(_client,query)=>{
   const identity=`SELECT current_setting('backbone.workspace',true) AS workspace,
    current_setting('backbone.principal',true) AS principal,current_setting('backbone.run',true) AS run,
    current_setting('backbone.secret',true) AS secret`;
   expect((await query(identity)).rows[0]).toEqual({workspace:c.ws,principal:'',run:r.id,secret:r.secret});
   const finished=await query(outcome);
   // Inspection only: this transport still closes the client in finally, never pools it.
   cleared=(await query(identity)).rows[0];
   return finished;
  }});
  const pending=recallThroughBoundedTransport(t.run,c.ws,handle(r),[],100,new AbortController().signal);
  if(outcome==='COMMIT')expect(await pending).toHaveLength(1);
  else await safeRefusal(pending,r,input.statement);
  expect(cleared).toEqual({workspace:'',principal:'',run:'',secret:''});
  expect(t.trace.cleaned).toBe(true);
  expect(await counts()).toEqual(outcome==='COMMIT'?{reads:1,events:1}:{reads:0,events:0});
 });
 it('an actual ROLLBACK command tag exposes no row or receipt and leaves no Native read or event',async()=>{
  const {input,r}=await accepted(),before=await c.snapshot();const t=transport({atCommit:async(_client,query)=>query('ROLLBACK')});
  await safeRefusal(recallThroughBoundedTransport(t.run,c.ws,handle(r),[],100,new AbortController().signal),r,input.statement);
  expect(t.trace).toMatchObject({recalls:1,commitAttempts:1,cleaned:true});expect(await c.snapshot()).toEqual(before);
 });
 it('an actual COMMIT followed by a lost driver reply retains the one Native read, exposes no words and never replays',async()=>{
  const {input,r}=await accepted();const t=transport({atCommit:async(_client,query)=>{
   await query('COMMIT');throw Object.assign(new Error(input.statement),{detail:r.secret,cause:{run:r.id}});
  }});
  await safeRefusal(recallThroughBoundedTransport(t.run,c.ws,handle(r),[],100,new AbortController().signal),r,input.statement);
  expect(t.trace).toMatchObject({recalls:1,commitAttempts:1,cleaned:true});expect(await counts()).toEqual({reads:1,events:1});
 });
 it('killing the real owned reader backend at COMMIT aborts staged Native rows and exposes no result',async()=>{
  const {input,r}=await accepted(),before=await c.snapshot(),killer=await c.connect('admin');
  const t=transport({atCommit:async(_client,query)=>{
   const pid=(await query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   expect((await killer.query('SELECT pg_terminate_backend($1,1000) AS killed',[pid])).rows[0].killed).toBe(true);
   return query('COMMIT');
  }});
  await safeRefusal(recallThroughBoundedTransport(t.run,c.ws,handle(r),[],100,new AbortController().signal),r,input.statement);
  expect(t.trace).toMatchObject({recalls:1,commitAttempts:1,cleaned:true});expect(await c.snapshot()).toEqual(before);
 });
 it('Stop after actual confirmed COMMIT withholds handover while retaining truthful Native history',async()=>{
  const {input,r}=await accepted(),controller=new AbortController();
  const t=transport({atCommit:async(_client,query)=>{const committed=await query('COMMIT');controller.abort();return committed;}});
  await safeRefusal(recallThroughBoundedTransport(t.run,c.ws,handle(r),[],100,controller.signal),r,input.statement,'cancelled');
  expect(await counts()).toEqual({reads:1,events:1});expect(t.trace).toMatchObject({recalls:1,commitAttempts:1,cleaned:true});
 });
 it('Stop during asynchronous transport cleanup after real COMMIT still withholds handover',async()=>{
  const {input,r}=await accepted(),controller=new AbortController(),entered=deferred(),release=deferred();
  const t=transport({afterCleanup:async()=>{entered.resolve();await release.promise;}});
  let exposed:unknown;const pending=recallThroughBoundedTransport(t.run,c.ws,handle(r),[],100,controller.signal).then(rows=>{exposed=rows;return rows;});
  void pending.catch(()=>entered.resolve());
  try{
   await entered.promise;expect(exposed).toBeUndefined();expect(await counts()).toEqual({reads:1,events:1});
   controller.abort();release.resolve();await safeRefusal(pending,r,input.statement,'cancelled');expect(t.trace.cleaned).toBe(true);
  }finally{release.resolve();await pending.catch(()=>{});}
 });
 it('a real catalogue tamper refuses before any run credential or crossing query',async()=>{
  const {input,r}=await accepted(),before=await c.snapshot();await c.admin.query('ALTER FUNCTION gov._append(text,text,jsonb,uuid) OWNER TO postgres');
  const t=transport();await safeRefusal(recallThroughBoundedTransport(t.run,c.ws,handle(r),[],100,new AbortController().signal),r,input.statement);
  expect(t.trace).toEqual({credentialQueries:0,recalls:0,commitAttempts:0,cleaned:true});expect(await c.snapshot()).toEqual(before);
 });
 it('captures the actual handle and search synchronously before a delayed transport is opened',async()=>{
  const {input,r}=await accepted(),release=deferred(),h=handle(r),words=['Native'];
  const t=transport({beforeConnect:()=>release.promise});
  const pending=recallThroughBoundedTransport(t.run,c.ws,h,words,100,new AbortController().signal);
  h.run=c.p;h.secret='changed after capture';h.fence+=1;words[0]='absent-needle';release.resolve();
  const rows=await pending;expect(rows).toHaveLength(1);expect(rows[0].statement).toBe(input.statement);expect(await counts()).toEqual({reads:1,events:1});
 });
});
