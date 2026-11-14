// Native-only fixtures: every identity is created through a Core crossing in a disposable DB.
import {createHash,randomUUID} from 'node:crypto';
import pg from 'pg';
import {enter,type Actor} from '../src/db/session.ts';
import type {TestPostgres} from '../src/db/testing.ts';

export interface ClaimedRun {id:string;secret:string;fence:string;agent:string;task:string;mandate:string;person:string}
export interface PersonalClaim {candidate:string;episode:string;message:string;task:string;statement:string}
export const TRACED_RECALL='SELECT * FROM gov.recall_knowledge_traced_v1($1::uuid,$2::bigint,$3::text[],$4::integer)';

export async function closureFixture(postgres:TestPostgres,beforeWorkspace?:(admin:pg.Client,database:string)=>Promise<void>){
 const database=`closure_${randomUUID().replaceAll('-','')}`;
 await postgres.clone(database);
 const clients=new Set<pg.Client>();
 const connect=async(kind:'admin'|'app'|'operator'='app')=>{
  const url=kind==='admin'?postgres.adminUrl(database):kind==='operator'?postgres.operatorUrl(database):postgres.appUrl(database);
  const c=new pg.Client({connectionString:url,connectionTimeoutMillis:2000,query_timeout:10000});
  c.on('error',()=>{});await c.connect();clients.add(c);return c;
 };
 const close=async()=>{for(const c of clients){await c.query('ROLLBACK').catch(()=>{});await c.end().catch(()=>{});}clients.clear();await postgres.drop(database);};
 try{
  const admin=await connect('admin'),service=await connect(),operator=await connect('operator');
  await beforeWorkspace?.(admin,database);
  const made=(await operator.query('SELECT * FROM operator.create_workspace($1,$2,$3,$4)',['Closure fixture','team','Owner','owner@closure.invalid'])).rows[0];
  const ws=made.workspace_id as string,owner=made.owner_id as string,system=made.system_id as string;
  const actor=(principal:string):Actor=>({workspace:ws,principal});
  const as=async<T extends pg.QueryResultRow=pg.QueryResultRow>(who:Actor,sql:string,args:unknown[]=[],client=service):Promise<T[]>=>{
   await enter(client,who);
   try{
    const result=await client.query<T>(sql,args);
    const commit=await client.query('COMMIT');
    if(commit.command!=='COMMIT')throw new Error('Fixture did not receive COMMIT');
    return result.rows;
   }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
  };
  const one=async<T>(who:Actor,sql:string,args:unknown[]=[],client=service):Promise<T>=>(await as(who,`SELECT (${sql}) AS value`,args,client))[0]?.value as T;
  // Released foundation qualifications have no identity crossing. Current Core
  // must use its serialized replacement because the legacy service ACL is closed.
  const identity=(await service.query("SELECT to_regprocedure('gov.identity_add_person(text,text,text)') IS NOT NULL AS installed")).rows[0].installed;
  const addPerson=identity?'gov.identity_add_person':'gov.add_person';
  const p=await one<string>(actor(owner),`${addPerson}('Proposer','p@closure.invalid','member')`);
  const q=await one<string>(actor(owner),`${addPerson}('Author','q@closure.invalid','member')`);
  const task=async(person:string,visibility:'private'|'workspace'='workspace')=>one<string>(actor(person),'gov.create_task($1,$1,$2,NULL,$3)',[person,'Native closure task',visibility]);
  const source=async(statement:string,author=q,visibility:'private'|'workspace'='workspace',run:string|null=null):Promise<Omit<PersonalClaim,'candidate'>>=>{
   const sourceTask=await task(author,visibility);
   const message=await one<string>(actor(author),'gov.post_message($1,$2,$3)',[sourceTask,author,statement]);
   const episode=await one<string>(actor(system),"gov.record_source('message',$1,$2,$3,$4,$5)",[`message:${message}`,statement,author,run,sourceTask]);
   return {episode,message,task:sourceTask,statement};
  };
  const materialRead=async(runId:string|null=null)=>{
   const material=`native:${randomUUID()}`,project='native-closure-project',statement='Synthetic typed material remains withheld for knowledge use.';
   const readKey=createHash('sha256').update(material).digest('hex'),original=createHash('sha256').update(statement).digest('hex');
   const sourceTask=await task(q);
   const [receipt]=await as<{episode_id:string;receipt_id:string}>(actor(system),`SELECT * FROM gov.record_material_source_read(
    $1,$2,1,0,$3,$4,'{"kind":"native-control","version":"1"}'::jsonb,'file',$5,$5,$6,$7,$8,NULL,NULL)`,
    [project,material,readKey,original,statement,q,runId,sourceTask]);
   const withdraw=()=>one<string>(actor(system),'gov.withdraw_material_source($1,$2,$3,1,1,$4)',
    [project,material,createHash('sha256').update(`withdraw:${material}`).digest('hex'),'2026-11-10T11:00:00.000Z']);
   return {material,project,statement,episode:receipt.episode_id,receipt:receipt.receipt_id,task:sourceTask,withdraw};
  };
  const propose=async(input:Omit<PersonalClaim,'candidate'>,who:Actor=actor(p),topic:string|null='closure'):Promise<string>=>{
   const principal=who.run?(await admin.query('SELECT agent_id FROM app.runs WHERE workspace_id=$1 AND id=$2',[ws,who.run.id])).rows[0].agent_id:who.principal;
   return one<string>(who,'gov.propose_candidate($1,$2::jsonb,$3,$4)',[input.statement,JSON.stringify([{episode:input.episode,excerpt:input.statement}]),principal,topic]);
  };
  const accept=async(input:PersonalClaim,proposer=p)=>{
   const decision=await one<string>(actor(proposer),'gov.request_promotion($1,$2,NULL,NULL)',[input.candidate,owner]);
   const hash=(await as<{proposal_hash:string}>(actor(owner),'SELECT proposal_hash FROM app.decisions WHERE id=$1',[decision]))[0].proposal_hash;
   await one(actor(owner),"gov.answer_decision($1,$2,'approved','Native checked evidence')",[decision,hash]);
   return (await admin.query('SELECT id FROM app.knowledge WHERE workspace_id=$1 AND candidate_id=$2',[ws,input.candidate])).rows[0].id as string;
  };
  const personal=async(statement='Native people remember the blue observatory.',topic:string|null='closure')=>{
   const input=await source(statement),candidate=await propose(input,actor(p),topic);return {...input,candidate};
  };
  const run=async(person=owner):Promise<ClaimedRun>=>{
   const agent=await one<string>(actor(person),"gov.create_agent('Receiver','worker')");
   const mandate=await one<string>(actor(person),`gov.issue_mandate($1,NULL,'"*"'::jsonb,'"*"'::jsonb,'"*"'::jsonb,'"*"'::jsonb,3::smallint,NULL,NULL,NULL,NULL,$2,'direct')`,[agent,new Date(Date.now()+3600000)]);
   const receivingTask=await task(person);
   const id=await one<string>(actor(person),'gov.queue_run($1,$2,$3)',[receivingTask,agent,mandate]);
   const [claim]=await as<{secret:string;fence:string}>({workspace:ws},"SELECT secret,fence FROM gov.claim_run($1,'closure-worker',300000,'direct')",[id]);
   return {id,secret:claim.secret,fence:String(claim.fence),agent,task:receivingTask,mandate,person};
  };
  const runActor=(r:ClaimedRun):Actor=>({workspace:ws,run:{id:r.id,secret:r.secret}});
  const recall=async(r:ClaimedRun,words:string[]=[],limit=100,client=service)=>as(runActor(r),TRACED_RECALL,[r.id,r.fence,words,limit],client);
  const snapshot=async()=>{
   const rows:Record<string,unknown>={};
   for(const table of ['knowledge_candidates','knowledge_candidate_inputs','knowledge_reads','ledger','ledger_heads','runs']){
    const present=(await admin.query('SELECT to_regclass($1) IS NOT NULL AS present',[`app.${table}`])).rows[0].present;
    rows[table]=present?(await admin.query(`SELECT to_jsonb(x) AS row FROM app.${table} x WHERE workspace_id=$1 ORDER BY to_jsonb(x)::text`,[ws])).rows:null;
   }
   return rows;
  };
  return {database,connect,close,admin,service,operator,ws,owner,system,p,q,actor,as,one,task,source,materialRead,propose,accept,personal,run,runActor,recall,snapshot};
 }catch(error){await close();throw error;}
}
export type ClosureFixture=Awaited<ReturnType<typeof closureFixture>>;

/** Observe a real heavyweight/row lock wait and its actual blocking backend, not a timer guess. */
export async function waitForNativeBlockPids(observer:pg.Client,blockedPid:number,holderPid:number){
 const until=Date.now()+3000;
 while(Date.now()<until){
  const result=await observer.query<{waiting:boolean}>(`SELECT EXISTS(SELECT FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid))) AS waiting`,[blockedPid,holderPid]);
  if(result.rows[0]?.waiting)return;
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 throw new Error('Expected native lock wait was not observed');
}
