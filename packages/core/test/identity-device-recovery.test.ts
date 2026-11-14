import {it,expect} from 'vitest';
import pg from 'pg';
import {deviceRecoveryAvailable,restoreDeviceAccess} from '../src/db/identity-device-recovery.ts';
import {startTestPostgres} from '../src/db/testing.ts';

it('only the trusted operator can restore the device person, with an audit entry and no revived grants',async()=>{
 const postgres=await startTestPostgres();await postgres.clone('device_recovery');
 const admin=new pg.Client({connectionString:postgres.adminUrl('device_recovery')});
 const app=new pg.Client({connectionString:postgres.appUrl('device_recovery')});
 const operator=new pg.Client({connectionString:postgres.operatorUrl('device_recovery')});
 try{
  await Promise.all([admin.connect(),app.connect(),operator.connect()]);
  const made=(await admin.query("SELECT * FROM operator.create_workspace('Recovery','team','Device owner',NULL)")).rows[0];
  await admin.query("UPDATE app.principals SET status='removed',role='guest' WHERE id=$1",[made.owner_id]);
  for(const client of [app,operator])await client.query("SELECT set_config('backbone.workspace',$1,false),set_config('backbone.principal',$2,false)",[made.workspace_id,made.owner_id]);
  // A service caller may set any identity, including an owner: it still has no EXECUTE.
  await expect(app.query('SELECT operator.identity_restore_device_access($1)',[made.owner_id])).rejects.toMatchObject({code:'42501'});
  await expect(operator.query('SELECT operator.identity_restore_device_access($1)',[made.system_id])).rejects.toThrow(/person/);
  expect((await operator.query('SELECT operator.identity_restore_device_access($1) AS id',[made.owner_id])).rows[0].id).toBe(made.owner_id);
  expect((await admin.query('SELECT status,role FROM app.principals WHERE id=$1',[made.owner_id])).rows).toEqual([{status:'active',role:'owner'}]);
  const mandatesBefore=(await admin.query('SELECT id,revoked_at FROM app.mandates ORDER BY id')).rows;
  const entries=(await admin.query("SELECT actor_id,payload FROM app.ledger WHERE workspace_id=$1 AND entry_type='identity.device_access_restored'",[made.workspace_id])).rows;
  expect(entries).toEqual([{actor_id:made.owner_id,payload:{from_status:'removed',from_role:'guest',path:'device'}}]);
  expect((await admin.query('SELECT id,revoked_at FROM app.mandates ORDER BY id')).rows).toEqual(mandatesBefore);
  expect(await deviceRecoveryAvailable(operator)).toBe(true);
  await admin.query("UPDATE app.principals SET status='removed' WHERE id=$1",[made.owner_id]);
  await admin.query('ALTER FUNCTION operator.identity_restore_device_access(uuid) RESET ALL');
  expect(await deviceRecoveryAvailable(operator)).toBe(false);
  await expect(restoreDeviceAccess(operator,made.workspace_id,made.owner_id)).rejects.toThrow(/could not be verified/);
  expect((await admin.query('SELECT status FROM app.principals WHERE id=$1',[made.owner_id])).rows[0].status).toBe('removed');
 }finally{await Promise.all([admin.end(),app.end(),operator.end()]);await postgres.drop('device_recovery');await postgres.stop();}
});

for(const state of ['removed','member'] as const)it(`recovery refuses a device person ${state} by another active owner without changes`,async()=>{
 const postgres=await startTestPostgres();await postgres.clone('recovery_other_owner');
 const admin=new pg.Client({connectionString:postgres.adminUrl('recovery_other_owner')}),operator=new pg.Client({connectionString:postgres.operatorUrl('recovery_other_owner')});
 try{
  await Promise.all([admin.connect(),operator.connect()]);
  const made=(await admin.query("SELECT * FROM operator.create_workspace('Recovery','team','Device',NULL)")).rows[0];
  await admin.query("INSERT INTO app.principals(workspace_id,kind,role,name) VALUES($1,'person','owner','Other owner')",[made.workspace_id]);
  await admin.query("UPDATE app.principals SET status=$2,role=$3 WHERE id=$1",[made.owner_id,state==='removed'?'removed':'active',state==='member'?'member':'owner']);
  await operator.query("SELECT set_config('backbone.workspace',$1,false)",[made.workspace_id]);
  const before=(await admin.query('SELECT id,status,role FROM app.principals ORDER BY id')).rows;
  const ledger=(await admin.query('SELECT count(*) FROM app.ledger')).rows;
  await expect(operator.query('SELECT operator.identity_restore_device_access($1)',[made.owner_id])).rejects.toThrow('Another owner manages this workspace. Ask them to restore your access.');
  expect((await admin.query('SELECT id,status,role FROM app.principals ORDER BY id')).rows).toEqual(before);
  expect((await admin.query('SELECT count(*) FROM app.ledger')).rows).toEqual(ledger);
 }finally{await Promise.all([admin.end(),operator.end()]);await postgres.drop('recovery_other_owner');await postgres.stop();}
});

it('the operator cannot recover a removed colleague even with no active owner',async()=>{
 const postgres=await startTestPostgres();await postgres.clone('recovery_subject');
 const admin=new pg.Client({connectionString:postgres.adminUrl('recovery_subject')}),operator=new pg.Client({connectionString:postgres.operatorUrl('recovery_subject')});
 try{
  await Promise.all([admin.connect(),operator.connect()]);
  const made=(await admin.query("SELECT * FROM operator.create_workspace('Recovery','team','Device',NULL)")).rows[0];
  const other=(await admin.query("INSERT INTO app.principals(workspace_id,kind,role,name,status) VALUES($1,'person','member','Colleague','removed') RETURNING id",[made.workspace_id])).rows[0];
  await admin.query("UPDATE app.principals SET status='removed' WHERE id=$1",[made.owner_id]);
  await operator.query("SELECT set_config('backbone.workspace',$1,false)",[made.workspace_id]);
  await expect(operator.query('SELECT operator.identity_restore_device_access($1)',[other.id])).rejects.toThrow(/device person/);
  expect((await admin.query('SELECT status,role FROM app.principals WHERE id=$1',[other.id])).rows).toEqual([{status:'removed',role:'member'}]);
  expect((await admin.query("SELECT count(*)::int AS n FROM app.ledger WHERE entry_type='identity.device_access_restored'")).rows[0].n).toBe(0);
 }finally{await Promise.all([admin.end(),operator.end()]);await postgres.drop('recovery_subject');await postgres.stop();}
});
