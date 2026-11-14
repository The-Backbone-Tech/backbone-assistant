import type pg from 'pg';
import { CORE_SCHEMA_LOCK, CORE_SCHEMA_UPGRADES, readSchemaHistory, schemaHistoryMatches } from './schema-migrations.ts';
import { MATERIAL_CLOSURE_RELEASE as RELEASE } from './identity-role-revocation-release.generated.ts';
import { verifyMaterialClosureHardeningCatalogue } from './material-closure-hardening-profile.ts';
import { verifyIdentity, identityHash, captureIdentity } from './identity-catalogue.ts';
import { IDENTITY_ROLE_REVOCATION_PINS as PINS } from './identity-role-revocation-pins.ts';
export const IDENTITY_ROLE_REVOCATION_VERSION = 'identity-role-revocation-v1';

export async function upgradeIdentityRoleRevocation(client: pg.ClientBase, ownTransaction = true): Promise<{ state: 'verified' | 'paused'; reason: string }> {
  let transaction = false;
  try {
    const index = CORE_SCHEMA_UPGRADES.findIndex(step => step.version === IDENTITY_ROLE_REVOCATION_VERSION);
    if (index < 0 || RELEASE.version !== IDENTITY_ROLE_REVOCATION_VERSION || identityHash(RELEASE.sql) !== RELEASE.checksum || CORE_SCHEMA_UPGRADES[index].checksum !== RELEASE.checksum) throw new Error();
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
      if ((await verifyIdentity(client)).state !== 'verified' || (await verifyMaterialClosureHardeningCatalogue(client)).state !== 'verified') throw new Error();
      await client.query('INSERT INTO ops.schema_migrations(version,checksum) VALUES($1,$2)', [IDENTITY_ROLE_REVOCATION_VERSION, RELEASE.checksum]);
    }
    // A receipt cannot bless a reverted predecessor or a mixed catalogue.
    if (!PINS || (history.length<=index+2&&identityHash(JSON.stringify(await captureIdentity(client))) !== PINS.catalogue)) throw new Error();
    const result = ownTransaction ? await client.query('COMMIT') : {command:'COMMIT'}; transaction = false;
    if (result.command !== 'COMMIT') throw new Error();
    return { state: 'verified', reason: 'Identity role revocation installation and receipt are verified.' };
  } catch {
    if (transaction && ownTransaction) await client.query('ROLLBACK').catch(() => {});
    return { state: 'paused', reason: 'Identity role revocation installation could not be confirmed; admission remains closed.' };
  }
}
