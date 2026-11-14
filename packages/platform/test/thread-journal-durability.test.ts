// The dispatch barrier must persist the complete event and the first journal's directory entry.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import {ThreadJournal} from '../src/composition/thread-journal.ts';

function fixture(t:TestContext){
 const home=fs.mkdtempSync(join(tmpdir(),'journal-durability-'));
 t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();fs.rmSync(home,{recursive:true,force:true});});
 return {home,journal:new ThreadJournal(home)};
}
test('the first event has a durable directory name and later appends fsync their file',t=>{
 const f=fixture(t),sync=fs.fsyncSync,events:string[]=[];
 t.mock.method(fs,'fsyncSync',(fd:number)=>{events.push(fs.fstatSync(fd).isDirectory()?'directory':'file');return sync(fd);});syncBuiltinESMExports();
 f.journal.append({kind:'thread.deleted',threadId:'first'});
 assert.ok(events.includes('directory'),'new journal directory entry is synced before append returns');
 assert.equal(events.at(-1),'file');assert.equal(fs.statSync(f.journal.path).mode&0o777,0o600);
 const before=events.length;f.journal.append({kind:'thread.deleted',threadId:'second'});
 assert.deepEqual(events.slice(before),['file']);assert.equal(f.journal.read().length,2);
});
test('short writes cannot turn an acknowledged event into a torn or missing reservation',t=>{
 const f=fixture(t),write=fs.writeSync;let partials=0;
 t.mock.method(fs,'writeSync',(...args:unknown[])=>{
  const string=typeof args[1]==='string',bytes=string?Buffer.from(args[1] as string):args[1] as Uint8Array;
  const offset=string?0:Number(args[2]??0),length=string?bytes.byteLength:Number(args[3]??bytes.byteLength-offset),position=string?args[2]:args[4];
  if(length>0)partials++;return Reflect.apply(write,fs,[args[0],bytes,offset,Math.min(3,length),position??null]);
 });syncBuiltinESMExports();
 f.journal.append({kind:'thread.deleted',threadId:'Å😀 first'});f.journal.append({kind:'thread.deleted',threadId:'second'});
 assert.ok(partials>2);assert.deepEqual(f.journal.read().map(event=>event.threadId),['Å😀 first','second']);
});
test('a no-progress append refuses before its caller can dispatch',t=>{
 const f=fixture(t),write=fs.writeSync;let dispatched=false;
 t.mock.method(fs,'writeSync',(...args:unknown[])=>{
  const bytes=args[1];if((typeof bytes==='string'&&bytes.length>0)||(bytes instanceof Uint8Array&&bytes.byteLength>0))return 0;
  return Reflect.apply(write,fs,args);
 });syncBuiltinESMExports();
 assert.throws(()=>{f.journal.append({kind:'thread.deleted',threadId:'not-dispatched'});dispatched=true;},/progress|write/i);
 assert.equal(dispatched,false);
});

test('a journal appearing during first creation keeps its acknowledged content instead of being replaced',t=>{
 const f=fixture(t),open=fs.openSync,rename=fs.renameSync;let appeared=false;
 const winner={kind:'thread.deleted',threadId:'acknowledged-winner',at:'2026-11-09T00:00:00.000Z'};
 const appear=()=>{if(!appeared){appeared=true;fs.writeFileSync(f.journal.path,`${JSON.stringify(winner)}\n`,{mode:0o600});}};
 t.mock.method(fs,'openSync',(...args:unknown[])=>{if(args[0]===f.journal.path&&args[1]==='wx')appear();return Reflect.apply(open,fs,args);});
 t.mock.method(fs,'renameSync',(from:fs.PathLike,to:fs.PathLike)=>{if(to===f.journal.path)appear();return rename(from,to);});syncBuiltinESMExports();
 f.journal.append({kind:'thread.deleted',threadId:'appended-later'});
 assert.equal(appeared,true);assert.deepEqual(f.journal.read().map(event=>event.threadId),['acknowledged-winner','appended-later']);
});
