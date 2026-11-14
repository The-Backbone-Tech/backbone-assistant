// Real invocations for the additive-body grader, all inside its caller's rollback-only transaction.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import type {CoreLink} from '../src/composition/core.ts';

export function signatureLedgerBodyFixtures(client:pg.Client,link:CoreLink,connection:string):Map<string,()=>Promise<void>>{
 const identity=async(principal:string)=>{await client.query(`SELECT set_config('backbone.workspace',$1,true),
  set_config('backbone.principal',$2,true),set_config('backbone.run','',true),set_config('backbone.secret','',true)`,[link.id.workspace,principal]);};
 const give=async()=>{
  await identity(link.id.system);
  await client.query("SELECT gov.record_connection_tools($1,'ok',$2::jsonb,NULL)",[connection,JSON.stringify([{name:'body_fixture'}])]);
  await identity(link.id.person);
  const id=(await client.query("SELECT gov.give_connector_signature($1,'body_fixture',$2) AS id",[connection,'a'.repeat(64)])).rows[0].id as string;
  assert.equal((await client.query("SELECT count(*)::int AS n FROM app.ledger WHERE entry_type='signature.given' AND subject=$1",[id])).rows[0].n,1);
  return id;
 };
 const end=async()=>{
  const id=await give();await client.query("SELECT gov.end_connector_signature($1,'person_revoked')",[id]);
  assert.equal((await client.query('SELECT end_reason FROM app.connector_signatures WHERE id=$1',[id])).rows[0].end_reason,'person_revoked');
  assert.equal((await client.query("SELECT count(*)::int AS n FROM app.ledger WHERE entry_type='signature.ended' AND subject=$1",[id])).rows[0].n,1);
  return id;
 };
 const decision=async()=>{
  await identity(link.id.person);const id=randomUUID();
  await client.query(`INSERT INTO app.decisions(workspace_id,id,subject_kind,subject_id,proposer_id,checker_kind,checker_id,reason,proposal_hash)
   VALUES($1,$2,'elevation',$3,$4,'person',$5,'body fixture','body-hash')`,[link.id.workspace,id,randomUUID(),link.id.agent,link.id.person]);
  return id;
 };
 const answered=async(id:string)=>{
  assert.equal((await client.query('SELECT status FROM app.decisions WHERE id=$1',[id])).rows[0].status,'rejected');
  assert.deepEqual((await client.query("SELECT payload->'basis' AS basis FROM app.ledger WHERE entry_type='decision.answered' AND subject=$1",[id])).rows,[{basis:{method:'person'}}]);
 };
 return new Map([
  ['gov.give_connector_signature',async()=>{await give();}],
  ['gov.end_connector_signature',async()=>{await end();}],
  ['sec.t_connector_signature_terminal',async()=>{
   const id=await end();
   await assert.rejects(client.query('UPDATE app.connector_signatures SET ended_at=NULL,end_reason=NULL WHERE id=$1',[id]),(error:unknown)=>error instanceof Error&&/^frozen:/.test(error.message));
  }],
  ['gov.answer_decision_with_basis',async()=>{
   const id=await decision();
   assert.equal((await client.query("SELECT gov.answer_decision_with_basis($1,'body-hash','rejected',NULL,'{\"method\":\"person\"}') AS verdict",[id])).rows[0].verdict,'rejected');
   await answered(id);
  }],
  ['gov._settle_decision_with_basis',async()=>{
   const id=await decision();
   await client.query("SELECT gov._settle_decision_with_basis($1,'rejected',$2,NULL,'{\"method\":\"person\"}')",[id,link.id.person]);
   await answered(id);
  }],
 ]);
}
