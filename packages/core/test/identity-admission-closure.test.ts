import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {expect,it} from 'vitest';
import {waitFor} from '../../../scripts/lib/test-hang.ts';
import {startTestPostgres} from '../src/db/testing.ts';
import {serviceClient} from '../src/db/session.ts';

type Run={id:string;fence:string;secret:string};
async function hiddenFromGovernor(observer:pg.Client,ws:string,run:Run,id:string){
 await observer.query('BEGIN');try{await observer.query("SELECT set_config('backbone.workspace',$1,true),set_config('backbone.principal','',true),set_config('backbone.run',$2,true),set_config('backbone.secret',$3,true)",[ws,run.id,run.secret]);await observer.query('SET LOCAL ROLE backbone_gov');return(await observer.query('SELECT id FROM app.runs WHERE id=$1',[id])).rows;}finally{await observer.query('ROLLBACK');}
}
async function fixture(work:(f:{owner:string;ws:string;observer:pg.Client;as:(person:string|null,sql:string,values?:unknown[],run?:Run)=>Promise<pg.QueryResultRow[]>;claim:(task:string,agent:string,mandate:string,person?:string)=>Promise<Run>})=>Promise<void>){
 const postgres=await startTestPostgres(),database=`identity_closure_${randomUUID().replaceAll('-','')}`;await postgres.clone(database);
 const observer=new pg.Client({connectionString:postgres.adminUrl(database)}),operator=new pg.Client({connectionString:postgres.operatorUrl(database)}),service=await serviceClient(postgres.appUrl(database));
 try{await observer.connect();await operator.connect();const made=(await operator.query('SELECT * FROM operator.create_workspace($1,$2,$3,$4)',['Closure security','team','Owner','owner@example.invalid'])).rows[0];
 const as=async(person:string|null,sql:string,values:unknown[]=[],run?:Run)=>{await service.query('BEGIN');try{await service.query("SELECT set_config('backbone.workspace',$1,true),set_config('backbone.principal',$2,true),set_config('backbone.run',$3,true),set_config('backbone.secret',$4,true)",[made.workspace_id,person??'',run?.id??'',run?.secret??'']);const result=await service.query(sql,values);const restored=(await service.query("SELECT current_setting('backbone.principal')=$1 AND current_setting('backbone.run')=$2 AND current_setting('backbone.secret')=$3 AS ok",[person??'',run?.id??'',run?.secret??''])).rows[0].ok;expect(restored,'the operation restores its actor, run and secret context').toBe(true);await service.query('COMMIT');return result.rows;}catch(error){await service.query('ROLLBACK');throw error;}};
 const claim=async(task:string,agent:string,mandate:string,person=made.owner_id)=>{const id=(await as(person,'SELECT gov.queue_run($1,$2,$3,NULL,NULL) AS id',[task,agent,mandate]))[0].id;const row=(await as(null,"SELECT * FROM gov.claim_run($1,'closure-fixture',60000,'direct',NULL)",[id]))[0];return {id,fence:row.fence,secret:row.secret};};
 await work({owner:made.owner_id,ws:made.workspace_id,observer,as,claim});
 }finally{await service.end();await observer.end();await operator.end();await postgres.drop(database);await postgres.stop();}
}
const grant=`SELECT gov.issue_mandate($1,$2,'"*"','"*"','"*"','"*"',3::smallint,$3,$4,NULL,$5,clock_timestamp()+interval '1 hour','direct') AS id`;
const proposal=`SELECT gov.propose_effect($1,$2,NULL,'fixture',$3,NULL,NULL,NULL,NULL,$4::jsonb,'Closure control',NULL,$5) AS id`;

it('explicit workspace documents retain their scope without granting orphan-task or unnamed access',async()=>fixture(async({owner,ws,observer,as})=>{
 const member=(await as(owner,"SELECT gov.identity_add_person('Member',NULL,'member') AS id"))[0].id;
 const guest=(await as(owner,"SELECT gov.identity_add_person('Guest',NULL,'guest') AS id"))[0].id;
 const document=(await as(owner,"SELECT gov.create_document(NULL,'Workspace board','First version',NULL) AS id"))[0].id;
 expect((await as(member,'SELECT content FROM app.documents WHERE id=$1',[document]))[0].content).toBe('First version');
 expect((await as(guest,'SELECT content FROM app.documents WHERE id=$1',[document]))[0].content).toBe('First version');
 await as(member,"SELECT gov.revise_document($1,NULL,'Second version')",[document]);
 expect((await as(guest,'SELECT content FROM app.document_versions WHERE document_id=$1',[document]))[0].content).toBe('First version');
 expect(await as(null,'SELECT content FROM app.documents WHERE id=$1',[document])).toEqual([]);
 expect(await as(null,'SELECT content FROM app.document_versions WHERE document_id=$1',[document])).toEqual([]);
 await expect(as(guest,"SELECT gov.revise_document($1,NULL,'Guest write')",[document])).rejects.toMatchObject({code:'42501'});
 await expect(as(null,"SELECT gov.create_document(NULL,'Anonymous','No',NULL)")).rejects.toThrow();
 const task=(await as(owner,"SELECT gov.create_task($1,$1,'Project private',NULL,NULL) AS id",[owner]))[0].id;
 const privateDocument=(await as(owner,"SELECT gov.create_document($1,'Private','Private words',NULL) AS id",[task]))[0].id;
 expect(await as(member,'SELECT content FROM app.documents WHERE id=$1',[privateDocument])).toEqual([]);
 await observer.query('DELETE FROM app.identity_task_projects WHERE workspace_id=$1 AND task_id=$2',[ws,task]);
 expect(await as(owner,'SELECT content FROM app.documents WHERE id=$1',[privateDocument])).toEqual([]);
 expect((await as(owner,'SELECT gov.identity_task_access(NULL,false) AS ok'))[0].ok).toBe(false);
}),30_000);

it('explicit workspace sources remain available to native promotion without exposing private or orphan sources',async()=>fixture(async({owner,ws,as,observer,claim})=>{
 const system=(await as(owner,"SELECT id FROM app.principals WHERE kind='system'"))[0].id;
 const runtime=(await as(owner,'SELECT * FROM gov.identity_runtime(NULL)'))[0];
 const episode=(await as(system,"SELECT gov.record_source('web','fixture://workspace','Workspace evidence',NULL,NULL,NULL) AS id"))[0].id;
 expect((await as(runtime.agent,'SELECT content FROM app.episodes WHERE id=$1',[episode]))[0].content).toBe('Workspace evidence');
 const verifier=(await as(owner,"SELECT gov.create_agent('Verifier','verifier') AS id"))[0].id;
 expect((await as(verifier,'SELECT content FROM app.episodes WHERE id=$1',[episode]))[0].content).toBe('Workspace evidence');
 expect(await as(null,'SELECT content FROM app.episodes WHERE id=$1',[episode])).toEqual([]);
 const candidate=(await as(runtime.agent,'SELECT gov.propose_candidate($1,$2::jsonb,$3,NULL) AS id',['Workspace assertion',JSON.stringify([{episode,excerpt:'Workspace evidence'}]),runtime.agent]))[0].id;
 expect(candidate).toBeTruthy();
 const privateTask=(await as(owner,"SELECT gov.create_task($1,$1,'Private sources',NULL,NULL) AS id",[owner]))[0].id;
 const privateEpisode=(await as(system,"SELECT gov.record_source('web','fixture://private','Private evidence',NULL,NULL,$1) AS id",[privateTask]))[0].id;
 const member=(await as(owner,"SELECT gov.identity_add_person('Other reader',NULL,'member') AS id"))[0].id;
 expect(await as(member,'SELECT content FROM app.episodes WHERE id=$1',[privateEpisode])).toEqual([]);
 expect(await as(verifier,'SELECT content FROM app.episodes WHERE id=$1',[privateEpisode])).toEqual([]);
 const workspaceDocument=(await as(owner,"SELECT gov.create_document(NULL,'Workspace reference','Public words',NULL) AS id"))[0].id;
 const privateRun=await claim(privateTask,runtime.agent,runtime.mandate);
 const privateRead=(await as(system,'SELECT gov.read_document($1,$2) AS id',[privateRun.id,workspaceDocument]))[0].id;
 await expect(as(member,'SELECT gov.propose_candidate($1,$2::jsonb,$3,NULL)',['Do not reveal private work',JSON.stringify([{episode:privateRead,excerpt:'Public words'}]),member])).rejects.toThrow(/outside its receiving audience/);
 await observer.query('DELETE FROM app.identity_task_projects WHERE workspace_id=$1 AND task_id=$2',[ws,privateTask]);
 expect(await as(owner,'SELECT content FROM app.episodes WHERE id=$1',[privateEpisode])).toEqual([]);
}),30_000);

it('an independent checker settles exactly its assigned elevation without gaining general project payload access',async()=>fixture(async({owner,as,claim})=>{
 const admin=(await as(owner,"SELECT gov.identity_add_person('Independent admin',NULL,'admin') AS id"))[0].id;
 const member=(await as(owner,"SELECT gov.identity_add_person('Non-checker',NULL,'member') AS id"))[0].id;
 const runtime=(await as(owner,'SELECT * FROM gov.identity_runtime(NULL)'))[0],task=(await as(owner,"SELECT gov.create_task($1,$1,'Private elevation',NULL,NULL) AS id",[owner]))[0].id;
 const privateDocument=(await as(owner,"SELECT gov.create_document($1,'Private payload','Secret words',NULL) AS id",[task]))[0].id;
 const run=await claim(task,runtime.agent,runtime.mandate);
 const id=(await as(null,proposal,[run.id,run.fence,'access.grant',JSON.stringify({role:'admin',to:'fixture@example.invalid'}),randomUUID()],run))[0].id;
 const other=(await as(null,proposal,[run.id,run.fence,'outbox.write',JSON.stringify({name:'other.txt',content:'Other private effect'}),randomUUID()],run))[0].id;
 const decision=(await as(owner,'SELECT d.id,d.proposal_hash FROM app.decisions d JOIN app.effects e ON e.decision_id=d.id WHERE e.id=$1',[id]))[0];
 expect((await as(admin,'SELECT gov.may_decide($1) AS ok',[decision.id]))[0].ok).toBe(true);
 expect((await as(member,'SELECT gov.may_decide($1) AS ok',[decision.id]))[0].ok).toBe(false);
 expect(await as(admin,'SELECT content FROM app.documents WHERE id=$1',[privateDocument])).toEqual([]);
 expect(await as(admin,'SELECT id FROM app.effects WHERE id=$1',[other])).toEqual([]);
 await as(admin,"SELECT gov.answer_decision($1,$2,'approved',NULL)",[decision.id,decision.proposal_hash]);
 expect((await as(owner,'SELECT status FROM app.effects WHERE id=$1',[id]))[0].status).toBe('allowed');
 expect(await as(admin,'SELECT content FROM app.documents WHERE id=$1',[privateDocument])).toEqual([]);
 expect(await as(admin,'SELECT id FROM app.effects WHERE id=$1',[other])).toEqual([]);
 await as(owner,'SELECT gov.identity_remove($1)',[admin]);
 expect(await as(admin,'SELECT id FROM app.effects WHERE id=$1',[id])).toEqual([]);
}),30_000);

for(const dimension of ['tokens','cost'] as const)for(const delegated of [false,true])it(`${dimension} budget counts earlier ${delegated?'sibling mandates below the parent':'runs'} before permitting a fresh proposal`,async()=>fixture(async({owner,ws,observer,as,claim})=>{
 const runtime=(await as(owner,'SELECT * FROM gov.identity_runtime(NULL)'))[0],task=(await as(owner,'SELECT gov.create_task($1,$1,$2,NULL,NULL) AS id',[owner,'Budget task']))[0].id;
 const root=(await as(owner,grant,[runtime.agent,null,dimension==='tokens'?10:null,dimension==='cost'?10:null,null]))[0].id;
 const firstMandate=delegated?(await as(owner,grant,[runtime.agent,root,null,null,null]))[0].id:root;
 const first=await claim(task,runtime.agent,firstMandate);
 expect((await as(null,'SELECT gov.record_usage($1,$2,$3,0,$4) AS standing',[first.id,first.fence,dimension==='tokens'?9:0,dimension==='cost'?9:0],first))[0].standing).toBe('ok');
 await as(null,"SELECT gov.finish_run($1,$2,'succeeded')",[first.id,first.fence],first);
 const secondMandate=delegated?(await as(owner,grant,[runtime.agent,root,null,null,null]))[0].id:root;
 const second=await claim(task,runtime.agent,secondMandate);
 expect((await as(null,'SELECT gov.record_usage($1,$2,$3,0,$4) AS standing',[second.id,second.fence,dimension==='tokens'?2:0,dimension==='cost'?2:0],second))[0].standing).toBe('budget_exhausted');
 expect((await as(null,'SELECT gov.run_standing($1) AS standing',[second.id],second))[0].standing).toBe('budget_exhausted');
 const effect=(await as(null,proposal,[second.id,second.fence,'outbox.write',JSON.stringify({name:'budget.txt',content:'Must not dispatch'}),randomUUID()],second))[0].id;
 expect((await observer.query('SELECT status,route_reason FROM app.effects WHERE id=$1',[effect])).rows[0]).toMatchObject({status:'denied',route_reason:'budget_exhausted'});
 // Complete accounting does not restore prior-run payload reads to the holder.
 expect(await hiddenFromGovernor(observer,ws,second,first.id)).toEqual([]);
 await expect(as(null,'SELECT * FROM gov.identity_budget_totals($1)',[runtime.mandate],second)).rejects.toMatchObject({code:'42501'});
}),30_000);

it('legacy rebinding includes destination recipients and both taints require a checker',async()=>fixture(async({owner,ws,observer,as,claim})=>{
 const other=(await as(owner,"SELECT gov.identity_add_person('Recipient',NULL,'member') AS id"))[0].id,project=randomUUID();
 await as(owner,'SELECT gov.identity_project_create($1)',[project]);await as(owner,"SELECT gov.identity_project_share($1,$2,'viewer')",[project,other]);
 const task=(await as(owner,'SELECT gov.create_task($1,$1,$2,NULL,NULL) AS id',[owner,'Legacy private task']))[0].id;
 await as(owner,'SELECT gov.identity_bind_task($1,$2)',[project,task]);
 expect((await observer.query('SELECT person_id FROM app.task_people WHERE task_id=$1 AND person_id=$2',[task,other])).rows).toHaveLength(1);
 const runtime=(await as(owner,'SELECT * FROM gov.identity_runtime(NULL)'))[0],run=await claim(task,runtime.agent,runtime.mandate);
 // The disposable observer sets the native run marks; the proposal is a real crossing.
 await observer.query("UPDATE app.runs SET tainted_untrusted=true,tainted_sensitive=true,untrusted_source='Fixture outsider',sensitive_source='Fixture private source' WHERE id=$1",[run.id]);
 const effect=(await as(null,proposal,[run.id,run.fence,'workspace.write_document',JSON.stringify({task_id:task,title:'Shared output',content:'Both taints'}),randomUUID()],run))[0].id;
 expect((await observer.query('SELECT status,route_reason FROM app.effects WHERE id=$1',[effect])).rows[0]).toMatchObject({status:'awaiting_checker',route_reason:'rule_of_two'});
 await as(owner,'SELECT gov.identity_project_share($1,$2,NULL)',[project,other]);expect(await as(other,'SELECT id FROM app.tasks WHERE id=$1',[task])).toEqual([]);
}),30_000);

it('quoting earlier run marks cannot lose either taint behind the held-run payload policy',async()=>fixture(async({owner,ws,observer,as,claim})=>{
 const task=(await as(owner,'SELECT gov.create_task($1,$1,$2,NULL,NULL) AS id',[owner,'Quoted work']))[0].id,otherTask=(await as(owner,'SELECT gov.create_task($1,$1,$2,NULL,NULL) AS id',[owner,'Receiving work']))[0].id;
 const runtime=(await as(owner,'SELECT * FROM gov.identity_runtime(NULL)'))[0],first=await claim(task,runtime.agent,runtime.mandate);
 await observer.query("UPDATE app.runs SET tainted_untrusted=true,tainted_sensitive=true,untrusted_source='Fixture outsider',sensitive_source='Fixture private source',elsewhere_source='Fixture other task' WHERE id=$1",[first.id]);
 const second=await claim(otherTask,runtime.agent,runtime.mandate);
 await as(null,'SELECT gov.quote_marks($1,$2::jsonb)',[second.id,JSON.stringify({runs:[first.id]})],second);
 expect((await observer.query('SELECT tainted_untrusted,tainted_sensitive,elsewhere_source FROM app.runs WHERE id=$1',[second.id])).rows[0]).toMatchObject({tainted_untrusted:true,tainted_sensitive:true,elsewhere_source:expect.any(String)});
 expect(await hiddenFromGovernor(observer,ws,second,first.id)).toEqual([]);
 await expect(as(null,'SELECT * FROM gov.identity_budget_totals($1)',[runtime.mandate],second)).rejects.toMatchObject({code:'42501'});
}),30_000);

it('effect budgets include prior work whose project grant was removed',async()=>fixture(async({owner,observer,as,claim})=>{
 const member=(await as(owner,"SELECT gov.identity_add_person('Worker person',NULL,'member') AS id"))[0].id;
 const oldProject=randomUUID(),currentProject=randomUUID();await as(owner,'SELECT gov.identity_project_create($1)',[oldProject]);await as(owner,"SELECT gov.identity_project_share($1,$2,'editor')",[oldProject,member]);await as(member,'SELECT gov.identity_project_create($1)',[currentProject]);
 const oldTask=(await as(member,'SELECT gov.identity_create_task($1,$2) AS id',[oldProject,'Earlier work']))[0].id,currentTask=(await as(member,'SELECT gov.identity_create_task($1,$2) AS id',[currentProject,'Current work']))[0].id;
 const runtime=(await as(member,'SELECT * FROM gov.identity_runtime(NULL)'))[0],mandate=(await as(member,grant,[runtime.agent,null,null,null,1]))[0].id;
 const first=await claim(oldTask,runtime.agent,mandate,member),second=await claim(currentTask,runtime.agent,mandate,member);
 const effect=(await as(null,proposal,[first.id,first.fence,'outbox.write',JSON.stringify({name:'earlier.txt',content:'Earlier'}),randomUUID()],first))[0].id;
 expect((await observer.query('SELECT status FROM app.effects WHERE id=$1',[effect])).rows[0].status).toBe('allowed');
 await as(owner,'SELECT gov.identity_project_share($1,$2,NULL)',[oldProject,member]);
 const denied=(await as(null,proposal,[second.id,second.fence,'outbox.write',JSON.stringify({name:'later.txt',content:'Later'}),randomUUID()],second))[0].id;
 expect((await observer.query('SELECT status,route_reason FROM app.effects WHERE id=$1',[denied])).rows[0]).toMatchObject({status:'denied',route_reason:'budget_exhausted'});
 expect(await as(null,'SELECT id FROM app.effects WHERE id=$1',[effect],second)).toEqual([]);
}),30_000);

it('a hidden project UNKNOWN still prevents an administrator from unregistering its piece',async()=>fixture(async({owner,observer,as})=>{
 const member=(await as(owner,"SELECT gov.identity_add_person('Private worker',NULL,'member') AS id"))[0].id,project=randomUUID();await as(member,'SELECT gov.identity_project_create($1)',[project]);
 const manifest={manifest:1,id:'io.example/closure-fixture',kind:'surface',version:'1.0.0',licence:'MIT',capabilities:{planes:['team'],network:[],secrets:'none',operations:['outbox.write'],effectClasses:[3]},removal:{refusedWhileUnknown:true,rule:'settle UNKNOWNs first'},digest:'sha256:'+'a'.repeat(64)};
 const piece=(await as(owner,'SELECT gov.register_piece($1::jsonb) AS id',[JSON.stringify(manifest)]))[0].id,runtime=(await as(member,'SELECT * FROM gov.identity_runtime(NULL)'))[0];
 const mandate=(await as(member,grant.replace("'direct')","'piece','{}'::jsonb,$6)"),[runtime.agent,null,null,null,null,piece]))[0].id,task=(await as(member,'SELECT gov.identity_create_task($1,$2) AS id',[project,'Hidden piece work']))[0].id;
 const id=(await as(member,'SELECT gov.queue_run($1,$2,$3,NULL,$4) AS id',[task,runtime.agent,mandate,piece]))[0].id,row=(await as(null,"SELECT * FROM gov.claim_run($1,'closure-fixture',60000,'piece',$2)",[id,piece]))[0],run={id,fence:row.fence,secret:row.secret};
 const effect=(await as(null,proposal,[run.id,run.fence,'outbox.write',JSON.stringify({name:'private.txt',content:'Hidden words'}),randomUUID()],run))[0].id;
 const system=(await as(owner,'SELECT sec.system_principal() AS id'))[0].id,claim=(await as(system,'SELECT gov.claim_effect($1,60000) AS token',[effect]))[0].token;
 expect((await as(system,'SELECT gov.begin_dispatch($1,$2) AS begun',[effect,claim]))[0].begun).toBe(true);
 await as(system,"SELECT gov.observe_effect($1,$2,'unknown',NULL,'fixture-unknown',NULL)",[effect,claim]);
 expect(await as(owner,'SELECT id FROM app.effects WHERE id=$1',[effect])).toEqual([]);
 await expect(as(owner,'SELECT gov.unregister_piece($1)',[piece])).rejects.toThrow(/^unsettled:/);
 expect((await observer.query('SELECT unregistered_at FROM app.pieces WHERE id=$1',[piece])).rows[0].unregistered_at).toBe(null);
}),30_000);

it('a native signature giver held behind removal cannot create authority after the person is removed',async()=>fixture(async({owner,ws,observer,as})=>{
 const member=(await as(owner,"SELECT gov.identity_add_person('Leaving signer',NULL,'member') AS id"))[0].id;
 const connection=(await as(owner,"SELECT gov.register_connection('Fixture','fixture',NULL,'workspace','none') AS id"))[0].id,system=(await as(owner,'SELECT sec.system_principal() AS id'))[0].id;
 await as(system,"SELECT gov.record_connection_tools($1,'ok',$2::jsonb,NULL)",[connection,JSON.stringify([{name:'draft.note'},{name:'historical.note'}])]);
 const historical=(await as(member,'SELECT gov.give_connector_signature($1,$2,$3) AS id',[connection,'historical.note','a'.repeat(64)]))[0].id;
 const pid=(await as(member,'SELECT pg_backend_pid() AS id'))[0].id;
 await observer.query('BEGIN');let pending:Promise<unknown>|undefined;
 try{
  await observer.query("SELECT set_config('backbone.workspace',$1,true),set_config('backbone.principal',$2,true),set_config('backbone.run','',true),set_config('backbone.secret','',true)",[ws,owner]);await observer.query('SET LOCAL ROLE backbone_app');
  // Removal is complete inside its real transaction but not acknowledged yet.
  // The legacy consumer sees the prior committed person while waiting on it.
  await observer.query('SELECT gov.identity_remove($1)',[member]);
  pending=as(member,'SELECT gov.give_connector_signature($1,$2,$3)',[connection,'draft.note','a'.repeat(64)]).then(()=>({ok:true}),error=>({ok:false,code:error.code}));
  await waitFor(async()=>(await observer.query("SELECT wait_event_type='Lock' AS blocked FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.blocked===true,'native signature consumer reaches the workspace lock');
  await observer.query('COMMIT');
  expect(await pending).toMatchObject({ok:false});
  expect((await observer.query("SELECT count(*)::int AS n FROM app.connector_signatures WHERE person_id=$1 AND tool_name='draft.note'",[member])).rows[0].n).toBe(0);
  expect((await observer.query('SELECT ended_at FROM app.connector_signatures WHERE id=$1',[historical])).rows[0].ended_at).toBe(null);
  expect((await observer.query("SELECT count(*)::int AS n FROM app.ledger WHERE entry_type='signature.ended' AND subject=$1",[historical])).rows[0].n).toBe(0);
 }finally{await observer.query('ROLLBACK');await pending;}
}),30_000);

it('a revoked quoted project carries generic taints without restoring its private reason strings',async()=>fixture(async({owner,observer,as,claim})=>{
 const person=(await as(owner,"SELECT gov.identity_add_person('Quoted worker',NULL,'member') AS id"))[0].id,oldProject=randomUUID(),nextProject=randomUUID();
 await as(owner,'SELECT gov.identity_project_create($1)',[oldProject]);await as(owner,"SELECT gov.identity_project_share($1,$2,'editor')",[oldProject,person]);await as(person,'SELECT gov.identity_project_create($1)',[nextProject]);
 const oldTask=(await as(person,'SELECT gov.identity_create_task($1,$2) AS id',[oldProject,'Earlier']))[0].id,nextTask=(await as(person,'SELECT gov.identity_create_task($1,$2) AS id',[nextProject,'Later']))[0].id,runtime=(await as(person,'SELECT * FROM gov.identity_runtime(NULL)'))[0];
 const first=await claim(oldTask,runtime.agent,runtime.mandate,person);await observer.query("UPDATE app.runs SET tainted_untrusted=true,tainted_sensitive=true,untrusted_source='OLD_PRIVATE_REASON_CANARY',sensitive_source='OLD_PRIVATE_REASON_CANARY' WHERE id=$1",[first.id]);
 await as(owner,'SELECT gov.identity_project_share($1,$2,NULL)',[oldProject,person]);
 const second=await claim(nextTask,runtime.agent,runtime.mandate,person);await as(null,'SELECT gov.quote_marks($1,$2::jsonb)',[second.id,JSON.stringify({runs:[first.id]})],second);
 const marks=(await observer.query('SELECT tainted_untrusted,tainted_sensitive,untrusted_source,sensitive_source FROM app.runs WHERE id=$1',[second.id])).rows[0];expect(marks).toMatchObject({tainted_untrusted:true,tainted_sensitive:true});expect(JSON.stringify(marks)).not.toContain('OLD_PRIVATE_REASON_CANARY');
 expect(await as(null,'SELECT id FROM app.runs WHERE id=$1',[first.id],second)).toEqual([]);
}),30_000);

it('rebinding twice preserves an unrelated project that reused the old private task project id',async()=>fixture(async({owner,as})=>{
 const other=(await as(owner,"SELECT gov.identity_add_person('Other owner',NULL,'member') AS id"))[0].id,first=randomUUID(),next=randomUUID(),task=(await as(owner,'SELECT gov.create_task($1,$1,$2,NULL,NULL) AS id',[owner,'Move twice']))[0].id;
 await as(owner,'SELECT gov.identity_project_create($1)',[first]);await as(owner,'SELECT gov.identity_project_create($1)',[next]);await as(owner,'SELECT gov.identity_bind_task($1,$2)',[first,task]);
 await as(other,'SELECT gov.identity_project_create($1)',[task]);await as(owner,'SELECT gov.identity_bind_task($1,$2)',[next,task]);
 expect((await as(other,'SELECT gov.identity_project_access($1) AS access',[task]))[0].access).toBe('owner');
}),30_000);
