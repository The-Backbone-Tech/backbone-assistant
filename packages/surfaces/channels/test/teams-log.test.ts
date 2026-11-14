import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {closeSync,mkdirSync,mkdtempSync,openSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {teamsMessage} from './breadth-fixtures.ts';

test('forged Teams Bearer tokens write nothing to the daemon log, including with debug logging enabled',{timeout:30_000},async()=>{
 const home=mkdtempSync(join(tmpdir(),'teams-daemon-log-'));mkdirSync(join(home,'logs'));
 const log=join(home,'logs','daemon.log'),fd=openSync(log,'a',0o600);
 const child=fork(new URL('./teams-log-child.ts',import.meta.url),[home],{env:{...process.env,LOG_LEVEL:'debug',LOG:'*',NODE_NO_WARNINGS:'1'},stdio:['ignore',fd,fd,'ipc']});
 const exited=once(child,'exit');
 try{
  const [ready]=await once(child,'message') as [{url:string;token:string}];
  const response=await fetch(ready.url,{method:'POST',headers:{authorization:`Bearer ${ready.token}`,'content-type':'application/json'},body:JSON.stringify(teamsMessage(1,'private body must not be logged','https://smba.trafficmanager.net/teams/'))});
  assert.equal(response.status,401);child.send('close');
  const [code]=await exited;assert.equal(code,0);
  assert.equal(readFileSync(log).length,0,'launchd captures both stdout and stderr in this file');
 }finally{if(child.exitCode===null&&child.signalCode===null){child.kill();await exited;}closeSync(fd);rmSync(home,{recursive:true,force:true});}
});
