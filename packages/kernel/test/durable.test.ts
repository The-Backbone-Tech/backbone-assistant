// Owned temporary files and legal short-write counterfactuals; no cluster or provider.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import * as durable from '../src/durable.ts';

function fixture(t:TestContext){
 const dir=fs.mkdtempSync(join(tmpdir(),'kernel-durable-'));
 t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();fs.rmSync(dir,{recursive:true,force:true});});
 return {dir,path:join(dir,'data')};
}
function limitWrites(t:TestContext,limit:number){
 const original=fs.writeSync;let calls=0;
 t.mock.method(fs,'writeSync',(...args:unknown[])=>{
  calls++;const bytes=args[1] as Uint8Array,offset=typeof args[2]==='number'?args[2]:0,length=typeof args[3]==='number'?args[3]:bytes.byteLength-offset;
  if(limit===0)return 0;
  return Reflect.apply(original,fs,[args[0],bytes,offset,Math.min(limit,length),args[4]??null]);
 });syncBuiltinESMExports();return ()=>calls;
}

test('short writes preserve every UTF8 byte, atomic replacement, caller mode and file/folder fsync order',t=>{
 const f=fixture(t),text='Å😀 source '.repeat(5),events:string[]=[];fs.writeFileSync(f.path,'old target');
 const rename=fs.renameSync,sync=fs.fsyncSync;
 t.mock.method(fs,'renameSync',(from:fs.PathLike,to:fs.PathLike)=>{assert.equal(fs.readFileSync(f.path,'utf8'),'old target');events.push('rename');return rename(from,to);});
 t.mock.method(fs,'fsyncSync',(fd:number)=>{events.push(fs.fstatSync(fd).isDirectory()?'folder':'file');return sync(fd);});
 const calls=limitWrites(t,3);durable.writeDurable(f.path,text,0o640);
 assert.equal(fs.readFileSync(f.path,'utf8'),text);assert.ok(calls()>1);
 assert.equal(fs.statSync(f.path).mode&0o777,0o640&~process.umask());assert.deepEqual(events,['file','rename','folder']);
});

test('a no-progress write refuses before replacing an existing target',t=>{
 const f=fixture(t);fs.writeFileSync(f.path,'kept original');const calls=limitWrites(t,0);
 assert.throws(()=>durable.writeDurable(f.path,'new content'),/progress|write/i);
 assert.equal(fs.readFileSync(f.path,'utf8'),'kept original');assert.equal(calls(),1,'no infinite zero-byte loop');
 for(const name of fs.readdirSync(f.dir).filter(name=>name.endsWith('.tmp')))assert.equal(fs.statSync(join(f.dir,name)).mode&0o777,0o600);
});

test('write-all advances byte offsets and explicit file positions across partial multibyte writes',t=>{
 const f=fixture(t),original=Buffer.alloc(40,46),body=Buffer.from('Å😀exact');fs.writeFileSync(f.path,original);
 limitWrites(t,2);const fd=fs.openSync(f.path,'r+');
 try{durable.writeAll(fd,body,7);}finally{fs.closeSync(fd);}
 const expected=Buffer.from(original);body.copy(expected,7);assert.deepEqual(fs.readFileSync(f.path),expected);
});
