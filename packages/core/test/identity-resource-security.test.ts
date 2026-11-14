import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {expect,it} from 'vitest';
import {startTestPostgres} from '../src/db/testing.ts';
import {verifyIdentity} from '../src/db/identity-catalogue.ts';
import {verifyMaterialClosureHardeningCatalogue} from '../src/db/material-closure-hardening-profile.ts';
import {serviceClient} from '../src/db/session.ts';

async function fixture(work:(f:{service:pg.Client;observer:pg.Client;ws:string;owner:string;as:(person:string|null,sql:string,values?:unknown[],run?:{id:string;secret:string})=>Promise<pg.QueryResultRow[]>})=>Promise<void>){
 const postgres=await startTestPostgres(),database=`identity_resource_${randomUUID().replaceAll('-','')}`;await postgres.clone(database);
 const observer=new pg.Client({connectionString:postgres.adminUrl(database)}),operator=new pg.Client({connectionString:postgres.operatorUrl(database)}),service=await serviceClient(postgres.appUrl(database));
 try{await observer.connect();await operator.connect();const made=(await operator.query('SELECT * FROM operator.create_workspace($1,$2,$3,$4)',['Resource security','team','Owner','owner@example.invalid'])).rows[0];
 const as=async(person:string|null,sql:string,values:unknown[]=[],run?:{id:string;secret:string})=>{await service.query('BEGIN');try{await service.query("SELECT set_config('backbone.workspace',$1,true),set_config('backbone.principal',$2,true),set_config('backbone.run',$3,true),set_config('backbone.secret',$4,true)",[made.workspace_id,person??'',run?.id??'',run?.secret??'']);const result=await service.query(sql,values);await service.query('COMMIT');return result.rows;}catch(error){await service.query('ROLLBACK');throw error;}};
 await work({service,observer,ws:made.workspace_id,owner:made.owner_id,as});
 }finally{await service.end();await observer.end();await operator.end();await postgres.drop(database);await postgres.stop();}
}

it('legacy task creation binds a project, while an orphan or a connection without a person cannot read task data',async()=>fixture(async({observer,ws,owner,as})=>{
 const task=(await as(owner,'SELECT gov.create_task($1,$1,$2,NULL,NULL) AS id',[owner,'Legacy entry point']))[0].id;
 await expect(as(owner,'SELECT gov.identity_cancel_mandate_work($1,$2)',[[randomUUID()],owner])).rejects.toMatchObject({code:'42501'});
 await observer.query('BEGIN');
 await observer.query('ALTER TABLE app.tasks DISABLE TRIGGER identity_task_project_binding');
 expect((await verifyIdentity(observer)).state).toBe('paused');expect((await verifyMaterialClosureHardeningCatalogue(observer)).state).toBe('paused');
 await observer.query('ROLLBACK');
 expect((await as(null,'SELECT gov.identity_task_access($1,false) AS allowed',[task]))[0].allowed).toBe(false);
 expect((await observer.query('SELECT count(*)::int AS n FROM app.tasks t LEFT JOIN app.identity_task_projects p ON p.workspace_id=t.workspace_id AND p.task_id=t.id WHERE t.workspace_id=$1 AND p.task_id IS NULL',[ws])).rows[0].n).toBe(0);
 expect((await as(owner,'SELECT id FROM app.tasks WHERE id=$1',[task])).length).toBe(1);
 // Only the disposable catalogue observer can forge the missing binding.
 await observer.query('DELETE FROM app.identity_task_projects WHERE workspace_id=$1 AND task_id=$2',[ws,task]);
 expect((await as(owner,'SELECT gov.identity_person_task_access($1,$2,false) AS allowed',[task,owner]))[0].allowed).toBe(false);
 expect(await as(owner,'SELECT id FROM app.tasks WHERE id=$1',[task])).toEqual([]);
}),30_000);

it('an admin cannot read hidden project runs or effects through definer policies but removal still cancels both',async()=>fixture(async({observer,ws,owner,as})=>{
 const member=(await as(owner,'SELECT gov.identity_add_person($1,NULL,$2) AS id',['Member','member']))[0].id,project=randomUUID();
 await as(member,'SELECT gov.identity_project_create($1)',[project]);
 const task=(await as(member,'SELECT gov.identity_create_task($1,$2) AS id',[project,'Private work']))[0].id;
 const runtime=(await as(member,'SELECT * FROM gov.identity_runtime(NULL)'))[0];
 const run=(await as(member,'SELECT gov.queue_run($1,$2,$3,NULL,NULL) AS id',[task,runtime.agent,runtime.mandate]))[0].id;
 const claim=(await as(null,'SELECT * FROM gov.claim_run($1,$2,$3,$4,NULL)',[run,'security-fixture',60_000,'direct']))[0];
 const effect=(await as(null,"SELECT gov.propose_effect($1,$2,NULL,'fixture','outbox.write',NULL,NULL,NULL,NULL,$3::jsonb,'Private proposal',NULL,$4) AS id",[run,claim.fence,JSON.stringify({name:'private.txt',content:'Private words'}),randomUUID()],{id:run,secret:claim.secret}))[0].id;
 for(const table of ['runs','effects']){
  await observer.query('BEGIN');try{await observer.query("SELECT set_config('backbone.workspace',$1,true),set_config('backbone.principal',$2,true)",[ws,owner]);await observer.query('SET LOCAL ROLE backbone_gov');expect((await observer.query(`SELECT id FROM app.${table} WHERE task_id=$1`,[task])).rows).toEqual([]);}finally{await observer.query('ROLLBACK');}
 }
 await as(owner,'SELECT gov.identity_remove($1)',[member]);
 expect((await observer.query('SELECT status FROM app.runs WHERE id=$1',[run])).rows[0].status).toBe('cancelled');
 expect((await observer.query('SELECT status FROM app.effects WHERE id=$1',[effect])).rows[0].status).toBe('cancelled');
}),30_000);

it('legacy workspace publication reaches later people but grants neither anonymous reads nor access to another task',async()=>fixture(async({owner,as})=>{
 const shared=(await as(owner,'SELECT gov.create_task($1,$1,$2,NULL,NULL) AS id',[owner,'Published legacy task']))[0].id;
 const privateTask=(await as(owner,'SELECT gov.create_task($1,$1,$2,NULL,NULL) AS id',[owner,'Private legacy task']))[0].id;
 await as(owner,'SELECT gov.share_task($1)',[shared]);
 const later=(await as(owner,'SELECT gov.identity_add_person($1,NULL,$2) AS id',['Later member','member']))[0].id;
 expect((await as(later,'SELECT id FROM app.tasks WHERE id IN($1,$2)',[shared,privateTask])).map(row=>row.id)).toEqual([shared]);
 expect(await as(null,'SELECT id FROM app.tasks WHERE id=$1',[shared])).toEqual([]);
}),30_000);
