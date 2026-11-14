import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const guard=join(import.meta.dirname,'lib/test-local-network.cjs');
for(const mode of ['fetch','http','https','socket','dns','grandchild'])test('a caught outside '+mode+' attempt fails the test suite without opening a socket',()=>{
 const temp=mkdtempSync(join(tmpdir(),'network-refusal-'));
 const canary="()=>{throw new Error('Native outside transport must not run');}";
 const setup='globalThis.fetch='+canary+";require('node:http').request="+canary+";require('node:https').request="+canary+";require('node:net').Socket.prototype.connect="+canary+";require('node:dns').lookup="+canary+';require('+JSON.stringify(guard)+');';
 const attempt=mode==='fetch'?"await fetch('https://outside.invalid/private');":mode==='http'?"require('node:http').request('http://outside.invalid/private');":mode==='https'?"require('node:https').request({hostname:'outside.invalid',path:'/private'});":mode==='socket'?"new (require('node:net').Socket)().connect(443,'203.0.113.10');":mode==='dns'?"require('node:dns').lookup('outside.invalid',()=>{});":'';
 try{
  const file=join(temp,'probe.test.cjs');
  const body=mode==='grandchild'?"const child=require('node:child_process').spawnSync(process.execPath,['-e',"+JSON.stringify(setup+"fetch('https://outside.invalid').catch(()=>{}).then(()=>process.exit(0));")+"],{env:{...process.env,NODE_OPTIONS:''}});require('node:assert/strict').equal(child.status,1);":'try{'+attempt+'}catch{}';
  writeFileSync(file,setup+"require('node:test').test('fixture swallows the error',async()=>{"+body+"});");
  const result=spawnSync(process.execPath,['--test',file],{env:{...process.env,NODE_OPTIONS:'',NODE_TEST_CONTEXT:undefined,BACKBONE_TEST_NETWORK_AUDIT:join(temp,'audit')},encoding:'utf8',timeout:30_000});
  assert.notEqual(result.status,0,result.stdout+result.stderr);
  assert.match(result.stdout+result.stderr,/TEST_EXTERNAL_NETWORK_REFUSED/);
 }finally{rmSync(temp,{recursive:true,force:true});}
});
