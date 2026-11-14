import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { parse } from '../src/commands.ts';
import { sharedDaemonState } from '../src/remote.ts';
import { cli, FakeSystemStore, passed } from './system-key-fixture.ts';

test('join accepts an omitted link so it can be entered without shell history',t=>{
  const home=mkdtempSync(join(tmpdir(),'shared-join-parse-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
  const parsed=parse(['join','--name','Colleague'],{BACKBONE_HOME:home});
  assert.equal(parsed.usage,undefined);assert.equal(parsed.target,undefined);
});
test('the terminal team command cannot invite an administrator',t=>{
  const home=mkdtempSync(join(tmpdir(),'shared-role-parse-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
  assert.match(parse(['team','invite','--role','admin'],{BACKBONE_HOME:home}).usage!,/member.*guest.*app/);
  for(const role of ['member','guest'])assert.equal(parse(['team','invite','--role',role],{BACKBONE_HOME:home}).usage,undefined);
});
test('a daemon record naming a live unrelated process is not a running shared daemon',async()=>{
  const home=mkdtempSync(join(tmpdir(),'shared-daemon-status-'));
  try{writeFileSync(join(home,'daemon.json'),JSON.stringify({pid:process.pid,shared:{origin:'https://127.0.0.1:8443',fingerprint:'a'.repeat(64)}}));assert.equal(await sharedDaemonState(home),undefined);}
  finally{rmSync(home,{recursive:true,force:true});}
});
test('macOS daemon status preserves launchd fields with a live stale daemon record',async()=>{
  if(process.platform!=='darwin')return;
  const home=mkdtempSync(join(tmpdir(),'shared-launchd-status-'));
  try{writeFileSync(join(home,'daemon.json'),JSON.stringify({pid:process.pid}));const result=await cli(home,['daemon','status','--json'],new FakeSystemStore());passed(result);assert.deepEqual(JSON.parse(result.out),{installed:false,running:false});}
  finally{rmSync(home,{recursive:true,force:true});}
});
test('terminal link input is not echoed while the name remains readable',async()=>{
  const {readJoinDetails}=await import('../src/remote-input.ts');
  const input=new PassThrough() as PassThrough & {isTTY:boolean;setRawMode:(raw:boolean)=>void};input.isTTY=true;input.setRawMode=()=>{};
  const output=new PassThrough();let shown='';output.on('data',chunk=>{shown+=chunk;});
  const details=readJoinDetails(undefined,undefined,input,output);
  input.write('https://workspace.invalid/#private-invitation\r');
  await new Promise<void>(resolve=>setImmediate(resolve));input.write('Colleague\r');
  assert.deepEqual(await details,{link:'https://workspace.invalid/#private-invitation',name:'Colleague'});
  assert.match(shown,/Join link:/);assert.match(shown,/Your name:.*Colleague/);assert.doesNotMatch(shown,/private-invitation/);
  input.destroy();output.destroy();
});

test('a remote unknown send is checked without resending',async()=>{
 const {runCommand,EXIT}=await import('../src/commands.ts');
 const {RemoteError}=await import('@backbone-next/platform/remote/client');
 const lines:string[]=[];let sent=0;
 const parsed=parse(['send','Hello','--project','project','--model','scripted'],{BACKBONE_HOME:'client-home'});
 const api={call:async(method:string)=>{if(method==='projects.list')return[{id:'project'}];sent++;throw new RemoteError('The request outcome is unknown. Check the work before sending again.','UNKNOWN',503);}};
 const code=await runCommand(parsed,api as never,{out:line=>lines.push(line),err:line=>lines.push(line),onInterrupt(){},holding(){},pollMs:10,stopWaitMs:100});
 assert.equal(code,EXIT.UNKNOWN);assert.equal(sent,1);assert.match(lines.join('\n'),/outcome is unknown.*Check the work/);assert.doesNotMatch(lines.join('\n'),/refused/i);
});

test('shared daemon metadata is added only when the private socket confirms the same process',async()=>{
 const {serveApiLine}=await import('@backbone-next/platform/composition/api-line');
 const {mkdirSync}=await import('node:fs');
 const root=mkdtempSync(join(tmpdir(),'shared-confirmed-')),home=join(root,'long-home-'.repeat(15));mkdirSync(home);
 const shared={origin:'https://127.0.0.1:8443',fingerprint:'b'.repeat(64)};
 const server=await serveApiLine({home,readOnly:true,teamManagement:true,call:async()=>{throw Error('No method should be called to verify the socket owner.');}});
 try{
  writeFileSync(join(home,'daemon.json'),JSON.stringify({pid:process.pid,shared}));
  assert.deepEqual(await sharedDaemonState(home),{pid:process.pid,shared});
  if(process.platform==='darwin'){
   const result=await cli(home,['daemon','status','--json'],new FakeSystemStore(),undefined,'',true);passed(result);
   assert.deepEqual(JSON.parse(result.out),{installed:false,running:true,pid:4242,shared});
   const text=await cli(home,['daemon','status'],new FakeSystemStore());passed(text);assert.match(text.out,/not installed\nShared workspace: https:\/\/127.0.0.1:8443\nCertificate SHA-256:/);
  }
  writeFileSync(join(home,'daemon.json'),JSON.stringify({pid:process.ppid,shared}));
  assert.equal(await sharedDaemonState(home),undefined);
 }finally{await server.close();rmSync(root,{recursive:true,force:true});}
});
