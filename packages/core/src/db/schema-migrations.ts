// Dependency order and receipts for reviewed schema steps. This is metadata, never a second SQL
// source or proof that a step is installed: each capability verifies its own catalogue definitions.
import type pg from 'pg';

/** Shared by baseline installation and every owned upgrade, in the target database. */
export const CORE_SCHEMA_LOCK='SELECT pg_advisory_xact_lock(1111573323, 2)';
export const CORE_SCHEMA_UPGRADES:readonly Readonly<{version:string;checksum:string}>[]=Object.freeze([
  Object.freeze({
    version:'material-source-guard-v1',
    checksum:'aa19fe4ce8779ed4040f50b4a225cfb6e73d71b25787ab3f34aaae23f881cab7',
  }),
  Object.freeze({version:'material-source-link-v1',checksum:'26815c949303419f35ec3acbda282c9a875c73202336b46a0ff157c7c192d206'}),
  Object.freeze({version:'material-source-enforcement-v1',checksum:'7de82aa384da2c39b851b5a311fa8b7ead8be0eace69c00ed816248326e928bb'}),
  Object.freeze({version:'connector-signature-ledger-v1',checksum:'e9b5b046d2dc27fe384e86767d7528e1d55e36596d921fdfcb312fdba9576bfe'}),
  Object.freeze({version:'material-closure-foundation-v1',checksum:'e42bc9100005e2949ce5c6da5f535a59de8ef307766b532e2ec2f5c568fa866c'}),
  Object.freeze({version:'material-closure-hardening-v1',checksum:'548a57924dc80927f133099f40686f516ec2a230cd8e60e1d80bb753a520bdbf'}),
  Object.freeze({version:'identity-v1',checksum:'440407bc2d22618997345e90c2a8cb097e813b7b5277c95694d31fdef878aaf8'}),
  Object.freeze({version:'identity-work-v1',checksum:'156aec912cfbcb3c284f74b0ccb4ec1a4042deb98520b51b9c3741994dcafdcb'}),
  Object.freeze({version:'identity-role-revocation-v1',checksum:'dea22dcf9451a86a26d8d70754349b27d749fbfee6d4a45a72396539d375253b'}),
  Object.freeze({version:'identity-resource-guard-v1',checksum:'d7e02c5a5d9b523b08513f4ed65988281ef17dfeceb0da0541109e686cfa41d6'}),
  Object.freeze({version:'identity-admission-closure-v1',checksum:'f86719e28916af64016ca46001e361a73a55c20fe95721dc5a6e5e640c1cb22a'}),
  Object.freeze({version:'identity-guarantees-v1',checksum:'751dfd673947b6a9cb172cda98c6313605937c01200d2831971eab7884f2e752'}),
  Object.freeze({version:'identity-platform-v1',checksum:'bf4ef7e9d340c4de213e08a93d6413c090b4e298b7aae2a1ef3e3799ca9d539f'}),
  Object.freeze({version:'identity-role-closure-v1',checksum:'51bdb53e46134eb9ea7fec6156be8b3b5d34fe35b9132edc66c8097241c2f5fd'}),
  Object.freeze({version:'identity-piece-admission-v1',checksum:'f9f2531ed0f1fe26f1305922b4bb6873515d3c09fd9a3092a8934c35ac1d0630'}),
  Object.freeze({version:'identity-lookup-closure-v1',checksum:'39e3d61b7f95ae3cb4d4ec638846b3a6d3062b58850a77a085f6d7e1c3a9612e'}),
  Object.freeze({version:'identity-invitation-closure-v1',checksum:'ad645206d7b21ce7cdc9c9c6eae1912a5c491e5b711172546fc2a6245b94b637'}),
  Object.freeze({version:'identity-device-recovery-v1',checksum:'51ac3dd57a023a7d3af0e0fb412d6c4933c4ba857df62eeffa64e5f731900f72'}),
  Object.freeze({version:'identity-device-lockout-v1',checksum:'6a2214638918e8ae7b80a6c2805359d8a785320bdd8fade086ec16faed8c49e3'}),
  Object.freeze({version:'identity-device-subject-v1',checksum:'96bdcbac3eeb00107c02fdca46fa347c06599d7340dc0b709090fb25a558b89f'}),
  Object.freeze({version:'identity-native-turn-v1',checksum:'fab111a5f958290f3617600bbe8801125fa190eb8b007a5457b0e562f949aedd'}),
  Object.freeze({version:'identity-device-current-v1',checksum:'fe38f389b4217616f81cc7ac47c1f4aab82643a8d419344b6b4639c72b1cf88a'}),
]);
export interface SchemaHistoryRow { version:string;checksum:string }
const versions=Object.freeze(['baseline',...CORE_SCHEMA_UPGRADES.map(step=>step.version)]);

/** Rows are read in declared dependency order. A baseline digest alone grants no capability; it
 * is only shape-checked because different baselines can share the same reviewed object family. */
export function schemaHistoryMatches(history:readonly SchemaHistoryRow[]):boolean {
  if(!history.length || history.length>CORE_SCHEMA_UPGRADES.length+1 ||
      history[0].version!=='baseline' || !/^[a-f0-9]{64}$/.test(history[0].checksum))return false;
  return history.slice(1).every((row,index)=>
    row.version===CORE_SCHEMA_UPGRADES[index].version && row.checksum===CORE_SCHEMA_UPGRADES[index].checksum);
}

/** The service sees only the pinned narrow view. The installer locks the owning rows. Ordering
 * comes from the compiled manifest, not alphabetical names or a wall clock that can move back. */
export async function readSchemaHistory(client:pg.ClientBase,scope:'service'|'installer'|'owned-read'):Promise<SchemaHistoryRow[]> {
  const table=scope==='service'?'app.material_guard_history':'ops.schema_migrations';
  return(await client.query<SchemaHistoryRow>(`SELECT version,checksum FROM ${table}
    ORDER BY pg_catalog.array_position($1::text[],version),version${scope==='installer'?' FOR UPDATE':''}`,[versions])).rows;
}

/** A single per-object block of the shipped baseline. The caller pins the selected statement
 * hashes and whole step; no schema-folder read or caller-selected DDL is introduced here. */
export function baselineObject(baseline:string,file:string):string|null {
  const source=baseline.replace(/\r\n/g,'\n');
  const marker=`\n\n-- ${file}\n\n`;
  const start=source.indexOf(marker);
  if(start<0 || source.indexOf(marker,start+marker.length)!==-1)return null;
  const from=start+marker.length;
  const ends=['\n\n-- ','\n\nRESET ROLE;','\n\nSET ROLE '].map(end=>source.indexOf(end,from)).filter(end=>end>=0);
  return source.slice(from,Math.min(...ends)).trim();
}
