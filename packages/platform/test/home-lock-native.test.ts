import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
// Public-wrapper controls: a process pause is not death, and a persistent file is not ownership.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,statSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after,test,type TestContext} from 'node:test';
import {fileURLToPath} from 'node:url';
import {outsideHomeLocks,withHomeLock} from '../src/composition/home-lock.ts';
import {Vault,type HomeKeys} from '../src/keys/vault.ts';

const homes:string[]=[];
after(()=>{for(const path of homes)rmSync(path,{recursive:true,force:true});});
function home(){
 const path=mkdtempSync(join(tmpdir(),'native-home-owner-'));
 homes.push(path);return path;
}
function holder(t:TestContext,path:string,mode:'hold'|'snapshot'){
 const child=spawn(process.execPath,[fileURLToPath(new URL('./home-lock-native-holder.ts',import.meta.url)),path,mode],{stdio:['pipe','pipe','inherit']});
 const exited=once(child,'exit');let output='';
 const held=new Promise<void>((resolve,reject)=>{
  child.stdout.on('data',(data:Buffer)=>{output+=data.toString();if(output.includes('held\n'))resolve();});
  void exited.then(()=>{if(!output.includes('held\n'))reject(new Error('The controlled child exited before holding the lock.'));},reject);
 });
 t.after(async()=>{
  if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
  await exited;
 });
 return {child,held,exited};
}

test('a paused owner keeps its snapshot exclusive beyond the former stale interval',{timeout: TEST_HANG_MS * 2},async t=>{
 const path=home();writeFileSync(join(path,'state.json'),JSON.stringify({value:0,writer:'initial'}));
 const owner=holder(t,path,'snapshot');await owner.held;assert.equal(owner.child.kill('SIGSTOP'),true);
 let entered=false,refusal:unknown,beforeResume:unknown;
 try{
  await new Promise<void>(resolve=>setTimeout(resolve,6_200));
  refusal=await withHomeLock(path,async()=>{entered=true;writeFileSync(join(path,'state.json'),JSON.stringify({value:10,writer:'contender'}));},600).then(()=>null,error=>error);
  beforeResume=JSON.parse(readFileSync(join(path,'state.json'),'utf8'));
 }finally{
  owner.child.kill('SIGCONT');owner.child.stdin.end('release\n');
 }
 const [code]=await owner.exited;assert.equal(code,0);
 const afterResume=JSON.parse(readFileSync(join(path,'state.json'),'utf8'));
 assert.equal(entered,false,`a paused holder cannot lose ownership; before resume=${JSON.stringify(beforeResume)}, after resume=${JSON.stringify(afterResume)}`);
 assert.ok(refusal instanceof Error,'the contender is refused while the real holder lives');
 assert.deepEqual(beforeResume,{value:0,writer:'initial'});
 assert.deepEqual(afterResume,{value:1,writer:'holder'});
});

test('a killed owner releases the same persistent inode without waiting for a stale lease',{timeout: TEST_HANG_MS * 2},async t=>{
 const path=home(),owner=holder(t,path,'hold');await owner.held;
 const before=statSync(join(path,'.lock'));assert.equal(owner.child.kill('SIGKILL'),true);await owner.exited;
 let entered=false;
 await withHomeLock(path,async()=>{entered=true;},600);
 assert.equal(entered,true);const after=statSync(join(path,'.lock'));
 assert.equal(after.isFile(),true);assert.equal(after.dev,before.dev);assert.equal(after.ino,before.ino);
});

test('ordinary release retains one private regular lock inode, which alone grants no ownership',async()=>{
 const path=home();await withHomeLock(path,async()=>{});const before=statSync(join(path,'.lock'));
 assert.equal(before.isFile(),true);assert.equal(before.nlink,1);assert.equal(before.mode&0o777,0o600);
 let entered=false;await withHomeLock(path,async()=>{entered=true;});const after=statSync(join(path,'.lock'));
 assert.equal(entered,true);assert.equal(after.dev,before.dev);assert.equal(after.ino,before.ino);
});

test('a canonical symlink alias shares the actual scope and persistent inode',async()=>{
 const parent=home(),real=join(parent,'real'),alias=join(parent,'alias');mkdirSync(real);symlinkSync(real,alias);
 await withHomeLock(alias,async outer=>withHomeLock(real,async inner=>{assert.equal(inner,outer);assert.equal(inner.aborted,false);}));
 assert.equal(statSync(join(real,'.lock'),{bigint:true}).ino,statSync(join(alias,'.lock'),{bigint:true}).ino);
});

test('Vault opening queues on the same persistent keys lock before wrapping a new key',async()=>{
 const path=home();let wrapped=0,opening:Promise<Vault>|undefined;
 const keys:HomeKeys={holder:'plaintext',wrap:'none',async wrapKey(key){wrapped++;return key;},async unwrapKey(key){return {key,rewrap:false};}};
 await withHomeLock(join(path,'keys'),async()=>{
  opening=outsideHomeLocks(()=>Vault.open(path,keys));
  await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(wrapped,0,'an independent vault open cannot bypass the physical keys owner');
 });
 assert.ok(await opening);assert.equal(wrapped,1);
 const before=statSync(join(path,'keys','.lock'),{bigint:true});
 await withHomeLock(join(path,'keys'),async()=>{});assert.equal(statSync(join(path,'keys','.lock'),{bigint:true}).ino,before.ino);
});
