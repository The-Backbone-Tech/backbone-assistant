// Manual baseline probe, not a regression assertion. Run through no-leftovers/with-test-cluster.
// Prints paths and outcomes only, never bytes, connection strings or vault entries.
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {lstatSync,mkdtempSync,mkdirSync,readdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {buildBaseline,openPersonalDatabase} from '@backbone/core/db';
import {createHost,removeDataHome,hostClosed} from '../src/composition/host.ts';
import {claimCoreHome} from '../src/composition/home-kernel.ts';
import {plaintextKeys,Vault} from '../src/keys/vault.ts';
import {systemKeys} from '../src/system-keys/provider.ts';
import {MemoryKeyStore} from '../src/system-keys/fake.ts';

function snapshot(home:string):Record<string,string> {
 const out:Record<string,string>={};
 const walk=(relative:string)=>{
  const path=join(home,relative),s=lstatSync(path);
  out[relative||'.']=`${s.mode}:${s.isDirectory()?'directory':'file'}:${s.size}:${s.isFile()?createHash('sha256').update(readFileSync(path)).digest('hex'):''}`;
  if(s.isDirectory())for(const name of readdirSync(path).sort())walk(relative?`${relative}/${name}`:name);
 };
 walk('');return out;
}
const changed=(a:Record<string,string>,b:Record<string,string>)=>[...new Set([...Object.keys(a),...Object.keys(b)])].sort().filter(p=>a[p]!==b[p]);
const baseline=buildBaseline().sql;
const fixture=JSON.parse(readFileSync(new URL('./fixtures/material-guard-legacy.json',import.meta.url),'utf8'));
const legacy=fixture.sqlLines.join('\n')+'\n';
const main=new URL('../../surfaces/cli/src/main.ts',import.meta.url).pathname;
async function history(home:string,vault:Vault){
 const {port}=JSON.parse(readFileSync(join(home,'pg','cluster.json'),'utf8'));
 const passwords=await vault.passwords().read();
 const client=new pg.Client({host:'127.0.0.1',port,user:'postgres',password:passwords!.admin,database:'backbone',connectionTimeoutMillis:3000});
 try{await client.connect();return (await client.query('SELECT version,checksum FROM ops.schema_migrations ORDER BY version')).rows;}
 finally{await client.end();}
}
const scenarios=['vault','stamp','passwords','cluster','complete','missing-folders','pending'] as const;
for(const kind of ['plaintext','system'] as const)for(const stage of scenarios){
 if(process.env.F7_STAGE&&stage!==process.env.F7_STAGE)continue;
 const home=mkdtempSync(join(tmpdir(),'backbone-readonly-inventory-'));
 const store=new MemoryKeyStore(),keys=kind==='plaintext'?plaintextKeys():systemKeys(home,store);
 try{
  const vault=await Vault.open(home,keys);
  if(stage!=='vault')await claimCoreHome(home);
  if(stage==='passwords'){
   await vault.passwords().write({admin:'fake-admin',app:'fake-app',operator:'fake-operator'});
   mkdirSync(join(home,'pg'),{mode:0o700});writeFileSync(join(home,'pg','cluster.json'),'{"port":1}',{mode:0o600});
  }
  if(stage==='cluster'){
   const db=await openPersonalDatabase({dir:join(home,'pg'),baselineSql:baseline,passwords:vault.passwords()});await db.stopIfStarted();
  }
  let beforeHistory:unknown;
  if(['complete','missing-folders','pending'].includes(stage)){
   const h=createHost({home,keys,baselineSql:stage==='pending'?legacy:baseline});
   await h.call('projects.list',{});beforeHistory=await history(home,vault);h.close();await hostClosed(home);
  }
  if(stage==='missing-folders')for(const name of ['memory','threads'])rmSync(join(home,name),{recursive:true});
  Vault.forget(home);
  const before=snapshot(home),writes=store.writes;
  let host:ReturnType<typeof createHost>|undefined;
  const outcomes:Record<string,unknown>={};let afterHistory:unknown;
  try{
   host=createHost({home,keys,readOnly:true});
   outcomes.projects=(await host.call('projects.list',{})).length;
   outcomes.threads=(await host.call('threads.list',{})).length;
   outcomes.thread=(await host.call('threads.get',{id:'absent'})).ok;
   try{outcomes.now=!!(await host.call('work.now',{projectId:'absent'}));}
   catch{outcomes.now='absent project refused';}
   outcomes.backup=(await host.call('backup.inspect',{from:join(home,'absent-export')})).ok;
   outcomes.connectors=!!(await host.call('connectors.list',{}));
   const audit=await host.call('audit.export',{since:'2000-01-01T00:00:00Z',until:'2100-01-01T00:00:00Z',limit:1});
   outcomes.audit=audit.ok;
   if(audit.ok&&audit.value.session)await host.call('audit.export',{since:'2000-01-01T00:00:00Z',until:'2100-01-01T00:00:00Z',session:audit.value.session,cancel:true});
   afterHistory=await history(home,vault);
  }catch(e){outcomes.error=e instanceof Error?e.name:'unknown';}
  finally{host?.close();if(host)await hostClosed(home);}
  const after=snapshot(home),diff=changed(before,after);
  console.log(JSON.stringify({kind,stage,outcomes,beforeHistory,afterHistory,storeWrites:store.writes-writes,changed:diff}));
  if(kind==='plaintext'&&stage==='vault'){
   // A fresh vault for each command, independently of the Host probe's refusal.
   for(const args of [['doctor','--json'],['projects','list']]){
    const h=mkdtempSync(join(tmpdir(),'backbone-readonly-cli-inventory-'));
    try{
     await Vault.open(h,plaintextKeys());const a=snapshot(h);
     const child=spawnSync(process.execPath,[main,...args,'--home',h],{encoding:'utf8',timeout:60_000,env:{...process.env,BACKBONE_KEYS:'plaintext',BACKBONE_HARNESS:'stub'}});
     console.log(JSON.stringify({cli:args.join(' '),status:child.status,changed:changed(a,snapshot(h))}));
    }finally{await removeDataHome(h);}
   }
  }
 }finally{await removeDataHome(home);}
}
