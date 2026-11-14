import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,chmodSync,rmSync,readFileSync,utimesSync,cpSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {dirname,join} from 'node:path';
import {test} from 'node:test';
import {freshDir,freshHome,value} from './helpers.ts';
import {createHost,hostClosed} from '../src/composition/host.ts';
import {CoreLink} from '../src/composition/core.ts';
import {inActiveHomeLockScope,withHomeLock} from '../src/composition/home-lock.ts';
import {homeState,assertHomeState,logicalState} from './readonly-home-state.ts';
import {nativeHome,rawServer} from './readonly-native-fixtures.ts';

for(const path of ['core.json','kernel.json','keys/vault.json','pg/cluster.json','pg/data/PG_VERSION','pg/data/postgresql.conf','pg/data/postgresql.auto.conf','pg/data/pg_hba.conf','pg/data/pg_ident.conf','pg/data/base-neighbor/document','threads/conversation.json'])test(`pinning rejects content, mode, appearance and deletion at ${path}`,()=>{
 const home=freshDir('f7-boundary-'),at=join(home,path);mkdirSync(dirname(at),{recursive:true});writeFileSync(at,'original',{mode:0o600});
 const before=homeState(home);writeFileSync(at,'changed');assert.throws(()=>assertHomeState(before,homeState(home),true));
 writeFileSync(at,'original');chmodSync(at,0o644);assert.throws(()=>assertHomeState(before,homeState(home),true));
 chmodSync(at,0o600);rmSync(at);assert.throws(()=>assertHomeState(before,homeState(home),true));
 const absent=homeState(home);writeFileSync(at,'original');assert.throws(()=>assertHomeState(absent,homeState(home),true));
});
test('the pg/data directory exception permits only size and keeps its mode pinned',()=>{
 const home=freshDir('f7-directory-boundary-');mkdirSync(join(home,'pg','data'),{recursive:true,mode:0o700});
 const before=homeState(home);writeFileSync(join(home,'pg','data','postmaster.pid'),'synthetic runtime identity');
 assertHomeState(before,homeState(home),true);
 chmodSync(join(home,'pg','data'),0o755);assert.throws(()=>assertHomeState(before,homeState(home),true));
});
test('the logical pin detects personal-data changes inside physically permitted PostgreSQL pages',async t=>{
 const f=await nativeHome(t,'plaintext','complete',true),server=await rawServer(t,f.home,f.vault),before=await logicalState(server.client);
 await server.client.query("UPDATE app.tasks SET title=title||' changed by the synthetic adverse control'");
 const after=await logicalState(server.client);assert.notEqual(after.data['app.tasks'],before.data['app.tasks']);
 assert.deepEqual(after.history,before.history);assert.equal(after.schema,before.schema);assert.equal(after.roles,before.roles);
});
test('Git file and changes reads leave a stale index byte-identical',async()=>{
 const home=freshHome(),writer=createHost({home});let projectId:string;
 try{projectId=value(await writer.call('projects.create',{name:'Git read fixture',kind:'git'})).id;}
 finally{writer.close();await hostClosed(home);}
 const stored=JSON.parse(readFileSync(join(home,'projects.json'),'utf8')).find((p:{id:string})=>p.id===projectId),cwd=join(home,'projects',stored.dir),path=join(cwd,'tracked.txt');
 writeFileSync(path,'same content\n');execFileSync('git',['add','tracked.txt'],{cwd});
 execFileSync('git',['-c','core.hooksPath=/dev/null','-c','user.name=F7 fixture','-c','user.email=fixture@localhost','commit','-qm','Synthetic fixture'],{cwd});
 const later=new Date(Date.now()+5000);utimesSync(path,later,later);
 const before=homeState(home),reader=createHost({home,readOnly:true});
 try{
  await reader.call('files.list',{projectId});assertHomeState(before,homeState(home));
  assert.equal((await reader.call('changes.get',{projectId,scope:'uncommitted'})).ok,true);
 }
 finally{reader.close();await hostClosed(home);}
 assertHomeState(before,homeState(home));
});
test('plain-file export finishes its Core receipt crossing before taking the home lock',async t=>{
 const f=await nativeHome(t),before=homeState(f.home),reader=createHost({home:f.home,keys:f.keys,readOnly:true});
 let crossings=0;const original=CoreLink.prototype.read;
 t.mock.method(CoreLink.prototype,'read',function(this:CoreLink,...args:Parameters<typeof original>){
  assert.equal(inActiveHomeLockScope(f.home),false,'Core crossing under the home lock');crossings++;return Reflect.apply(original,this,args);
 });
 try{assert.equal((await reader.call('backup.export',{to:join(freshDir('f7-export-'),'out')})).ok,true);assert.ok(crossings>0);}
 finally{reader.close();await hostClosed(f.home);}
 assertHomeState(before,homeState(f.home),true);
});
test('an older installed home needs neither keys/pg lock files nor an in-home reader socket',async()=>{
 const original=freshHome(),writer=createHost({home:original});
 try{await writer.call('projects.list',{});}finally{writer.close();await hostClosed(original);}
 const home=join(freshDir('f7-legacy-layout-'),'home');
 // Copy only disposable data/metadata, never native lock inodes. Obtain the sole lock the
 // reader needs through its API; old installed homes already have their Core identity.
 cpSync(original,home,{recursive:true,filter:path=>!path.endsWith('/.lock')&&!path.endsWith('/run')});
 await withHomeLock(home,async()=>{});
 assert.equal(existsSync(join(home,'keys','.lock')),false);assert.equal(existsSync(join(home,'pg','.lock')),false);
 const before=homeState(home),reader=createHost({home,readOnly:true});
 try{assert.deepEqual(await reader.call('projects.list',{}),[]);}finally{reader.close();await hostClosed(home);}
 assertHomeState(before,homeState(home));
});
