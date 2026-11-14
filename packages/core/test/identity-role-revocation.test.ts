import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect,it } from 'vitest';
import { startTestPostgres } from '../src/db/testing.ts';
import { readFileSync } from 'node:fs';
import { verifyIdentity } from '../src/db/identity-catalogue.ts';
import { upgradeIdentityRoleRevocation } from '../src/db/identity-role-revocation.ts';
import { serviceClient } from '../src/db/session.ts';

it('demoting a project owner to guest immediately removes sharing and both document write crossings',async()=>{
  const postgres=await startTestPostgres(),database=`identity_role_${randomUUID().replaceAll('-','')}`;
  await postgres.clone(database);
  const operator=new pg.Client({connectionString:postgres.operatorUrl(database)}),service=await serviceClient(postgres.appUrl(database));
  try{
    await operator.connect();
    const made=(await operator.query('SELECT * FROM operator.create_workspace($1,$2,$3,$4)',['Role revocation','team','Owner','owner@example.invalid'])).rows[0];
    const as=async(person:string,sql:string,values:unknown[]=[])=>{
      await service.query('BEGIN');try{
        await service.query("SELECT set_config('backbone.workspace',$1,true),set_config('backbone.principal',$2,true)",[made.workspace_id,person]);
        const result=await service.query(sql,values);await service.query('COMMIT');return result.rows;
      }catch(error){await service.query('ROLLBACK');throw error;}
    };
    const owner=made.owner_id as string;
    const admin=(await as(owner,'SELECT gov.identity_add_person($1,NULL,$2) AS id',['Project owner','admin']))[0].id;
    const colleague=(await as(owner,'SELECT gov.identity_add_person($1,NULL,$2) AS id',['Colleague','member']))[0].id;
    const project=randomUUID();
    await as(admin,'SELECT gov.identity_project_create($1)',[project]);
    const task=(await as(admin,'SELECT gov.identity_create_task($1,$2) AS id',[project,'Shared notes']))[0].id;
    const document=(await as(admin,'SELECT gov.create_document($1,$2,$3,NULL) AS id',[task,'Notes','Human words']))[0].id;
    await as(admin,'SELECT gov.identity_project_share($1,$2,$3)',[project,colleague,'viewer']);
    await as(owner,'SELECT gov.identity_change_role($1,$2)',[admin,'guest']);
    expect((await as(admin,'SELECT gov.identity_project_access($1) AS access',[project]))[0].access).toBe('viewer');
    await expect(as(admin,'SELECT gov.identity_project_share($1,$2,$3)',[project,colleague,'editor'])).rejects.toThrow(/denied|role/);
    await expect(as(admin,'SELECT gov.identity_revise_document($1,$2,$3,$4)',[project,document,'Bypass',1])).rejects.toThrow(/denied/);
    await expect(as(admin,'SELECT gov.revise_document($1,NULL,$2)',[document,'Legacy bypass'])).rejects.toMatchObject({code:'42501'});
    expect((await as(admin,'SELECT content FROM app.documents WHERE id=$1',[document]))[0].content).toBe('Human words');
    expect((await as(colleague,'SELECT gov.identity_project_access($1) AS access',[project]))[0].access).toBe('viewer');
    // Role restoration re-enables the retained owner authority without rewriting history.
    await as(owner,'SELECT gov.identity_change_role($1,$2)',[admin,'member']);
    await as(admin,'SELECT gov.identity_project_share($1,$2,$3)',[project,colleague,'editor']);
    await as(admin,'SELECT gov.revise_document($1,NULL,$2)',[document,'Restored owner edit']);
  }finally{await service.end();await operator.end();await postgres.drop(database);await postgres.stop();}
},30_000);


it('a role revocation receipt refuses replayed predecessor bodies instead of blessing their old authority',async()=>{
  const postgres=await startTestPostgres(),database=`identity_receipt_${randomUUID().replaceAll('-','')}`;
  await postgres.clone(database);
  const installer=new pg.Client({connectionString:postgres.adminUrl(database)});
  try{
    await installer.connect();
    expect((await upgradeIdentityRoleRevocation(installer)).state).toBe('verified');
    await installer.query('SET ROLE backbone_gov');
    for(const name of ['identity_person_task_access','identity_project_share']) {
      const source=readFileSync(new URL(`../schema/versions/identity-work-v1/gov/${name}.sql`,import.meta.url),'utf8');
      await installer.query(source.replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION'));
    }
    await installer.query('RESET ROLE');
    expect((await verifyIdentity(installer)).state).toBe('paused');
    expect((await upgradeIdentityRoleRevocation(installer)).state).toBe('paused');
  }finally{await installer.end();await postgres.drop(database);await postgres.stop();}
},30_000);
