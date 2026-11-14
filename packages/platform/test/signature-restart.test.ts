import { childHangTimer } from '../../../scripts/lib/test-child.ts';
// Whole Host restarts, bounded in subprocesses so a regression cannot retain its home lock forever.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {test} from 'node:test';
import {freshDir,freshHome} from './helpers.ts';
for(const mode of ['pending-end','gone','lost-give','control'])test(`whole Host restart: ${mode}`,async()=>{
 const home=freshHome(),person=freshDir('signature-restart-person-');
 const child=spawn(process.execPath,[join(import.meta.dirname,'signature-restart-child.ts'),mode,home,person],{stdio:['ignore','pipe','pipe']});
 let out='',err='',timedOut=false;child.stdout.on('data',x=>out+=String(x));child.stderr.on('data',x=>err+=String(x));
 const timer=childHangTimer(child, `Host restart ${mode}`, () => { timedOut=true; });
 const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);}).finally(()=>clearTimeout(timer));
 assert.equal(timedOut,false,`Host restart ${mode} hit its three-minute hang detector; ${err}`);
 assert.equal(code,0,err);assert.match(out,/Restart completed and ledger verified/);
});
