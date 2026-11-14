import {randomUUID} from 'node:crypto';
import {afterEach,expect,it} from 'vitest';
import pg from 'pg';
import {startTestPostgres,type TestPostgres} from '../src/db/testing.ts';
import {verifyIdentityRuntime} from '../src/db/identity-runtime.ts';
let postgres:TestPostgres|undefined,client:pg.Client|undefined,database='';
afterEach(async()=>{await client?.end();if(postgres){await postgres.drop(database);await postgres.stop();}client=undefined;postgres=undefined;});
async function fixture(){
 postgres=await startTestPostgres();database=`identity_platform_${randomUUID().replaceAll('-','')}`;await postgres.clone(database);
 client=new pg.Client({connectionString:postgres.adminUrl(database)});await client.connect();
 const made=(await client.query("SELECT * FROM operator.create_workspace('Synthetic','team','Owner','owner@fixture.invalid')")).rows[0];
 return {admin:client,workspace:made.workspace_id as string,person:made.owner_id as string};
}
it('an admitted privileged task insert binds its own workspace and restores the caller session',async()=>{
 const {admin,workspace,person}=await fixture(),task=randomUUID();
 const previous=randomUUID();await admin.query('BEGIN');
 await admin.query("SELECT set_config('backbone.workspace',$1,true)",[previous]);
 await admin.query("INSERT INTO app.tasks(workspace_id,id,title,visibility,requested_by,on_behalf_of) VALUES($1,$2,'Synthetic shared source','workspace',$3,$3)",[workspace,task,person]);
 expect((await admin.query('SELECT project_id FROM app.identity_task_projects WHERE workspace_id=$1 AND task_id=$2',[workspace,task])).rows).toEqual([{project_id:task}]);
 expect((await admin.query("SELECT current_setting('backbone.workspace',true) AS workspace")).rows).toEqual([{workspace:previous}]);
 await admin.query('COMMIT');
 expect((await verifyIdentityRuntime(admin)).state).toBe('verified');
});
it('an unnamed mutating statement refuses before project filtering can hide all target rows',async()=>{
 const {admin,workspace}=await fixture();
 for(const table of ['episodes','knowledge_candidates','ledger']){
  await admin.query('BEGIN');await admin.query('SET LOCAL ROLE backbone_gov');
  await admin.query("SELECT set_config('backbone.workspace',$1,true)",[workspace]);
  await expect(admin.query(`DELETE FROM app.${table}`)).rejects.toThrow(/permission denied/);
  await admin.query('ROLLBACK');
 }
});
