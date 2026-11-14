import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstatSync,mkdirSync,readdirSync,readFileSync,readlinkSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {dirname,join,relative} from 'node:path';
import {test} from 'node:test';
import {requireCompleteHome,HomeIncomplete} from '../src/composition/home-complete.ts';
import {withHomeLock} from '../src/composition/home-lock.ts';
import {canonicalHome,doorSocket} from '../src/doors/protocol.ts';
import {createHost,hostClosed,removeDataHome} from '../src/composition/host.ts';
import {plaintextKeys} from '../src/keys/vault.ts';
import {systemKeys} from '../src/system-keys/provider.ts';
import {MemoryKeyStore} from '../src/system-keys/fake.ts';
import {freshDir,freshHome} from './helpers.ts';

// Complete metadata manifest, including directories; no timestamps or database exclusion.
function snapshot(home:string):Record<string,unknown>{
 const out:Record<string,unknown>={};
 const walk=(relative:string)=>{
  const path=join(home,relative),stat=lstatSync(path);
  out[relative]={mode:stat.mode,size:stat.size,kind:stat.isDirectory()?'directory':stat.isSymbolicLink()?'link':'file',
   hash:stat.isFile()?createHash('sha256').update(readFileSync(path)).digest('hex'):null,
   target:stat.isSymbolicLink()?readlinkSync(path):null};
  if(stat.isDirectory())for(const name of readdirSync(path).sort())walk(relative?`${relative}/${name}`:name);
 };
 walk('');return out;
}
function put(home:string,path:string,value='fixture'){
 mkdirSync(dirname(join(home,path)),{recursive:true,mode:0o700});writeFileSync(join(home,path),value,{mode:0o600});
}
async function complete(external=false){
 const home=freshDir('backbone-complete-');
 for(const path of ['kernel.json','core.json','keys/vault.json',...(external?['pg/external.json']:['pg/data/PG_VERSION','pg/cluster.json'])])put(home,path);
 for(const path of ['threads','memory/daily','memory/projects','memory/topics'])mkdirSync(join(home,path),{recursive:true,mode:0o700});
 if(relative(canonicalHome(home),dirname(doorSocket(home)))==='run')mkdirSync(join(home,'run'),{mode:0o700});
 for(const path of [home,join(home,'keys'),join(home,'pg')])await withHomeLock(path,async()=>{});
 return home;
}
function refused(home:string){
 const before=snapshot(home);let refusal:HomeIncomplete|undefined;
 assert.throws(()=>requireCompleteHome(home),(error:unknown)=>{
  assert.ok(error instanceof HomeIncomplete);refusal=error;
  assert.equal(error.code,'INCOMPLETE_HOME');return true;
 });
 assert.deepEqual(snapshot(home),before,'even a refusal must preserve every entry');
 return refusal!;
}

test('an absent path and an ordinary folder remain absent or unchanged',()=>{
 const parent=freshDir('backbone-unmade-'),home=join(parent,'absent'),before=snapshot(parent);
 assert.throws(()=>requireCompleteHome(home),HomeIncomplete);assert.deepEqual(snapshot(parent),before);
 const error=refused(parent);assert.ok(error.missing.includes('kernel.json'));assert.ok(error.missing.includes('keys/vault.json'));
});
test('vault-only and later interrupted artifact sets are refused without a write',()=>{
 const home=freshDir('backbone-interrupted-');
 for(const path of ['keys/vault.json','kernel.json','pg/cluster.json','pg/data/PG_VERSION','core.json']){
  put(home,path);const error=refused(home);
  assert.ok(error.missing.includes('threads'));assert.ok(error.missing.includes('memory'));
  assert.ok(!error.missing.includes(path));
 }
});
for(const external of [false,true])test(`finished structural fixtures are unchanged (external=${external})`,async()=>{
 const home=await complete(external),before=snapshot(home);
 assert.equal(requireCompleteHome(home),undefined);assert.deepEqual(snapshot(home),before);
});
test('each indispensable file and directory independently prevents a writable fallback',async()=>{
 for(const path of ['kernel.json','core.json','keys/vault.json','pg/data/PG_VERSION','pg/cluster.json','threads','memory/daily','memory/projects','memory/topics','memory']){
  const home=await complete();rmSync(join(home,path),{recursive:true});
  assert.ok(refused(home).missing.includes(path),path);
 }
});
test('missing persistent locks are inspected without taking or manufacturing a lock',async()=>{
 // Make artifacts, but obtain only two native locks. Never remove or plant a lock inode.
 const home=freshDir('backbone-missing-lock-');
 for(const path of ['kernel.json','core.json','keys/vault.json','pg/data/PG_VERSION','pg/cluster.json'])put(home,path);
 for(const path of ['threads','memory/daily','memory/projects','memory/topics'])mkdirSync(join(home,path),{recursive:true});
 if(relative(canonicalHome(home),dirname(doorSocket(home)))==='run')mkdirSync(join(home,'run'),{mode:0o700});
 await withHomeLock(join(home,'pg'),async()=>{});await withHomeLock(join(home,'keys'),async()=>{});
 assert.deepEqual(refused(home).missing,['.lock']);
});
test('empty files, directories used as files and linked metadata are unusable',async()=>{
 for(const kind of ['empty','directory','link']){
  const home=await complete(),path=join(home,'core.json');rmSync(path);
  if(kind==='empty')writeFileSync(path,'');
  else if(kind==='directory')mkdirSync(path);
  else symlinkSync(join(home,'kernel.json'),path);
  assert.ok(refused(home).missing.includes('core.json'));
 }
});
test('a linked artifact parent is not followed',async()=>{
 const home=await complete(),target=join(home,'original-pg');
 // Preserve native lock files by renaming their containing directory, without touching them.
 const {renameSync}=await import('node:fs');renameSync(join(home,'pg'),target);symlinkSync(target,join(home,'pg'));
 const before=snapshot(home);const error=refused(home);
 assert.ok(error.missing.includes('pg/data/PG_VERSION'));assert.deepEqual(snapshot(home),before);
});
test('the refusal names only relative artifacts and a shell-safe command for the same home',()=>{
 const parent=freshDir('backbone-message-'),home=join(parent,"home's $cash `literal`");mkdirSync(home);
 put(home,'keys/vault.json','SECRET_CANARY_DO_NOT_PRINT');const error=refused(home);
 assert.ok(error.message.includes('kernel.json'));assert.ok(error.message.includes('pg/data/PG_VERSION'));
 assert.ok(error.message.includes(`backbone projects create "My project" --home '${home.replaceAll("'","'\"'\"'")}'`));
 assert.ok(!error.message.includes('SECRET_CANARY_DO_NOT_PRINT'));assert.ok(Object.isFrozen(error.missing));
});
for(const kind of ['external','native-plaintext','native-system'])test(`a finished real writable Host leaves every preflight artifact (${kind})`,async()=>{
 const home=kind==='external'?freshHome():freshDir('backbone-completed-host-');
 const keys=kind==='native-system'?systemKeys(home,new MemoryKeyStore()):plaintextKeys();
 const host=createHost({home,keys});
 try{await host.call('projects.list',{});}finally{host.close();await hostClosed(home);}
 try{const before=snapshot(home);requireCompleteHome(home);assert.deepEqual(snapshot(home),before);}
 finally{if(kind!=='external')await removeDataHome(home);}
});
