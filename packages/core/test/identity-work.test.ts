import { randomBytes,randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect,it } from 'vitest';
import { startTestPostgres } from '../src/db/testing.ts';
import { verifyIdentity } from '../src/db/identity-catalogue.ts';
import { verifyMaterialClosureHardeningCatalogue } from '../src/db/material-closure-hardening-profile.ts';
import { serviceClient } from '../src/db/session.ts';

it('project viewers cannot revise through either crossing, editors preserve prior words, and directory removal cannot be undone by stale sync',async()=>{
  const postgres=await startTestPostgres(),database=`identity_work_${randomUUID().replaceAll('-','')}`;
  await postgres.clone(database);
  const operator=new pg.Client({connectionString:postgres.operatorUrl(database)}),observer=new pg.Client({connectionString:postgres.adminUrl(database)}),service=await serviceClient(postgres.appUrl(database));
  try{
    await operator.connect();await observer.connect();
    const made=(await operator.query('SELECT * FROM operator.create_workspace($1,$2,$3,$4)',['Identity work','team','Owner','owner@example.invalid'])).rows[0];
    const as=async(person:string|null,sql:string,values:unknown[]=[])=>{
      await service.query('BEGIN');try{await service.query(`SELECT set_config('backbone.workspace',$1,true),set_config('backbone.principal',$2,true),set_config('backbone.run','',true),set_config('backbone.secret','',true)`,[made.workspace_id,person??'']);const result=await service.query(sql,values);await service.query('COMMIT');return result.rows;}catch(error){await service.query('ROLLBACK');throw error;}
    };
    const owner=made.owner_id as string,project=randomUUID();
    await as(owner,'SELECT gov.identity_project_create($1)',[project]);
    const member=(await as(owner,'SELECT gov.identity_add_person($1,NULL,$2) AS id',['Colleague','member']))[0].id;
    const task=(await as(owner,'SELECT gov.identity_create_task($1,$2) AS id',[project,'Shared project task']))[0].id;
    const document=(await as(owner,'SELECT gov.create_document($1,$2,$3,NULL) AS id',[task,'Notes','Original words']))[0].id;
    await as(owner,'SELECT gov.identity_project_share($1,$2,$3)',[project,member,'viewer']);
    expect((await as(member,'SELECT gov.identity_document_version($1,$2) AS version',[project,document]))[0].version).toBe(1);
    await expect(as(member,'SELECT gov.identity_revise_document($1,$2,$3,$4)',[project,document,'Changed',1])).rejects.toThrow(/denied/);
    await expect(as(member,'SELECT gov.revise_document($1,NULL,$2)',[document,'Bypass'])).rejects.toMatchObject({code:'42501'});
    expect((await as(member,'SELECT content FROM app.documents WHERE id=$1',[document]))[0].content).toBe('Original words');
    const ownTask=(await as(member,'SELECT gov.create_task($1,$1,$2,NULL,NULL) AS id',[member,'Private']))[0].id;
    await expect(as(member,'SELECT gov.identity_bind_task($1,$2)',[project,ownTask])).rejects.toThrow(/denied/);
    await as(owner,'SELECT gov.identity_project_share($1,$2,$3)',[project,member,'editor']);
    expect((await as(member,'SELECT gov.identity_revise_document($1,$2,$3,$4) AS version',[project,document,'Human edit',1]))[0].version).toBe(2);
    expect((await observer.query('SELECT content FROM app.document_versions WHERE document_id=$1 AND version=1',[document])).rows[0].content).toBe('Original words');
    expect((await observer.query('SELECT content_author FROM app.documents WHERE id=$1',[document])).rows[0].content_author).toBe(member);
    await expect(as(member,'SELECT gov.identity_revise_document($1,$2,$3,$4)',[project,document,'Stale overwrite',1])).rejects.toThrow(/stale/);
    await as(owner,'SELECT gov.identity_project_share($1,$2,NULL)',[project,member]);
    expect(await as(member,'SELECT content FROM app.documents WHERE id=$1',[document])).toEqual([]);
    await observer.query('BEGIN');
    await observer.query("SELECT set_config('backbone.workspace',$1,true)",[made.workspace_id]);
    await observer.query('SET LOCAL ROLE backbone_gov');
    expect((await observer.query('SELECT sec.task_visible_to($1,$2) AS visible',[task,member])).rows[0].visible).toBe(false);
    await observer.query('ROLLBACK');
    expect((await observer.query('SELECT count(*)::int AS n FROM app.task_people WHERE task_id=$1 AND person_id=$2',[task,member])).rows[0].n).toBe(1);
    expect((await verifyMaterialClosureHardeningCatalogue(observer)).state).toBe('verified');
    await observer.query('BEGIN');
    await observer.query('DROP POLICY identity_project_insert ON app.document_versions');
    expect((await verifyIdentity(observer)).state).toBe('paused');
    expect((await verifyMaterialClosureHardeningCatalogue(observer)).state).toBe('paused');
    await observer.query('ROLLBACK');
    const issuer='https://directory.example.invalid',subject=randomUUID();
    const provisioned=(await as(owner,'SELECT gov.identity_directory_create($1,$2,$3,$4) AS id',[issuer,subject,'directory-person','Directory person']))[0].id;
    const session=randomBytes(32).toString('hex');
    await as(null,'SELECT gov.identity_sign_in($1,$2,$3)',[issuer,subject,session]);
    await as(owner,'SELECT gov.identity_directory_update($1,$2,$3,$4,$5)',[issuer,provisioned,'Directory person',false,1]);
    expect(await as(null,'SELECT * FROM gov.identity_session($1)',[session])).toEqual([]);
    await expect(as(owner,'SELECT gov.identity_directory_update($1,$2,$3,$4,$5)',[issuer,provisioned,'Directory person',true,1])).rejects.toThrow(/stale/);
    await expect(as(owner,'SELECT gov.identity_directory_update($1,$2,$3,$4,$5)',[issuer,provisioned,'Directory person',true,2])).rejects.toThrow(/revoked/);
    expect(await as(owner,'SELECT * FROM gov.identity_directory_list($1)',['https://other.example.invalid'])).toEqual([]);
    // The workspace admin cannot read this project, but atomic removal must still
    // stop its run. A stopped holder may account for spending without regaining access.
    const memberProject=randomUUID();
    await as(member,'SELECT gov.identity_project_create($1)',[memberProject]);
    const memberTask=(await as(member,'SELECT gov.identity_create_task($1,$2) AS id',[memberProject,'Member private project']))[0].id;
    const runtime=(await as(member,'SELECT * FROM gov.identity_runtime(NULL)'))[0];
    const run=(await as(member,'SELECT gov.queue_run($1,$2,$3,NULL,NULL) AS id',[memberTask,runtime.agent,runtime.mandate]))[0].id;
    const claim=(await as(null,'SELECT * FROM gov.claim_run($1,$2,$3,$4,NULL)',[run,'identity-work-worker',60_000,'direct']))[0];
    await as(owner,'SELECT gov.identity_remove($1)',[member]);
    expect((await observer.query('SELECT status FROM app.runs WHERE id=$1',[run])).rows[0].status).toBe('cancelled');
    await service.query('BEGIN');
    try {
      await service.query("SELECT set_config('backbone.workspace',$1,true),set_config('backbone.run',$2,true),set_config('backbone.secret',$3,true)",[made.workspace_id,run,claim.secret]);
      expect((await service.query('SELECT gov.record_usage($1,$2,2,3,0) AS standing',[run,claim.fence])).rows[0].standing).toBe('mandate_revoked');
      expect((await service.query('SELECT sec.current_principal() AS person')).rows[0].person).toBe(null);
      await service.query('COMMIT');
    } catch(error) {await service.query('ROLLBACK');throw error;}
  }finally{await service.end();await operator.end();await observer.end();await postgres.drop(database);await postgres.stop();}
},30_000);
