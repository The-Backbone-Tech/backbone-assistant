import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from '../src/commands.ts';
import { sharedBinding } from '../src/daemon.ts';

test('join and remote work have a data folder without configuring a local engine', () => {
  const scratch=mkdtempSync(join(tmpdir(),'remote-parse-'));
  try{
  const joined=parse(['join','https://workspace.invalid/#redacted','--name','Colleague'],{BACKBONE_USER_HOME:scratch});
  assert.equal(joined.usage,undefined);assert.equal(joined.options.name,'Colleague');
  assert.equal(joined.home,join(scratch,'.local','share','backbone'));
  assert.equal(parse(['remote','send','Hello','--project','project'],{BACKBONE_HOME:scratch}).name,'remote send');
  assert.match(parse(['send','Hello','--share','0.0.0.0:8443'],{BACKBONE_HOME:scratch}).usage!,/daemon/);
  assert.match(parse(['team','share','project'],{BACKBONE_HOME:scratch}).usage!,/person/);
  }finally{rmSync(scratch,{recursive:true,force:true});}
});
test('sharing requires an explicit numeric address and supports IPv6', () => {
  assert.deepEqual(sharedBinding('0.0.0.0:8443'),{address:'0.0.0.0',port:8443});
  assert.deepEqual(sharedBinding('[::1]:8443'),{address:'::1',port:8443});
  for(const value of ['8443','host:8443','127.0.0.1:65536','http://127.0.0.1:8443','::1:8443'])assert.throws(()=>sharedBinding(value));
});

test('a remote permission refusal is refused rather than an unknown write',async()=>{
  const {runCommand,EXIT}=await import('../src/commands.ts');
  const {RemoteError}=await import('@backbone-next/platform/remote/client');
  const lines:string[]=[];
  const parsed=parse(['send','Hello','--project','project','--model','scripted'],{BACKBONE_HOME:'client-home'});
  const api={call:async(method:string)=>{if(method==='projects.list')return[{id:'project'}];throw new RemoteError('A viewer can read but cannot send.','REFUSED',403);}};
  const code=await runCommand(parsed,api as never,{out:line=>lines.push(line),err:line=>lines.push(line),onInterrupt(){},holding(){},pollMs:10,stopWaitMs:100});
  assert.equal(code,EXIT.REFUSED);assert.deepEqual(lines,['A viewer can read but cannot send.']);
});
