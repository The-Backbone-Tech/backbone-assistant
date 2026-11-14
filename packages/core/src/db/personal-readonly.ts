// Opening a reader verifies the current supported profile; it never repairs an older one.
import {existsSync,readFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import pg from 'pg';
import type {PasswordKeeper,ClusterPasswords} from './personal.ts';
import {CORE_SCHEMA_UPGRADES,readSchemaHistory,schemaHistoryMatches} from './schema-migrations.ts';
import {verifyMaterialStatuses} from './material-status.ts';
import {verifySignatureLedger} from './signature-ledger.ts';

// Read-only admission recognizes the frozen bootstrap and the two released upgrade fixtures.
// Writable installers retain their historical format-only rule; none of these receipts alone
// grants a capability. Exact current step history and catalogue verification remain mandatory.
const READ_BASELINES = new Set([
 'bfd246fcc4bd352ea9bb61114e827a20cae79c8b6bcc6359cef91965b0d8d21c', // schema/baseline.json bodyChecksum
 '577fb329991be04ce409785ae92068a6aa3385c87636e67060ae08c0e713033b', // released pre-guard bootstrap
 '484993358dfddc7a33c33b271db2ecd3aae3ecf515c7e98f024f7d1b68d1ccc8', // released 70c6d0e bootstrap
]);

export class PersonalReadRefusal extends Error {
 readonly code:'missing-cluster'|'password-metadata'|'needs-upgrade'|'schema-unverified'|'server-identity'|'connection-options';
 constructor(code:PersonalReadRefusal['code'],message:string){super(message);this.name='PersonalReadRefusal';this.code=code;}
}
export async function readExistingPasswords(dir:string,keeper:PasswordKeeper|undefined):Promise<{passwords:ClusterPasswords;port:number}>{
 if(!existsSync(join(dir,'data','PG_VERSION')))throw new PersonalReadRefusal('missing-cluster','This home has no existing PostgreSQL cluster; complete its first run with a writable open.');
 if(existsSync(join(dir,'secrets.json')))throw new PersonalReadRefusal('needs-upgrade','This home needs a writable open to migrate legacy password metadata.');
 if(!keeper||!existsSync(join(dir,'cluster.json')))throw new PersonalReadRefusal('password-metadata','This home is missing its cluster password or port metadata; complete it with a writable open.');
 try{
  const passwords=await keeper.read(),{port}=JSON.parse(readFileSync(join(dir,'cluster.json'),'utf8'));
  if(!passwords||!['admin','app','operator'].every(k=>typeof passwords[k as keyof ClusterPasswords]==='string'&&passwords[k as keyof ClusterPasswords].length>0)||!Number.isSafeInteger(port)||port<1||port>65535)throw new Error('metadata');
  return {passwords,port};
 }catch{throw new PersonalReadRefusal('password-metadata','This home is missing valid cluster password or port metadata; complete it with a writable open.');}
}
export async function verifyReadOnlyDatabase(client:pg.Client,owned=false){
 try{
  await client.query('BEGIN READ ONLY');
  const history=await readSchemaHistory(client,owned?'owned-read':'service');
  if(!schemaHistoryMatches(history)||!READ_BASELINES.has(history[0].checksum))throw new PersonalReadRefusal('schema-unverified','This home has unknown or changed installed history; a read-only open cannot repair it.');
  if(history.length!==CORE_SCHEMA_UPGRADES.length+1)throw new PersonalReadRefusal('needs-upgrade','This home needs a writable open to upgrade.');
  const statuses=await verifyMaterialStatuses(client),signature=await verifySignatureLedger(client);
  if([statuses.materialGuard,statuses.materialLink,statuses.materialEnforcement,signature].some(s=>s.state!=='verified'))throw new PersonalReadRefusal('schema-unverified','This home has an unverified schema or role profile; a read-only open cannot repair it.');
  return statuses;
 }catch(error){
  if(error instanceof PersonalReadRefusal)throw error;
  throw new PersonalReadRefusal('schema-unverified','This home could not verify its installed history and schema for a read-only open.');
 }finally{await client.query('ROLLBACK').catch(()=>{});}
}
/** Authentication at a port is insufficient: a copied password must not select another home. */
export async function matchingPersonalServer(url:string,data:string,client=new pg.Client({connectionString:url,connectionTimeoutMillis:1000})):Promise<boolean>{
 try{
  try{await client.connect();}catch(error){if(error instanceof PersonalReadRefusal)throw error;return false;}
  const actual=(await client.query('SHOW data_directory')).rows[0]?.data_directory;
  if(typeof actual!=='string'||realpathSync(actual)!==realpathSync(data))throw new Error('different cluster');
  return true;
 }catch(error){if(error instanceof PersonalReadRefusal)throw error;throw new PersonalReadRefusal('server-identity','The responding PostgreSQL server does not match this home; nothing was opened.');}
 finally{await client.end().catch(()=>{});}
}
export function refuseLivePersonalPid(data:string):void {
 const path=join(data,'postmaster.pid');if(!existsSync(path))return;
 const pid=Number(readFileSync(path,'utf8').split('\n')[0]);
 if(!Number.isSafeInteger(pid)||pid<1)throw new PersonalReadRefusal('server-identity','This home has invalid pg/data/postmaster.pid metadata; confirm that its server is stopped before retrying.');
 try{process.kill(pid,0);}
 // PostgreSQL treats an inaccessible foreign process like a dead PID. Leave its
 // stale file intact so the server, not this client, adjudicates recovery.
 catch(error){if(['ESRCH','EPERM'].includes((error as NodeJS.ErrnoException).code??''))return;}
 throw new PersonalReadRefusal('server-identity','This home names a live PostgreSQL process that could not be authenticated; pg/data/postmaster.pid was preserved and no server was started. Confirm that the home server is stopped before retrying.');
}
