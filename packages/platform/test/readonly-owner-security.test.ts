import assert from 'node:assert/strict';
import fs,{chmodSync,lstatSync,mkdirSync,mkdtempSync,realpathSync,rmSync} from 'node:fs';
import net,{createServer} from 'node:net';
import os from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import {dirname,join} from 'node:path';
import {test,type TestContext} from 'node:test';
import {HomeOwned,ownHome,ownerSocket} from '../src/composition/home-owner.ts';

function fixture(t:TestContext){
 const root=mkdtempSync('/tmp/f7-owner-review-'),home=join(root,'data');mkdirSync(home,{mode:0o700});
 const user=os.userInfo();t.mock.method(os,'userInfo',()=>({...user,homedir:root}));syncBuiltinESMExports();
 t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();rmSync(root,{recursive:true,force:true});});
 return {root,home};
}
test('reader ownership uses a private OS-user location rather than a squattable temp namespace',t=>{
 const {root,home}=fixture(t),path=ownerSocket(home,true);
 assert.ok(path.startsWith(realpathSync(root)+'/'));assert.ok(!path.startsWith(home+'/'));
});
for(const flaw of ['foreign folder','public folder','linked folder','foreign socket','public socket'])test(`a writable owner never probes a ${flaw}`,async t=>{
 const {home}=fixture(t),path=ownerSocket(home,true),folder=dirname(path);
 mkdirSync(folder,{recursive:true,mode:0o700});
 const server=createServer(socket=>socket.destroy());
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(path,resolve);});chmodSync(path,0o600);
 const target=flaw.endsWith('folder')?folder:path,stat=lstatSync,connect=net.createConnection,probes:string[]=[];
 t.mock.method(fs,'lstatSync',function(at:fs.PathLike,...args:unknown[]){
  const found=Reflect.apply(stat,fs,[at,...args]);if(String(at)!==target)return found;
  return new Proxy(found,{get(value,key){
   if(key==='uid'&&flaw.startsWith('foreign'))return (process.getuid?.()??0)+1;
   if(key==='mode'&&flaw.startsWith('public'))return found.mode|0o077;
   if(key==='isDirectory'&&flaw==='linked folder')return ()=>false;
   return Reflect.get(value,key);
  }});
 });
 t.mock.method(net,'createConnection',function(...args:Parameters<typeof connect>){probes.push(String(args[0]));return Reflect.apply(connect,net,args);});syncBuiltinESMExports();
 let release:(()=>Promise<void>)|undefined;
 try{
  await assert.rejects(async()=>{release=await ownHome(home);},error=>{
   assert.ok(error instanceof Error);assert.ok(!(error instanceof HomeOwned));assert.ok(error.message.includes(target));return true;
  });
  assert.equal(probes.includes(path),false,'untrusted metadata must refuse before connecting');
 }finally{await release?.();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('a private reader still excludes a writable owner',async t=>{
 const {home}=fixture(t),release=await ownHome(home,{readOnly:true});
 try{await assert.rejects(ownHome(home),HomeOwned);}finally{await release();}
});
