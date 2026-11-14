import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {TestContext} from 'node:test';
import pg from 'pg';
import {buildBaseline,openPersonalDatabase} from '@backbone/core/db';
import {binaries,ready} from '@backbone-next/kernel/cluster';
import {createHost,hostClosed,removeDataHome} from '../src/composition/host.ts';
import {CoreLink} from '../src/composition/core.ts';
import {claimCoreHome} from '../src/composition/home-kernel.ts';
import {Vault,plaintextKeys} from '../src/keys/vault.ts';
import {systemKeys} from '../src/system-keys/provider.ts';
import {MemoryKeyStore} from '../src/system-keys/fake.ts';
import {freshDir,idle,settings,value} from './helpers.ts';
export const baseline=buildBaseline().sql;
const fixture=JSON.parse(readFileSync(new URL('./fixtures/material-guard-legacy.json',import.meta.url),'utf8'));
export const legacy=fixture.sqlLines.join('\n')+'\n';
assert.equal(createHash('sha256').update(legacy).digest('hex'),fixture.sqlSha256);
const releasedFixture=JSON.parse(readFileSync(new URL('./fixtures/material-enforcement-release-70c6d0e.json',import.meta.url),'utf8'));
const released=releasedFixture.sqlLines.join('\n')+'\n';
assert.equal(createHash('sha256').update(released).digest('hex'),releasedFixture.sqlSha256);
export async function nativeHome(t:TestContext,kind='plaintext',stage='complete',seed=false){
 const home=freshDir('f7-native-'),store=new MemoryKeyStore(),keys=kind==='system'?systemKeys(home,store):plaintextKeys();
 t.after(()=>removeDataHome(home));
 const vault=await Vault.open(home,keys);let projectId='absent',threadId='absent';
 if(stage!=='vault')await claimCoreHome(home);
 if(stage==='passwords'){
  await vault.passwords().write({admin:'fake-admin',app:'fake-app',operator:'fake-operator'});
  mkdirSync(join(home,'pg'),{mode:0o700});writeFileSync(join(home,'pg','cluster.json'),'{"port":1}',{mode:0o600});
 }
 if(stage==='cluster'){
  const db=await openPersonalDatabase({dir:join(home,'pg'),baselineSql:baseline,passwords:vault.passwords()});await db.stopIfStarted();
 }
 if(stage==='identity'){const link=await CoreLink.open({home,keys});await link.close();}
 if(stage==='complete'||stage==='pending'||stage==='release-pending'){
  const host=createHost({home,keys,harness:'harness-stub',baselineSql:stage==='pending'?legacy:stage==='release-pending'?released:baseline});
  try{
   await host.call('projects.list',{});
   if(seed){projectId=value(await host.call('projects.create',{name:'Synthetic F7 project',kind:'folder'})).id;
    const sent=value(await host.call('turns.send',{projectId,text:'Hello from the synthetic read fixture',settings,attachments:[],clientKey:'f7-seed'}));threadId=sent.threadId;await idle(host,threadId);}
  }finally{host.close();await hostClosed(home);}
 }
 Vault.forget(home);return {home,keys,store,vault,projectId,threadId};
}
export async function rawServer(t:TestContext,home:string,vault:Vault){
 const {port}=JSON.parse(readFileSync(join(home,'pg','cluster.json'),'utf8'));
 const passwords=(await vault.passwords().read())!;
 let log='';const child=spawn(binaries().postgres,['-D',join(home,'pg','data'),'-p',String(port),'-c','listen_addresses=127.0.0.1','-c','unix_socket_directories=','-c','log_parameter_max_length=0','-c','log_parameter_max_length_on_error=0'],{stdio:['ignore','ignore','pipe']});
 child.stderr.on('data',chunk=>{log=(log+String(chunk)).slice(-4000);});
 const stop=async()=>{if(child.exitCode!==null||child.signalCode!==null)return;child.kill('SIGINT');await new Promise<void>(resolve=>child.once('exit',()=>resolve()));};
 t.after(stop);
 const url=`postgres://postgres:${passwords.admin}@127.0.0.1:${port}/backbone`;
 try{await ready(url,child,()=>log);}catch(error){await stop();throw error;}
 const client=new pg.Client({connectionString:url});await client.connect();t.after(()=>client.end().catch(()=>{}));
 client.on('error',()=>{});
 return {client,child,stop};
}
