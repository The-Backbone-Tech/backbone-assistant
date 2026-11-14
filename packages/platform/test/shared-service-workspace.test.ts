import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteClient, RemoteError, makeJoinLink } from '../src/remote/client.ts';
import { remoteWorkspace } from '../src/remote/workspace.ts';
import { plaintextKeys } from '../src/keys/vault.ts';
import { inActiveHomeLockScope } from '../src/composition/home-lock.ts';

const target={origin:'https://127.0.0.1:8443',fingerprint:'ab'.repeat(32)};
const person={id:'member',name:'Colleague',role:'member',status:'active'};
const session='s'.repeat(40), link=makeJoinLink({...target,invitation:'i'.repeat(40)});
test('join and sign-out cross the network outside the data-folder lock',async t=>{
  const home=mkdtempSync(join(tmpdir(),'remote-lock-'));
  try{
    t.mock.method(RemoteClient.prototype,'request',async(path:string)=>{
      assert.equal(inActiveHomeLockScope(home),false,`${path} must not retain the home lock`);
      return path==='/identity/accept'?{ok:true,value:{session,person}}:{ok:true,value:{ended:true}};
    });
    const workspace=await remoteWorkspace(home,plaintextKeys());
    await workspace.join(link,person.name);await workspace.leave();
    await assert.rejects(workspace.client(),/Join a workspace/);
  }finally{rmSync(home,{recursive:true,force:true});}
});
for(const status of [403,500,503])test(`an unconfirmed sign-out (${status}) keeps its local session`,async t=>{
  const home=mkdtempSync(join(tmpdir(),'remote-leave-'));
  try{
    t.mock.method(RemoteClient.prototype,'request',async(path:string)=>{
      if(path==='/identity/accept')return{ok:true,value:{session,person}};
      throw new RemoteError('A server problem.',status===403?'REFUSED':'UNKNOWN',status);
    });
    const workspace=await remoteWorkspace(home,plaintextKeys());await workspace.join(link,person.name);
    await assert.rejects(workspace.leave(),/sign-out could not be confirmed/i);
    assert.ok(await workspace.client());
  }finally{rmSync(home,{recursive:true,force:true});}
});
test('only a confirmed already-ended session clears the local record',async t=>{
  const home=mkdtempSync(join(tmpdir(),'remote-ended-'));
  try{
    t.mock.method(RemoteClient.prototype,'request',async(path:string)=>{
      if(path==='/identity/accept')return{ok:true,value:{session,person}};
      throw new RemoteError('Access ended.','REFUSED',401);
    });
    const workspace=await remoteWorkspace(home,plaintextKeys());await workspace.join(link,person.name);await workspace.leave();
    await assert.rejects(workspace.client(),/Join a workspace/);
  }finally{rmSync(home,{recursive:true,force:true});}
});
test('an invalid successful sign-out reply keeps the session',async t=>{
  const home=mkdtempSync(join(tmpdir(),'remote-leave-invalid-'));
  try{
    t.mock.method(RemoteClient.prototype,'request',async(path:string)=>path==='/identity/accept'?{ok:true,value:{session,person}}:{ok:false,outcome:'UNKNOWN'});
    const workspace=await remoteWorkspace(home,plaintextKeys());await workspace.join(link,person.name);
    await assert.rejects(workspace.leave(),/sign-out could not be confirmed/i);assert.ok(await workspace.client());
  }finally{rmSync(home,{recursive:true,force:true});}
});
test('sign-out cannot erase a session installed by a concurrent join',async t=>{
  const home=mkdtempSync(join(tmpdir(),'remote-leave-race-'));
  let release!:()=>void,entered!:()=>void;
  const held=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
  let joins=0;
  try{
    t.mock.method(RemoteClient.prototype,'request',async(path:string)=>{
      if(path==='/identity/accept')return{ok:true,value:{session:++joins===1?session:'t'.repeat(40),person}};
      entered();await held;return{ok:true,value:{ended:true}};
    });
    const workspace=await remoteWorkspace(home,plaintextKeys());await workspace.join(link,person.name);
    const leaving=workspace.leave();await started;
    await workspace.join(link,person.name);release();await leaving;
    const client=await workspace.client();
    t.mock.method(RemoteClient.prototype,'request',async function(this:RemoteClient){
      assert.equal((this as unknown as {session:string}).session,'t'.repeat(40));return{};
    });
    await client.request('/api');
  }finally{release();rmSync(home,{recursive:true,force:true});}
});
test('an explicit access-ended response clears a session even on 403',async t=>{
  const home=mkdtempSync(join(tmpdir(),'remote-ended-explicit-'));
  try{
    t.mock.method(RemoteClient.prototype,'request',async(path:string)=>{
      if(path==='/identity/accept')return{ok:true,value:{session,person}};
      throw new RemoteError('Access ended.','REFUSED',403,true);
    });
    const workspace=await remoteWorkspace(home,plaintextKeys());await workspace.join(link,person.name);await workspace.leave();
    await assert.rejects(workspace.client(),/Join a workspace/);
  }finally{rmSync(home,{recursive:true,force:true});}
});
