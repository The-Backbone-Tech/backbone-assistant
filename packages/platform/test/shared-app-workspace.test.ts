import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteClient, RemoteError, makeJoinLink } from '../src/remote/client.ts';
import { remoteWorkspace } from '../src/remote/workspace.ts';
import { plaintextKeys } from '../src/keys/vault.ts';

test('saved app sessions expose only the origin and preserve unknown send custody across reopening',async t=>{
  const home=await mkdtemp(join(tmpdir(),'app-remote-vault-'));let sends=0;
  const target={origin:'https://127.0.0.1:8443',fingerprint:'a'.repeat(64)};
  try {
    t.mock.method(RemoteClient.prototype,'request',async(path:string)=>{
      if(path==='/identity/accept')return{ok:true,value:{session:'s'.repeat(40),person:{id:'colleague',name:'Colleague',role:'member',status:'active'}}};
      sends++;throw new RemoteError('Unknown outcome','UNKNOWN');
    });
    const workspace=await remoteWorkspace(home,plaintextKeys());assert.equal(workspace.connection(),undefined);
    await workspace.join(makeJoinLink({...target,invitation:'i'.repeat(40)}),'Colleague');
    assert.deepEqual(workspace.connection(),{origin:target.origin});
    const args={projectId:'p',text:'hello',attachments:[],settings:{permission:'full' as const,model:'stub',effort:3 as const,runsOn:'this-computer' as const,mode:'chat' as const},clientKey:'same-send'};
    await assert.rejects((await workspace.appClient()).call('turns.send',args));
    const reopened=await remoteWorkspace(home,plaintextKeys());
    await assert.rejects((await reopened.appClient()).call('turns.send',args),/unknown/i);assert.equal(sends,1);
    assert.deepEqual(reopened.connection(),{origin:target.origin});
  } finally {await rm(home,{recursive:true,force:true});}
});

test('an app client stays bound to its captured workspace when the saved connection changes',async t=>{
  const home=await mkdtemp(join(tmpdir(),'app-remote-binding-'));const origins:string[]=[];
  try {
    t.mock.method(RemoteClient.prototype,'request',async function(this:RemoteClient,path:string){
      origins.push(this.target.origin);
      return path==='/identity/accept'?{ok:true,value:{session:'s'.repeat(40),person:{id:'colleague',name:'Colleague',role:'member',status:'active'}}}:[];
    });
    const workspace=await remoteWorkspace(home,plaintextKeys());
    const link=(port:number)=>makeJoinLink({origin:`https://127.0.0.1:${port}`,fingerprint:'a'.repeat(64),invitation:'i'.repeat(40)});
    await workspace.join(link(8443),'Colleague');const client=await workspace.appClient();
    await workspace.join(link(8444),'Other');await client.call('projects.list',{});
    assert.equal(origins.at(-1),'https://127.0.0.1:8443');
  }finally{await rm(home,{recursive:true,force:true});}
});

test('app restoration belongs to the joining local person, with explicit device-owner custody',async t=>{
  const home=await mkdtemp(join(tmpdir(),'app-remote-person-'));
  try {
    t.mock.method(RemoteClient.prototype,'request',async()=>({ok:true,value:{session:'s'.repeat(40),person:{id:'remote',name:'Remote',role:'member',status:'active'}}}));
    const workspace=await remoteWorkspace(home,plaintextKeys());
    await workspace.join(makeJoinLink({origin:'https://127.0.0.1:8443',fingerprint:'a'.repeat(64),invitation:'i'.repeat(40)}),'Remote','person-a');
    const reopened=await remoteWorkspace(home,plaintextKeys());
    await assert.rejects(reopened.appClient('person-b'),/person/i);
    await assert.rejects(reopened.appClient(),/person/i);
    await reopened.appClient('person-a');
    await assert.rejects(reopened.leave('person-b'),/person/i);
    await workspace.join(makeJoinLink({origin:'https://127.0.0.1:8443',fingerprint:'a'.repeat(64),invitation:'i'.repeat(40)}),'Remote');
    await (await remoteWorkspace(home,plaintextKeys())).appClient('device owner');
  }finally{await rm(home,{recursive:true,force:true});}
});

test('unknown reservations release without sending, expire, stay bounded and clear on leave',async t=>{
  const {Vault}=await import('../src/keys/vault.ts');
  const home=await mkdtemp(join(tmpdir(),'app-remote-release-'));let sends=0;
  try {
    t.mock.method(RemoteClient.prototype,'request',async(path:string)=>{
      if(path==='/identity/accept')return{ok:true,value:{session:'s'.repeat(40),person:{id:'remote',name:'Remote',role:'member',status:'active'}}};
      if(path==='/identity/sign-out')return{ok:true,value:{ended:true}};
      sends++;throw new RemoteError('Unknown outcome','UNKNOWN');
    });
    const workspace=await remoteWorkspace(home,plaintextKeys());
    await workspace.join(makeJoinLink({origin:'https://127.0.0.1:8443',fingerprint:'a'.repeat(64),invitation:'i'.repeat(40)}),'Remote');
    const args={projectId:'p',text:'hello',attachments:[],settings:{permission:'full' as const,model:'stub',effort:3 as const,runsOn:'this-computer' as const,mode:'chat' as const},clientKey:'lost'};
    await assert.rejects((await workspace.appClient()).call('turns.send',args));
    await workspace.releaseAppSend('device owner','lost');assert.equal(sends,1);
    const vault=await Vault.open(home,plaintextKeys());
    assert.deepEqual(JSON.parse(vault.get('remote.pending-app-sends')!.toString()),[]);
    // Old-session, expired and overflow entries cannot refuse unrelated new work.
    await vault.put('remote.pending-app-sends',Buffer.from(JSON.stringify(Array.from({length:4097},(_,i)=>({key:String(i),session:'old',at:0})))));
    await assert.rejects((await workspace.appClient()).call('turns.send',{...args,clientKey:'new'}),/Unknown outcome/);
    assert.equal(sends,2);assert.equal(JSON.parse(vault.get('remote.pending-app-sends')!.toString()).length,1);
    const {createHash}=await import('node:crypto');
    const scope=createHash('sha256').update(JSON.stringify(['https://127.0.0.1:8443','a'.repeat(64),'s'.repeat(40)])).digest('hex');
    await vault.put('remote.pending-app-sends',Buffer.from(JSON.stringify(Array.from({length:4096},(_,i)=>({key:String(i),session:scope,at:Date.now()})))));
    await assert.rejects((await workspace.appClient()).call('turns.send',{...args,clientKey:'overflow'}),/Unknown outcome/);
    assert.equal(sends,3);assert.equal(JSON.parse(vault.get('remote.pending-app-sends')!.toString()).length,4096);
    await vault.put('remote.pending-app-sends',Buffer.from(JSON.stringify([{key:'expired',session:scope,at:0}])));
    await assert.rejects((await workspace.appClient()).call('turns.send',{...args,clientKey:'after-expiry'}),/Unknown outcome/);
    assert.equal(sends,4);assert.equal(JSON.parse(vault.get('remote.pending-app-sends')!.toString()).length,1);
    const legacy=createHash('sha256').update(JSON.stringify(['https://127.0.0.1:8443','a'.repeat(64),'s'.repeat(40),'legacy'])).digest('hex');
    await vault.put('remote.pending-app-sends',Buffer.from(JSON.stringify([legacy])));
    await assert.rejects((await workspace.appClient()).call('turns.send',{...args,clientKey:'legacy'}),/Unknown outcome/i);assert.equal(sends,4);
    await workspace.leave();assert.deepEqual(JSON.parse(vault.get('remote.pending-app-sends')!.toString()),[]);
  }finally{await rm(home,{recursive:true,force:true});}
});
