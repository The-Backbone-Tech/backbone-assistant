import type pg from 'pg';
import { CORE_SCHEMA_LOCK, CORE_SCHEMA_UPGRADES, readSchemaHistory, schemaHistoryMatches } from './schema-migrations.ts';
import { MATERIAL_CLOSURE_RELEASE as RELEASE } from './identity-resource-release.generated.ts';
import { verifyMaterialClosureHardeningCatalogue } from './material-closure-hardening-profile.ts';
import { verifyIdentity, identityHash, captureIdentity } from './identity-catalogue.ts';
import { IDENTITY_RESOURCE_PINS as PINS } from './identity-resource-pins.ts';
export const IDENTITY_RESOURCE_VERSION = 'identity-resource-guard-v1';

export async function upgradeIdentityResource(client: pg.ClientBase, ownTransaction = true): Promise<{ state: 'verified' | 'paused'; reason: string }> {
  let transaction = false;
  try {
    const index = CORE_SCHEMA_UPGRADES.findIndex(step => step.version === IDENTITY_RESOURCE_VERSION);
    if (index < 0 || RELEASE.version !== IDENTITY_RESOURCE_VERSION || identityHash(RELEASE.sql) !== RELEASE.checksum || CORE_SCHEMA_UPGRADES[index].checksum !== RELEASE.checksum) throw new Error();
    const posture = (await client.query(`SELECT rolsuper,current_setting('server_version_num')::integer AS version FROM pg_roles WHERE rolname=current_user`)).rows;
    if (posture.length !== 1 || posture[0].rolsuper !== true || posture[0].version < 180000 || posture[0].version >= 190000) throw new Error();
    if (ownTransaction) await client.query('BEGIN ISOLATION LEVEL READ COMMITTED'); transaction = true;
    await client.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='30s'");
    await client.query(CORE_SCHEMA_LOCK);
    const history = await readSchemaHistory(client, 'installer');
    if (!schemaHistoryMatches(history) || history.length < index + 1) throw new Error();
    if ((await verifyIdentity(client)).state !== 'verified' || (await verifyMaterialClosureHardeningCatalogue(client)).state !== 'verified') throw new Error();
    if (history.length === index + 1) {
      await client.query(RELEASE.sql);
      await backfillTaskProjects(client);
      await client.query('INSERT INTO ops.schema_migrations(version,checksum) VALUES($1,$2)', [IDENTITY_RESOURCE_VERSION, RELEASE.checksum]);
      if ((await verifyIdentity(client)).state !== 'verified' || (await verifyMaterialClosureHardeningCatalogue(client)).state !== 'verified') throw new Error();
    }
    // A receipt cannot bless a reverted predecessor or a mixed catalogue.
    if (!PINS || (history.length<=index+2&&identityHash(JSON.stringify(await captureIdentity(client))) !== PINS.catalogue)) throw new Error();
    const result = ownTransaction ? await client.query('COMMIT') : {command:'COMMIT'}; transaction = false;
    if (result.command !== 'COMMIT') throw new Error();
    return { state: 'verified', reason: 'Identity resource guard installation and receipt are verified.' };
  } catch {
    if (transaction && ownTransaction) await client.query('ROLLBACK').catch(() => {});
    return { state: 'paused', reason: 'Identity resource guard installation could not be confirmed; admission remains closed.' };
  }
}


/** Installation holds the schema lock and its transaction. Preserve the old task
 * audience while giving every historical task a concrete project boundary. */
async function backfillTaskProjects(client:pg.ClientBase, ownTransaction = true){
  await client.query(`INSERT INTO app.identity_projects(workspace_id,project_id,owner_id)
    SELECT t.workspace_id,t.id,t.requested_by FROM app.tasks t WHERE NOT EXISTS(SELECT FROM app.identity_task_projects p WHERE p.workspace_id=t.workspace_id AND p.task_id=t.id)`);
  await client.query(`INSERT INTO app.identity_project_people(workspace_id,project_id,person_id,access)
    SELECT DISTINCT t.workspace_id,t.id,p.id,CASE WHEN p.role='guest' THEN 'viewer' ELSE 'editor' END
    FROM app.tasks t JOIN app.principals p ON p.workspace_id=t.workspace_id AND p.kind='person' AND p.status='active' AND p.id<>t.requested_by
    WHERE NOT EXISTS(SELECT FROM app.identity_task_projects x WHERE x.workspace_id=t.workspace_id AND x.task_id=t.id)
      AND (t.visibility='workspace' OR p.id=t.on_behalf_of OR EXISTS(SELECT FROM app.task_people a WHERE a.workspace_id=t.workspace_id AND a.task_id=t.id AND a.person_id=p.id))`);
  await client.query(`INSERT INTO app.identity_workspace_projects(workspace_id,project_id) SELECT t.workspace_id,t.id FROM app.tasks t WHERE t.visibility='workspace' AND NOT EXISTS(SELECT FROM app.identity_task_projects x WHERE x.workspace_id=t.workspace_id AND x.task_id=t.id)`);
  await client.query(`INSERT INTO app.identity_task_projects(workspace_id,task_id,project_id)
    SELECT t.workspace_id,t.id,t.id FROM app.tasks t WHERE NOT EXISTS(SELECT FROM app.identity_task_projects x WHERE x.workspace_id=t.workspace_id AND x.task_id=t.id)`);
  if((await client.query(`SELECT 1 FROM app.tasks t WHERE NOT EXISTS(SELECT FROM app.identity_task_projects x WHERE x.workspace_id=t.workspace_id AND x.task_id=t.id) LIMIT 1`)).rowCount)throw new Error('Task project backfill could not be confirmed.');
}
