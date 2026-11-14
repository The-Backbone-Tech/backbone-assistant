import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,readdirSync,readFileSync,readlinkSync} from 'node:fs';
import {join} from 'node:path';
import type pg from 'pg';

// Starting or recovering PostgreSQL can change physical data and global pages (WAL recovery,
// hint bits, checkpoints, autovacuum) as well as the pid, WAL and control files. NEVER promise
// byte identity of base/ from a live server. Logical state is pinned separately by queries.
export const POSTGRES_RUNTIME = [
 ['pg/data/base', 'relation pages, hint bits and relation cache'],
 ['pg/data/global', 'shared relation pages, control file and shared cache'],
 ['pg/data/pg_wal', 'WAL records and segment rotation'],
 ['pg/data/pg_xact', 'transaction commit status'],
 ['pg/data/pg_subtrans', 'subtransaction status rebuilt during native recovery'],
 ['pg/data/pg_stat', 'server statistics'],
] as const;
const runtimeFiles = ['pg/data/postmaster.pid','pg/data/postmaster.opts']; // Process identity and launch arguments.
const runtimeDirectoryEntries = ['pg/data']; // Size only: stale pid removal changes the directory's entry count during recovery.
export function homeState(home:string):Record<string,unknown>{
 const out:Record<string,unknown>={};if(!existsSync(home))return out;
 const walk=(relative:string)=>{
  const path=join(home,relative),s=lstatSync(path);
  out[relative||'.']={mode:s.mode,size:s.size,kind:s.isDirectory()?'directory':s.isSymbolicLink()?'link':'file',
   hash:s.isFile()?createHash('sha256').update(readFileSync(path)).digest('hex'):null,
   target:s.isSymbolicLink()?readlinkSync(path):null};
  if(s.isDirectory())for(const name of readdirSync(path).sort())walk(relative?`${relative}/${name}`:name);
 };walk('');return out;
}
export function assertHomeState(before:ReturnType<typeof homeState>,after:ReturnType<typeof homeState>,postgres=false){
 const changes=[...new Set([...Object.keys(before),...Object.keys(after)])].sort().filter(p=>JSON.stringify(before[p])!==JSON.stringify(after[p]));
 const directorySizeOnly=(p:string)=>{
  if(!runtimeDirectoryEntries.includes(p)||!before[p]||!after[p])return false;
  const {size:oldSize,...oldFixed}=before[p] as Record<string,unknown>,{size:newSize,...newFixed}=after[p] as Record<string,unknown>;
  return oldFixed.kind==='directory'&&newFixed.kind==='directory'&&JSON.stringify(oldFixed)===JSON.stringify(newFixed);
 };
 const refused=changes.filter(p=>!postgres||(!directorySizeOnly(p)&&!runtimeFiles.includes(p)&&!POSTGRES_RUNTIME.some(([root])=>p===root||p.startsWith(root+'/'))));
 assert.deepEqual(refused,[],'unexpected home mutations');return changes;
}
/** Hash fixture records before asserting, so a failure never dumps credential verifiers. */
export async function logicalState(client:pg.Client){
 const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  const tables=(await client.query(`SELECT quote_ident(n.nspname)||'.'||quote_ident(c.relname) AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE c.relkind IN ('r','p','S') AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema' ORDER BY 1`)).rows;
  const data:Record<string,string>={};for(const {name} of tables)data[name]=hash((await client.query(`SELECT to_jsonb(t) AS row FROM ${name} t ORDER BY to_jsonb(t)::text`)).rows);
  const schema=[];
  for(const sql of [
   `SELECT nspname,nspowner,nspacl FROM pg_namespace WHERE nspname !~ '^pg_' ORDER BY nspname`,
   `SELECT n.nspname,c.relname,c.relkind,c.relpersistence,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity,c.relreplident FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' ORDER BY 1,2`,
   `SELECT a.attrelid,a.attname,a.attnum,a.atttypid,a.atttypmod,a.attnotnull,a.attidentity,a.attgenerated,a.attcollation,pg_get_expr(d.adbin,d.adrelid) AS default FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE n.nspname !~ '^pg_' ORDER BY 1,3`,
   `SELECT p.oid,pg_get_functiondef(p.oid) AS definition,p.proacl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname !~ '^pg_' AND p.prokind IN ('f','p') ORDER BY p.oid`,
   `SELECT c.oid,pg_get_constraintdef(c.oid) AS definition,c.convalidated FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname !~ '^pg_' ORDER BY c.oid`,
   `SELECT i.indexrelid,pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' ORDER BY i.indexrelid`,
   `SELECT t.oid,pg_get_triggerdef(t.oid) AS definition,t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' ORDER BY t.oid`,
   `SELECT r.oid,pg_get_ruledef(r.oid) AS definition FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' ORDER BY r.oid`,
   `SELECT * FROM pg_policy ORDER BY oid`,
   `SELECT to_jsonb(t) AS definition FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname !~ '^pg_' ORDER BY t.oid`,
   `SELECT * FROM pg_enum ORDER BY enumtypid,enumsortorder`,
   `SELECT * FROM pg_range ORDER BY rngtypid`,
   `SELECT * FROM pg_depend ORDER BY classid,objid,objsubid,refclassid,refobjid,refobjsubid,deptype`,
  ])schema.push((await client.query(sql)).rows);
  const roles=[];for(const sql of ['SELECT * FROM pg_authid ORDER BY oid','SELECT * FROM pg_auth_members ORDER BY roleid,member,grantor','SELECT * FROM pg_db_role_setting ORDER BY setdatabase,setrole','SELECT datname,datdba,encoding,datcollate,datctype,datacl FROM pg_database ORDER BY datname'])roles.push((await client.query(sql)).rows);
  return {data,schema:hash(schema),roles:hash(roles),history:(await client.query('SELECT version,checksum FROM ops.schema_migrations ORDER BY version')).rows};
 }finally{await client.query('ROLLBACK');}
}
