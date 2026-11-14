import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Ledger } from '../src/ledger.ts';
test('independent processes share one-use bindings and intake uniqueness through SQLite',async()=>{
 const home=mkdtempSync(join(tmpdir(),'channels-concurrent-')),ledger=new Ledger(home),code=ledger.invite();
 const source=`import {Ledger} from ${JSON.stringify(new URL('../src/ledger.ts',import.meta.url).href)};const db=new Ledger(process.argv[1]);const paired=db.pair('telegram',process.argv[3],process.argv[2]);for(let n=0;n<30;n++)db.receive({provider:'telegram',id:String(n),conversation:'room',sender:'7',text:'job'});db.close();process.stdout.write(String(paired));`;
 const run=(sender:string)=>new Promise<string>((resolve,reject)=>{const p=spawn(process.execPath,['--input-type=module','-e',source,home,code,sender]);let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',reject);p.on('close',c=>c===0?resolve(out):reject(new Error(err)));});
 try {const results=await Promise.all([run('a'),run('b')]);assert.deepEqual(results.sort(),['false','true']);assert.equal(ledger.pending().length,30);}
 finally {ledger.close();rmSync(home,{recursive:true,force:true});}
});
