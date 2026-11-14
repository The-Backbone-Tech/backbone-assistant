import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import {TEST_HANG_MS} from '../../../scripts/lib/test-hang.ts';
import {ownHome,ownerAnswers,ownerSocket} from '../src/composition/home-owner.ts';

function fixture(t:TestContext){
 const account=fs.mkdtempSync('/tmp/f7-bind-'),home=join(account,'data');fs.mkdirSync(home,{mode:0o700});
 const user=os.userInfo();t.mock.method(os,'userInfo',()=>({...user,homedir:account}));syncBuiltinESMExports();
 t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();fs.rmSync(account,{recursive:true,force:true});});
 return {account,home};
}
test('an owner socket is private at bind and probes as live before its ready callback',async t=>{
 const {home}=fixture(t),target=ownerSocket(home,true),listen=net.Server.prototype.listen;
 const modes:number[]=[],probes:Promise<boolean|Error>[]=[];
 t.mock.method(net.Server.prototype,'listen',function(this:net.Server,...args:Parameters<typeof listen>){
  const server=Reflect.apply(listen,this,args);
  if(args[0]===target){
   modes.push(fs.lstatSync(target).mode&0o777);
   probes.push(ownerAnswers(target).catch(error=>error));
  }
  return server;
 });
 const original=process.umask(0o022);let release:(()=>Promise<void>)|undefined;
 try{
  release=await ownHome(home,{readOnly:true});
  assert.equal(process.umask(),0o022,'binding restores the caller mask before yielding');
  assert.equal(modes.length,1);assert.equal(modes[0]&0o077,0,'no group/other access exists even before chmod');
  assert.deepEqual(await Promise.all(probes),[true],'a private creation-mode socket is an owner, not a metadata error');
  assert.equal(fs.lstatSync(target).mode&0o777,0o600);
 }finally{await release?.();process.umask(original);}
});
test('a synchronous bind failure restores the caller umask',async t=>{
 const {home}=fixture(t),failure=new Error('Synthetic bind failure');
 t.mock.method(net.Server.prototype,'listen',()=>{throw failure;});
 const original=process.umask(0o022);
 try{
  await assert.rejects(ownHome(home,{readOnly:true}),error=>error===failure);
  assert.equal(process.umask(),0o022);
 }finally{process.umask(original);}
});
for(const readOnly of [false,true])test(`an owner killed immediately after bind leaves a private, recoverable socket (readOnly=${readOnly})`,async t=>{
 const {account,home}=fixture(t),target=ownerSocket(home,readOnly);
 const child=spawn(process.execPath,[new URL('./owner-bind-crash.ts',import.meta.url).pathname,home,account,readOnly?'read':'write'],{stdio:['ignore','pipe','pipe']});
 let out='',err='';child.stdout.on('data',chunk=>{out+=String(chunk);});child.stderr.on('data',chunk=>{err+=String(chunk);});
 let hung=false;const timeout=setTimeout(()=>{hung=true;child.kill('SIGKILL');},TEST_HANG_MS);
 const ended=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));}).finally(()=>clearTimeout(timeout));
 assert.equal(hung,false,'the crash control must reach bind without the emergency hang guard');
 assert.equal(ended.signal,'SIGKILL',err);assert.ok(out.includes('bound'),err);
 assert.equal(fs.lstatSync(target).mode&0o077,0,'the crash cannot leave a publicly accessible socket');
 assert.equal(await ownerAnswers(target),false,'a dead private socket must not block recovery');
 const release=await ownHome(home,{readOnly});
 try{assert.equal(await ownerAnswers(target),true);}finally{await release();}
});
