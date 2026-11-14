import type pg from 'pg';
import {CORE_SCHEMA_LOCK,CORE_SCHEMA_UPGRADES,readSchemaHistory,schemaHistoryMatches} from './schema-migrations.ts';
import {verifyIdentity,captureIdentity,identityHash} from './identity-catalogue.ts';
import {verifyMaterialClosureHardeningCatalogue} from './material-closure-hardening-profile.ts';
import {IDENTITY_HARDENING_PINS} from './identity-hardening-pins.ts';
import {IDENTITY_HARDENING_RELEASES} from './identity-hardening-source.ts';
export {IDENTITY_HARDENING_RELEASES} from './identity-hardening-source.ts';
export async function upgradeIdentityHardening(client:pg.ClientBase, ownTransaction = true){
 for(const release of IDENTITY_HARDENING_RELEASES){
  let transaction=false;
  try{
   const index=CORE_SCHEMA_UPGRADES.findIndex(step=>step.version===release.version),pins=IDENTITY_HARDENING_PINS.find(row=>row.version===release.version);
   if(index<0||!pins||pins.payload!==release.checksum||identityHash(release.sql)!==release.checksum||CORE_SCHEMA_UPGRADES[index].checksum!==release.checksum)throw new Error();
   const posture=(await client.query("SELECT rolsuper,current_setting('server_version_num')::integer AS version FROM pg_roles WHERE rolname=current_user")).rows[0];
   if(!posture?.rolsuper||posture.version<180000||posture.version>=190000)throw new Error();
   if (ownTransaction) await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');transaction=true;
   await client.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='30s'");await client.query(CORE_SCHEMA_LOCK);
   const history=await readSchemaHistory(client,'installer');
   if(!schemaHistoryMatches(history)||history.length<index+1||(await verifyIdentity(client)).state!=='verified'||(await verifyMaterialClosureHardeningCatalogue(client)).state!=='verified')throw new Error();
   if(history.length===index+1){
    if(identityHash(JSON.stringify(await captureIdentity(client)))!==pins.predecessor)throw new Error();
    await client.query(release.sql);
    await client.query('INSERT INTO ops.schema_migrations(version,checksum) VALUES($1,$2)',[release.version,release.checksum]);
   }
   if((history.length<=index+2&&identityHash(JSON.stringify(await captureIdentity(client)))!==pins.catalogue)||(await verifyIdentity(client)).state!=='verified'||(await verifyMaterialClosureHardeningCatalogue(client)).state!=='verified')throw new Error();
   if(ownTransaction&&(await client.query('COMMIT')).command!=='COMMIT')throw new Error();transaction=false;
  }catch{if(transaction&&ownTransaction)await client.query('ROLLBACK').catch(()=>{});return {state:'paused' as const,reason:`${release.version} installation could not be confirmed; identity access remains closed.`};}
 }
 return {state:'verified' as const,reason:'Identity hardening installations and receipts are verified.'};
}
