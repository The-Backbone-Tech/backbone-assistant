import type pg from 'pg';
import { CORE_SCHEMA_LOCK, CORE_SCHEMA_UPGRADES, readSchemaHistory, schemaHistoryMatches } from './schema-migrations.ts';
import { MATERIAL_CLOSURE_RELEASE as RELEASE } from './identity-release.generated.ts';
import { verifyMaterialClosureHardeningCatalogue } from './material-closure-hardening-profile.ts';
import { verifyIdentity, identityHash, IDENTITY_VERSION } from './identity-catalogue.ts';
export { verifyIdentity, IDENTITY_VERSION } from './identity-catalogue.ts';

/** One bounded transaction installs the closed artifact and its receipt. A lost commit
 * acknowledgement pauses admission; the next open inspects rather than guessing success. */
export async function upgradeIdentity(client: pg.ClientBase, ownTransaction = true): Promise<{ state: 'verified' | 'paused'; reason: string }> {
  let transaction = false;
  try {
    const index = CORE_SCHEMA_UPGRADES.findIndex(step => step.version === IDENTITY_VERSION);
    if (index < 0 || RELEASE.version !== IDENTITY_VERSION || identityHash(RELEASE.sql) !== RELEASE.checksum || CORE_SCHEMA_UPGRADES[index]?.checksum !== RELEASE.checksum) throw new Error();
    const posture = (await client.query(`SELECT rolsuper,current_setting('server_version_num')::integer AS version FROM pg_roles WHERE rolname=current_user`)).rows;
    if (posture.length !== 1 || posture[0].rolsuper !== true || posture[0].version < 180000 || posture[0].version >= 190000) throw new Error();
    if (ownTransaction) await client.query('BEGIN ISOLATION LEVEL READ COMMITTED'); transaction = true;
    await client.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='30s'");
    await client.query(CORE_SCHEMA_LOCK);
    const history = await readSchemaHistory(client, 'installer');
    if (!schemaHistoryMatches(history) || history.length < index + 1) throw new Error();
    if ((await verifyMaterialClosureHardeningCatalogue(client)).state !== 'verified') throw new Error();
    if (history.length === index + 1) {
      // No old object is replaced and no user data is backfilled. Schema installation
      // cannot race another installer; admission is not mounted until attestation passes.
      await client.query(RELEASE.sql);
      if ((await verifyIdentity(client)).state !== 'verified') throw new Error();
      await client.query('INSERT INTO ops.schema_migrations(version,checksum) VALUES($1,$2)', [IDENTITY_VERSION, RELEASE.checksum]);
    } else if ((await verifyIdentity(client)).state !== 'verified') throw new Error();
    const result = ownTransaction ? await client.query('COMMIT') : {command:'COMMIT'}; transaction = false;
    if (result.command !== 'COMMIT') throw new Error();
    return { state: 'verified', reason: 'Identity installation and receipt are verified.' };
  } catch {
    if (transaction && ownTransaction) await client.query('ROLLBACK').catch(() => {});
    return { state: 'paused', reason: 'Identity installation could not be confirmed; admission remains closed.' };
  }
}
