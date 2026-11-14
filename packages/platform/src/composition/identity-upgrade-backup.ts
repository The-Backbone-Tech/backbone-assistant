import {identityBackupFingerprint} from './identity-backup-fingerprint.ts';
import {writeDurable} from '@backbone-next/kernel/files';
// The same portable export as Settings > Backup, before any identity DDL.
import {randomUUID} from 'node:crypto';
import {appendFileSync,existsSync,mkdirSync,readdirSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {serviceClient,enter,type PersonalDatabase} from '@backbone/core/db';
import type {Vault} from '../keys/vault.ts';
import {CredentialStore} from '../credentials/store.ts';
import {macosKeychain} from '../credentials/keychain.ts';
import {MaterialStore} from '../stub/material.ts';
import {readJson} from '../stub/fsx.ts';
import type {StoredThread} from './thread-journal.ts';
import {exportHome,inspectExport,type ExportSource} from './backup.ts';
import {assertHomeWriteAdmission,withHomeLock} from './home-lock.ts';

/** Only structured startup state reaches the native notice, never an exception's text. */
export function identityUpgradeNotice(result:PersonalDatabase['identityUpgrade']):string|undefined{
 if(!result)return undefined;
 const reason=result.reason+(result.backup&&!result.reason.includes(result.backup)?` A copy of your data from before the update is at ${result.backup}.`:'');
 return reason+(result.backup?' To recover this export separately, use backbone restore with this copy and a new, empty data folder; preview with --dry-run first. Chats return as history. Schedules and permissions are excluded; keep the original data folder.':'');
}
export function recordIdentityUpgrade(home:string,record:{state:string;backup?:string;reason?:string}):void{
 const dir=join(home,'logs');assertHomeWriteAdmission(home,dir);mkdirSync(dir,{recursive:true,mode:0o700});
 assertHomeWriteAdmission(home,dir);appendFileSync(join(dir,'identity-upgrade.jsonl'),JSON.stringify({at:new Date().toISOString(),...record})+'\n',{mode:0o600});
 const descriptor=openSync(join(dir,'identity-upgrade.jsonl'),'r');try{fsyncSync(descriptor);}finally{closeSync(descriptor);}
}
export async function backupBeforeIdentityUpgrade(source:ExportSource):Promise<string>{
 return withHomeLock(source.home,async()=>{
  const root=join(source.home,'backups');assertHomeWriteAdmission(source.home,root);mkdirSync(root,{recursive:true,mode:0o700});
  const receipts=await source.receipts(),known=[...await source.secrets()].sort();
  const fingerprint=identityBackupFingerprint(source.home,{receipts,known});
  const marker=join(source.home,'logs','team-recovery-copy.json');
  const prior=readJson<{fingerprint:string;copy:string}|null>(marker,null);
  if(prior?.fingerprint===fingerprint&&prior.copy.startsWith(root+'/before-team-')){
   try{inspectExport(prior.copy);return prior.copy;}catch{/* A missing or damaged copy must be replaced. */}
  }
  const to=join(root,`before-team-${randomUUID()}`);
  assertHomeWriteAdmission(source.home,root);
  await exportHome({...source,receipts:async()=>receipts,secrets:async()=>known},{to,identityUpgrade:true});
  inspectExport(to); // A completed and readable copy, never a partial export, admits DDL.
  recordIdentityUpgrade(source.home,{state:'backup-ready',backup:to});
  assertHomeWriteAdmission(source.home,join(source.home,'logs'));
  writeDurable(marker,JSON.stringify({fingerprint,copy:to})+'\n',0o600);
  return to;
 });
}
export async function backupExistingIdentityHome(home:string,appUrl:string,vault:Vault,keychainRoutes=false):Promise<string>{
 const id=readJson<{workspace:string;person:string}>(join(home,'core.json'),null as never);
 if(!id?.workspace||!id.person)throw new Error('The existing data folder has no device identity.');
 const client=await serviceClient(appUrl);
 let receipts:Awaited<ReturnType<ExportSource['receipts']>>;
 try{
  await enter(client,{workspace:id.workspace,principal:id.person});
  receipts=(await client.query<{id:string;status:string;operation:string;description:string|null;created_at:string}>('SELECT id::text AS id,status,operation,description,created_at FROM app.effects ORDER BY created_at,id')).rows;
 }finally{await client.end();}
 return withHomeLock(home,async()=>{
 const material=new MaterialStore(home,{},()=>{},()=>null,false);
 const credentials=new CredentialStore(home,()=>vault.masterKey(),keychainRoutes?macosKeychain():undefined);
 return backupBeforeIdentityUpgrade({home,
  projects:readJson(join(home,'projects.json'),[]),documents:project=>material.list(project,true),
  versionPath:(id,version)=>join(home,'material',id,'versions',String(version)),
  threads:existsSync(join(home,'threads'))?readdirSync(join(home,'threads')).filter(name=>name.endsWith('.json')).map(name=>readJson<StoredThread>(join(home,'threads',name),null as never)):[],
  receipts:async()=>receipts,secrets:()=>credentials.values(),
 });
 });
}
