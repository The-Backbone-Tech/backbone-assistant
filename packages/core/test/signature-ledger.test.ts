import { waitFor } from '../../../scripts/lib/test-hang.ts';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {enter,type Actor} from '../src/db/session.ts';
import {startTestPostgres,type TestPostgres} from '../src/db/testing.ts';
import {verifyMaterialGuard} from '../src/db/material-guard.ts';
import {verifySignatureLedger} from '../src/db/signature-ledger.ts';
let postgres:TestPostgres,service:pg.Client,admin:pg.Client;
let ws:string,owner:string,system:string,agent:string,other:string,connection:string,second:string,task:string;
let serial=0;
const person=():Actor=>({workspace:ws,principal:owner});
async function as<T=unknown>(actor:Actor,sql:string,args:unknown[]=[]):Promise<T>{
 await enter(service,actor);
 try{const r=await service.query(sql,args);await service.query('COMMIT');return Object.values(r.rows[0]??{})[0] as T;}
 catch(error){await service.query('ROLLBACK');throw error;}
}
async function workspace(){const c=new pg.Client({connectionString:postgres.operatorUrl('signature_ledger')});await c.connect();
 try{return(await c.query("SELECT * FROM operator.create_workspace('Signatures','personal','Owner','synthetic@example.test')")).rows[0];}finally{await c.end();}}
async function run(){
 const mandate=await as<string>(person(),`SELECT gov.issue_mandate($1,NULL,'"*"','"*"','"*"','"*"',4::smallint,NULL,NULL,NULL,NULL,$2,'direct')`,[agent,new Date(Date.now()+3600000)]);
 const id=await as<string>(person(),'SELECT gov.queue_run($1,$2,$3,NULL,NULL)',[task,agent,mandate]);
 await enter(service,{workspace:ws});
 try{const claim=(await service.query("SELECT * FROM gov.claim_run($1,'test',600000,'direct',NULL)",[id])).rows[0];await service.query('COMMIT');return {id,secret:claim.secret as string,fence:Number(claim.fence)};}
 catch(e){await service.query('ROLLBACK');throw e;}
}
async function proposal(operation='mcp.notes.draft.note'){
 const r=await run();const id=await as<string>({workspace:ws,run:r},`SELECT gov.propose_effect($1,$2,NULL,'carrier_label',$3,NULL,NULL,5::smallint,true,$4::jsonb,'Synthetic',NULL,$5)`,
 [r.id,r.fence,operation,JSON.stringify({serial:++serial}),`signature-${serial}`]);
 const d=(await admin.query('SELECT d.id,d.proposal_hash,e.id AS effect FROM app.effects e JOIN app.decisions d ON d.id=e.decision_id AND d.workspace_id=e.workspace_id WHERE e.id=$1',[id])).rows[0];
 expect(d,'proposal opens a real checker decision').toBeDefined();return d as {id:string;proposal_hash:string;effect:string};
}
const give=(conn=connection,tool='draft.note',actor=person())=>as<string>(actor,'SELECT gov.give_connector_signature($1,$2,$3)',[conn,tool,'a'.repeat(64)]);
const basis=(signature:string)=>({method:'standing_signature',signature});
const answer=(d:{id:string;proposal_hash:string},b:unknown,actor=person())=>as<string>(actor,"SELECT gov.answer_decision_with_basis($1,$2,'approved',NULL,$3::jsonb)",[d.id,d.proposal_hash,JSON.stringify(b)]);
async function unchanged(action:()=>Promise<unknown>,reason:string,d?:{id:string}){
 const before=(await admin.query('SELECT seq,hash FROM app.ledger WHERE workspace_id=$1 ORDER BY seq',[ws])).rows;
 await expect(action()).rejects.toThrow(new RegExp(`^${reason}:`));
 expect((await admin.query('SELECT seq,hash FROM app.ledger WHERE workspace_id=$1 ORDER BY seq',[ws])).rows).toEqual(before);
 if(d)expect((await admin.query('SELECT status FROM app.decisions WHERE id=$1',[d.id])).rows[0].status).toBe('open');
}
beforeAll(async()=>{
 postgres=await startTestPostgres();await postgres.clone('signature_ledger');const made=await workspace();ws=made.workspace_id;owner=made.owner_id;system=made.system_id;
 service=new pg.Client({connectionString:postgres.appUrl('signature_ledger')});await service.connect();admin=new pg.Client({connectionString:postgres.adminUrl('signature_ledger')});await admin.connect();
 agent=await as<string>(person(),"SELECT gov.create_agent('Worker','worker')");other=await as<string>(person(),"SELECT gov.identity_add_person('Other','other@example.test','member')");
 task=await as<string>(person(),"SELECT gov.create_task($1,$1,'Synthetic',NULL,NULL)",[owner]);
 for(const slug of ['notes','second']){
 const id=await as<string>(person(),"SELECT gov.register_connection($1,$1,NULL,'workspace','none')",[slug]);
 await as({workspace:ws,principal:system},"SELECT gov.record_connection_tools($1,'ok',$2::jsonb,NULL)",[id,JSON.stringify([{name:'draft.note'},{name:'unsigned'}])]);if(slug==='notes')connection=id;else second=id;
 }
});
afterAll(async()=>{await service?.end();await admin?.end();await postgres?.stop();});
describe('signature identity and terminal life',()=>{
 it('appends structured identifiers and generated ids; end is terminal and retry is idempotent',async()=>{
 const id=await give();expect(id).toMatch(/^[a-f0-9-]{36}$/);
 expect((await admin.query("SELECT payload FROM app.ledger WHERE subject=$1 AND entry_type='signature.given'",[id])).rows[0].payload).toEqual({signature:id,connection,tool_hash:expect.any(String),definition_digest:expect.any(String)});
 const given=(await admin.query("SELECT seq,payload FROM app.ledger WHERE subject=$1 AND entry_type='signature.given'",[id])).rows[0];
 expect(given.payload.definition_digest).not.toBe('a'.repeat(64));
 expect(await as(person(),'SELECT gov.ledger_words_match($1,$2,$3)',[given.seq,'definition_digest','a'.repeat(64)])).toBe(true);
 await as(person(),"SELECT gov.end_connector_signature($1,'person_revoked')",[id]);await as(person(),"SELECT gov.end_connector_signature($1,'superseded')",[id]);
 expect((await admin.query("SELECT payload FROM app.ledger WHERE subject=$1 AND entry_type='signature.ended'",[id])).rows).toEqual([{payload:{signature:id,reason:'person_revoked'}}]);
 const d=await proposal();await unchanged(()=>answer(d,basis(id)),'revoked',d);expect(await give()).not.toBe(id);
 await expect(as(person(),'UPDATE app.connector_signatures SET ended_at=NULL,end_reason=NULL WHERE id=$1',[id])).rejects.toThrow(/permission denied/);
 });
 for(const kind of ['agent','system','empty','invalid run','real run'] as const)it(`refuses ${kind} giving, ending and answering`,async()=>{
 const id=await give(),d=await proposal();let actor:Actor,reason:string;
 if(kind==='agent'||kind==='system'){actor={workspace:ws,principal:kind==='agent'?agent:system};reason='role';}
 else if(kind==='empty'){actor={workspace:ws};reason='no_identity';}
 else {actor={workspace:ws,principal:owner,run:kind==='real run'?await run():{id:randomUUID(),secret:'fake'}};reason='not_by_runs';}
 await unchanged(()=>give(connection,'draft.note',actor),reason);await unchanged(()=>as(actor,"SELECT gov.end_connector_signature($1,'person_revoked')",[id]),reason);
 await unchanged(()=>answer(d,basis(id),actor),reason,d);
 });
 it('refuses another person ending, private connection mismatch, unknown tool and invalid inputs',async()=>{
 const id=await give();await unchanged(()=>as({workspace:ws,principal:other},"SELECT gov.end_connector_signature($1,'person_revoked')",[id]),'someone_else');
 const privateId=await as<string>(person(),"SELECT gov.register_connection('private','private',NULL,'person','none')");await unchanged(()=>give(privateId,'draft.note',{workspace:ws,principal:other}),'someone_else');
 await unchanged(()=>give(connection,'absent'),'not_found');await unchanged(()=>give(randomUUID()),'not_found');
 await unchanged(()=>as(person(),"SELECT gov.give_connector_signature($1,'draft.note','words')",[connection]),'invalid');await unchanged(()=>as(person(),"SELECT gov.end_connector_signature($1,'arbitrary words')",[id]),'invalid');
 });
});
describe('checked basis and decision binding',()=>{
 it('records standing, explicit person and default person, preserving existing note hashing',async()=>{
 const id=await give(),d=await proposal();expect(await answer(d,basis(id))).toBe('approved');
 expect((await admin.query("SELECT payload->'basis' AS basis FROM app.ledger WHERE subject=$1 AND entry_type='decision.answered'",[d.id])).rows).toEqual([{basis:basis(id)}]);
 for(const explicit of [true,false]){const q=await proposal();if(explicit)await answer(q,{method:'person'});else await as(person(),"SELECT gov.answer_decision_with_basis($1,$2,'approved','synthetic note')",[q.id,q.proposal_hash]);expect(await as(person(),'SELECT gov.decision_answer_basis($1)',[q.id])).toEqual({method:'person'});}
 });
 for(const kind of ['random','other person','ended','other tool','other connection','other workspace'] as const)it(`refuses ${kind} signature without settlement`,async()=>{
 const d=await proposal();let id:string,reason:string;
 if(kind==='random'){id=randomUUID();reason='not_found';}
 else if(kind==='other person'){id=await give(connection,'draft.note',{workspace:ws,principal:other});reason='someone_else';}
 else if(kind==='ended'){id=await give();await as(person(),"SELECT gov.end_connector_signature($1,'definition_changed')",[id]);reason='revoked';}
 else if(kind==='other tool'){id=await give(connection,'unsigned');reason='denied';}
 else if(kind==='other connection'){id=await give(second);reason='denied';}
 else {const w=await workspace(),a={workspace:w.workspace_id,principal:w.owner_id};const c=await as<string>(a,"SELECT gov.register_connection('Foreign','foreign',NULL,'workspace','none')");
 await as({workspace:w.workspace_id,principal:w.system_id},"SELECT gov.record_connection_tools($1,'ok','[{\"name\":\"draft.note\"}]',NULL)",[c]);id=await give(c,'draft.note',a);reason='not_found';}
 await unchanged(()=>answer(d,basis(id)),reason,d);
 });
 it('rejects nonconnector effects and noneffect subjects',async()=>{
 const id=await give(),d=await proposal('outside.synthetic');await unchanged(()=>answer(d,basis(id)),'invalid',d);
 // A polymorphic subject UUID must not stand in for subject_kind. Close the real effect's
 // first question, then seed an elevation naming that SAME connector effect as hostile input.
 const connector=await proposal();await answer(connector,basis(id));
 const q={id:randomUUID(),proposal_hash:'hash'};await admin.query("INSERT INTO app.decisions(workspace_id,id,subject_kind,subject_id,proposer_id,checker_kind,reason,proposal_hash) VALUES($1,$2,'elevation',$3,$4,'person','synthetic','hash')",[ws,q.id,connector.effect,agent]);await unchanged(()=>answer(q,basis(id)),'invalid',q);
 });
 it('keeps exact proposal, verdict, checker and basis schema guards',async()=>{
 const d=await proposal(),signature=await give();await unchanged(()=>answer({...d,proposal_hash:'different'},basis(signature)),'different_proposal',d);
 for(const b of [null,{},[],{method:'bad'},{method:'person',signature},{method:'standing_signature'},{method:'standing_signature',signature:'bad'},{...basis(signature),extra:'words'}])await unchanged(()=>answer(d,b),'invalid',d);
 await unchanged(()=>as(person(),"SELECT gov.answer_decision_with_basis($1,$2,'unknown',NULL,$3)",[d.id,d.proposal_hash,JSON.stringify(basis(signature))]),'invalid',d);
 await unchanged(()=>as(person(),"SELECT gov.answer_decision_with_basis($1,$2,'rejected',NULL,$3)",[d.id,d.proposal_hash,JSON.stringify(basis(signature))]),'invalid',d);
 await unchanged(()=>answer(d,{method:'person'},{workspace:ws,principal:other}),'someone_else',d);
 });
 it('serializes competing valid answers; the first basis wins in an immutable chain',async()=>{
 const d=await proposal(),id=await give(),c=new pg.Client({connectionString:postgres.appUrl('signature_ledger')});await c.connect();
 try{
 await enter(service,person());await service.query("SELECT gov.answer_decision_with_basis($1,$2,'approved',NULL,$3)",[d.id,d.proposal_hash,JSON.stringify(basis(id))]);await enter(c,person());const pid=(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
 const pending=c.query("SELECT gov.answer_decision_with_basis($1,$2,'approved',NULL,'{\"method\":\"person\"}')",[d.id,d.proposal_hash]).then(()=>null,e=>e);
 let blocked=false;await waitFor(async()=>{blocked=(await admin.query("SELECT wait_event_type='Lock' AS blocked FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.blocked;if(!blocked)await new Promise(r=>setTimeout(r,10));
return blocked;},'signature-ledger: SQL lock observation',{diagnostic:()=>`blocked=${blocked}`});
 expect(blocked).toBe(true);await service.query('COMMIT');expect((await pending)?.message).toMatch(/^not_open:/);await c.query('ROLLBACK');expect(await as(person(),'SELECT gov.decision_answer_basis($1)',[d.id])).toEqual(basis(id));expect(await as(person(),'SELECT gov.verify_ledger()')).toBeNull();
 await expect(admin.query("UPDATE app.ledger SET payload='{}' WHERE subject=$1",[d.id])).rejects.toThrow(/append|frozen/i);
 }finally{await service.query('ROLLBACK');await c.query('ROLLBACK');await c.end();}
 }, 240_000);
 it('attests the new profile and refuses an edited released answer body',async()=>{
 expect((await verifySignatureLedger(admin)).state).toBe('verified');await admin.query('BEGIN');try{
 const original=(await admin.query("SELECT pg_get_functiondef('gov.answer_decision(uuid,text,text,text)'::regprocedure) AS sql")).rows[0].sql;
 await admin.query(original.replace('RETURN p_verdict;','RETURN NULL;'));expect((await verifyMaterialGuard(admin)).state).toBe('paused');expect((await verifySignatureLedger(admin)).state).toBe('paused');
 }finally{await admin.query('ROLLBACK');}
 });
});


it('reads legacy ABI answers by the ledger actor: person, verifier, worker, system and missing actor',async()=>{
 const verifier=await as<string>(person(),"SELECT gov.create_agent('Verifier','verifier')");
 for(const [actor,expected] of [[owner,'person'],[verifier,'verifier'],[agent,'not_stated'],[system,'not_stated'],[null,'not_stated']] as const){
  const id=randomUUID();
  await admin.query("INSERT INTO app.decisions(workspace_id,id,subject_kind,subject_id,proposer_id,checker_kind,checker_id,reason,proposal_hash) VALUES($1,$2,'elevation',$3,$4,$5,$6,'synthetic','hash')",
   [ws,id,randomUUID(),agent,actor===verifier?'verifier':'person',actor===owner?owner:null]);
  if(actor===owner)await as(person(),"SELECT gov.answer_decision($1,'hash','rejected','old ABI')",[id]);
  else if(actor===verifier)await as({workspace:ws,principal:verifier},"SELECT gov.verifier_answer($1,'rejected','synthetic proof')",[id]);
  else {
   // These fixtures authorize no checker crossing for these actors. Seed only their metadata to grade
   // the reader conservatively, using the real append path and retaining the hash chain.
   await admin.query('BEGIN');try{
    await admin.query("SELECT set_config('backbone.workspace',$1,true),set_config('backbone.principal','',true),set_config('backbone.run','',true)",[ws]);
    await admin.query("SELECT gov._append('decision.answered',$1,jsonb_build_object('verdict','rejected'),$2)",[id,actor]);
    await admin.query('COMMIT');
   }catch(e){await admin.query('ROLLBACK');throw e;}
  }
  expect(await as(person(),'SELECT gov.decision_answer_basis($1)',[id])).toEqual({method:expected});
 }
 expect(await as(person(),'SELECT gov.verify_ledger()')).toBeNull();
});


it('lost give replies and retries supersede earlier grants atomically, leaving exactly one live signature',async()=>{
 const ids:string[]=[];
 for(let i=0;i<3;i++){
  const id=await give();ids.push(id);
  // The first reply is discarded by the caller after COMMIT, then the person retries.
 }
 const rows=(await admin.query('SELECT id,end_reason FROM app.connector_signatures WHERE id=ANY($1::uuid[]) ORDER BY given_at,id',[ids])).rows;
 expect(rows).toEqual(ids.map((id,i)=>({id,end_reason:i===2?null:'superseded'})));
 for(const id of ids.slice(0,2))expect((await admin.query("SELECT payload FROM app.ledger WHERE subject=$1 AND entry_type='signature.ended'",[id])).rows).toEqual([{payload:{signature:id,reason:'superseded'}}]);
 expect((await admin.query('SELECT count(*)::int AS n FROM app.connector_signatures WHERE workspace_id=$1 AND person_id=$2 AND connection_id=$3 AND tool_name=$4 AND ended_at IS NULL',[ws,owner,connection,'draft.note'])).rows[0].n).toBe(1);
 await enter(service,person());try{await service.query('SELECT gov.give_connector_signature($1,$2,$3)',[connection,'draft.note','b'.repeat(64)]);}finally{await service.query('ROLLBACK');}
 expect((await admin.query('SELECT ended_at FROM app.connector_signatures WHERE id=$1',[ids[2]])).rows[0].ended_at).toBeNull();
 expect(await as(person(),'SELECT gov.verify_ledger()')).toBeNull();
});


it('a Core-removed tool refuses standing basis without settling',async()=>{
 const id=await give(),d=await proposal();
 await as({workspace:ws,principal:system},"SELECT gov.record_connection_tools($1,'ok','[{\"name\":\"unsigned\"}]',NULL)",[connection]);
 try{await unchanged(()=>answer(d,basis(id)),'revoked',d);}
 finally{await as({workspace:ws,principal:system},"SELECT gov.record_connection_tools($1,'ok','[{\"name\":\"draft.note\"},{\"name\":\"unsigned\"}]',NULL)",[connection]);}
});
it('the signature terminal trigger refuses revival, reason changes and time changes by both updater roles',async()=>{
 const id=await give();await as(person(),"SELECT gov.end_connector_signature($1,'person_revoked')",[id]);
 for(const role of ['backbone_gov','postgres'])for(const mutation of ["ended_at=NULL,end_reason=NULL","end_reason='superseded'","ended_at=ended_at+interval '1 second'"]){
  await admin.query('BEGIN');try{
   await admin.query("SELECT set_config('backbone.workspace',$1,true)",[ws]);await admin.query(`SET LOCAL ROLE ${role}`);
   await expect(admin.query(`UPDATE app.connector_signatures SET ${mutation} WHERE id=$1`,[id])).rejects.toThrow(/^frozen:/);
  }finally{await admin.query('ROLLBACK');}
 }
 expect(await as(person(),'SELECT gov.verify_ledger()')).toBeNull();
});
