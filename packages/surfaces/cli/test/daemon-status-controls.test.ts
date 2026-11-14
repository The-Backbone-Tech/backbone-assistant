import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {status,type Launchd} from '../src/daemon.ts';

for(const control of ['\r','\x00','\x1b','\x7f','\u0085','\u2028'])test(`daemon status ignores a forged key ID containing control U+${control.charCodeAt(0).toString(16)}`,()=>{
 const home=mkdtempSync(join(tmpdir(),'daemon-status-control-'));mkdirSync(join(home,'logs'));
 const at:Launchd={agents:join(home,'agents'),uid:1,node:process.execPath,script:'main.ts',launchctl:()=>({code:113,out:''})};
 const record='daemon: stopped after key refusal (spoofed): attacker [missing-item at 2026-11-11T00:00:00.000Z]';
 try{
  writeFileSync(join(home,'logs','daemon.log'),control==='\r'?`SDK key x\r${record}\r\n`:`${record.replace('attacker',`key${control}id`)}\n`);
  assert.equal(status(home,at).lastRefusal,undefined);
 }finally{rmSync(home,{recursive:true,force:true});}
});
