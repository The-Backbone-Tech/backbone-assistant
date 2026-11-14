import {IDENTITY_HARDENING_PINS} from './identity-hardening-pins.ts';
// Upgrade qualification accepts exact predecessor phases. Runtime admission must
// instead attest the full supported history and the final, complete profile.
import type pg from 'pg';
import {CORE_SCHEMA_UPGRADES,readSchemaHistory,schemaHistoryMatches} from './schema-migrations.ts';
import {captureIdentity,identityHash,verifyIdentity} from './identity-catalogue.ts';
import {IDENTITY_PLATFORM_PINS} from './identity-platform-pins.ts';
import {verifyMaterialClosureHardeningCatalogue} from './material-closure-hardening-profile.ts';
export const IDENTITY_RUNTIME_PROFILE='identity-device-current-v1' as const;
export type IdentityRuntimeStatus={state:'verified';reason:string;profile:typeof IDENTITY_RUNTIME_PROFILE}|{state:'paused';reason:string};
export const IDENTITY_PAUSED:Readonly<IdentityRuntimeStatus>=Object.freeze({state:'paused',reason:'Identity access is paused until the complete supported Core identity profile is verified.'});
export async function verifyIdentityRuntime(client:pg.ClientBase):Promise<IdentityRuntimeStatus>{
 try{
  const history=await readSchemaHistory(client,'service');
  if(!schemaHistoryMatches(history)||history.length!==CORE_SCHEMA_UPGRADES.length+1)throw new Error();
  if(!IDENTITY_PLATFORM_PINS||identityHash(JSON.stringify(await captureIdentity(client)))!==(IDENTITY_HARDENING_PINS.at(-1)?.catalogue??IDENTITY_PLATFORM_PINS.catalogue))throw new Error();
  if((await verifyIdentity(client)).state!=='verified'||(await verifyMaterialClosureHardeningCatalogue(client)).state!=='verified')throw new Error();
  return {state:'verified',profile:IDENTITY_RUNTIME_PROFILE,reason:'The complete supported Core identity history and runtime profile are verified.'};
 }catch{return {...IDENTITY_PAUSED};}
}
