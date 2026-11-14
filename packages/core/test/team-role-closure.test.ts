import {randomBytes,randomUUID} from 'node:crypto';
import {it,expect} from 'vitest';
import pg from 'pg';
import {startTestPostgres} from '../src/db/testing.ts';
import {upgradeIdentityHardening} from '../src/db/identity-hardening.ts';
import {verifyIdentityRuntime} from '../src/db/identity-runtime.ts';
it('service callers cannot bypass identity person crossings and the last owner remains protected',async()=>{
 const postgres=await startTestPostgres(),db=`role_closure_${randomUUID().replaceAll('-','')}`;await postgres.clone(db);
 const admin=new pg.Client({connectionString:postgres.adminUrl(db)}),service=new pg.Client({connectionString:postgres.appUrl(db)});
 try{
  await admin.connect();await service.connect();await upgradeIdentityHardening(admin);const made=(await admin.query("SELECT * FROM operator.create_workspace('Team','team','Owner',NULL)")).rows[0];
  const as=async(person:string|null,sql:string,args:unknown[]=[])=>{await service.query('BEGIN');try{await service.query("SELECT set_config('backbone.workspace',$1,true),set_config('backbone.principal',$2,true)",[made.workspace_id,person??'']);const result=await service.query(sql,args);await service.query('COMMIT');return result.rows;}catch(e){await service.query('ROLLBACK');throw e;}};
  for(const signature of ['gov.change_role(uuid,text)','gov.add_person(text,text,text)','gov.accept_invitation(text,text)'])expect((await service.query('SELECT has_function_privilege(current_user,$1,\'EXECUTE\') AS allowed',[signature])).rows[0].allowed).toBe(false);
  await expect(as(made.owner_id,'SELECT gov.change_role($1,$2)',[made.owner_id,'guest'])).rejects.toThrow(/permission denied/);
  await expect(as(made.owner_id,"SELECT gov.add_person('Bypass',NULL,'member')")).rejects.toThrow(/permission denied/);
  await expect(as(null,"SELECT * FROM gov.accept_invitation($1,'Bypass')",['0'.repeat(64)])).rejects.toThrow(/permission denied/);
  const hash=()=>randomBytes(32).toString('hex'),inv=hash();
  await as(made.owner_id,'SELECT gov.identity_invite($1,$2,$3)',[inv,'admin',new Date(Date.now()+60000)]);
  const other=(await as(null,'SELECT gov.identity_accept($1,$2,$3,$4,$5) AS id',[inv,'fixture',randomUUID(),'Admin',hash()]))[0].id;
  await as(made.owner_id,'SELECT gov.identity_change_role($1,$2)',[other,'member']);
  await expect(as(made.owner_id,'SELECT gov.identity_change_role($1,$2)',[made.owner_id,'guest'])).rejects.toThrow(/role: keep a live owner/);
  expect((await verifyIdentityRuntime(admin)).state).toBe('verified');
  await admin.query('GRANT EXECUTE ON FUNCTION gov.change_role(uuid,text) TO backbone_app');
  expect((await verifyIdentityRuntime(admin)).state).toBe('paused');
 }finally{await service.end();await admin.end();await postgres.drop(db);await postgres.stop();}
},30_000);
it('serialized legacy invitations retain the empty-session ABI, one-use acceptance and audit actor',async()=>{
 const postgres=await startTestPostgres(),db=`invitation_closure_${randomUUID().replaceAll('-','')}`;await postgres.clone(db);
 const admin=new pg.Client({connectionString:postgres.adminUrl(db)}),service=new pg.Client({connectionString:postgres.appUrl(db)});
 try{
  await admin.connect();await service.connect();const made=(await admin.query("SELECT * FROM operator.create_workspace('Legacy invitation','team','Owner',NULL)")).rows[0];
  const token=randomBytes(32).toString('hex');
  await admin.query("INSERT INTO ops.invitations(token_hash,workspace_id,role,invited_by,expires_at) VALUES($1,$2,'member',$3,clock_timestamp()+interval '1 hour')",[token,made.workspace_id,made.owner_id]);
  await service.query('BEGIN');await service.query("SELECT set_config('backbone.workspace',$1,true)",[made.workspace_id]);
  await expect(service.query('SELECT * FROM gov.identity_accept_legacy($1,$2)',[token,'Legacy member'])).rejects.toThrow(/empty_session_only/);await service.query('ROLLBACK');
  const accepted=(await service.query('SELECT * FROM gov.identity_accept_legacy($1,$2)',[token,'Legacy member'])).rows;
  expect(accepted).toHaveLength(1);expect(accepted[0].workspace_id).toBe(made.workspace_id);
  expect((await service.query("SELECT coalesce(current_setting('backbone.workspace',true),'') AS workspace")).rows[0].workspace).toBe('');
  expect((await admin.query('SELECT actor_id FROM app.ledger WHERE workspace_id=$1 AND subject=$2 AND entry_type=$3',[made.workspace_id,accepted[0].principal_id,'person.added'])).rows[0].actor_id).toBe(accepted[0].principal_id);
  expect((await service.query('SELECT * FROM gov.identity_accept_legacy($1,$2)',[token,'Retry'])).rows).toEqual([]);
 }finally{await service.end();await admin.end();await postgres.drop(db);await postgres.stop();}
},30_000);
