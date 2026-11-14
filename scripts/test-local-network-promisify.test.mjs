import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

const guard=fileURLToPath(new URL('./lib/test-local-network.cjs',import.meta.url));
function probe(source){
 const home=mkdtempSync(join(tmpdir(),'guard-promisify-'));
 try{
  return spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:30_000,
   env:{...process.env,NODE_OPTIONS:'',NODE_TEST_CONTEXT:undefined,BACKBONE_TEST_NETWORK_AUDIT:join(home,'audit')}});
 }finally{rmSync(home,{recursive:true,force:true});}
}
const setup=`import assert from 'node:assert/strict';import cp from 'node:child_process';import {promisify} from 'node:util';const nativeExec=cp.exec,nativeExecCustom=cp.exec[promisify.custom];await import(${JSON.stringify(guard)});`;

test('guarded promisify(execFile) returns both streams and its child while exec keeps its native contract',()=>{
 const source=setup+`
 assert.equal(cp.exec,nativeExec);assert.equal(cp.exec[promisify.custom],nativeExecCustom);
 for(const name of ['spawn','spawnSync','execFileSync'])assert.equal(cp[name][promisify.custom],undefined);
 const result=promisify(cp.execFile)(process.execPath,['-e',"process.stdout.write('answer');process.stderr.write('diagnostic')"]);
 assert.ok(result.child?.pid);assert.deepEqual(await result,{stdout:'answer',stderr:'diagnostic'});
 const noArgs=await promisify(cp.execFile)('/usr/bin/true',{timeout:5000});
 assert.equal(typeof noArgs.stdout,'string');assert.equal(typeof noArgs.stderr,'string');
 `;
 const result=probe(source);
 assert.equal(result.status,0,result.stdout+result.stderr);
});

test('guarded promisify(execFile) attaches both streams to a rejected child error',()=>{
 const result=probe(setup+`
 await assert.rejects(promisify(cp.execFile)(process.execPath,['-e',"process.stdout.write('partial');process.stderr.write('reason');process.exit(7)"]),error=>{
  assert.equal(error.code,7);assert.equal(error.stdout,'partial');assert.equal(error.stderr,'reason');return true;
 });
 `);
 assert.equal(result.status,0,result.stdout+result.stderr);
});

test('promisified execFile still guards a child outside request even when its rejection is caught',()=>{
 const child=`const assert=require('node:assert/strict');const http=require('node:http');assert.ok(globalThis[Symbol.for('backbone.test.local-network')]);try{http.request('http://outside.invalid')}catch(error){process.stdout.write('blocked')}`;
 const result=probe(setup+`
 await assert.rejects(promisify(cp.execFile)(process.execPath,['-e',${JSON.stringify(child)}]),error=>{
  assert.equal(error.code,1);assert.equal(error.stdout,'blocked');assert.match(error.stderr,/TEST_EXTERNAL_NETWORK_REFUSED/);return true;
 });
 process.stdout.write('refusal verified');
 `);
 assert.equal(result.status,1,result.stdout+result.stderr);
 assert.match(result.stdout,/refusal verified/);assert.match(result.stderr,/TEST_EXTERNAL_NETWORK_REFUSED/);
});
