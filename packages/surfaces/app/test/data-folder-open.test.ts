import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as decisions from '../electron/data-folder-open.ts';
import { chooseKeys, homeKeyProvider } from '@backbone-next/platform/system-keys';
import { KeysRefused, Vault, keychainKeys } from '@backbone-next/platform/keys';
import { createDataFolderOpener, launchEnvironment, launchDataFolder } from '../electron/data-folder-open.ts';

test('opening uses only main-owned identities, checks again and never trusts a renderer path', async t => {
  const root = mkdtempSync(join(tmpdir(), 'folder-open-')); t.after(() => rmSync(root, {recursive:true,force:true}));
  const folder = join(root,'data'); mkdirSync(folder);
  const launched: string[] = []; let checks = 0;
  const opener = createDataFolderOpener({check:()=>{ checks++; },launch:async path=>{launched.push(path);return {state:'opened'};}});
  const pick = opener.pick(folder,7); assert.ok(pick.ok);
  assert.equal((await opener.open(folder,7)).state,'failed');
  assert.equal((await opener.open(pick.id,8)).state,'failed');
  assert.equal((await opener.open(pick.id,7)).state,'opened');
  assert.equal((await opener.open(pick.id,7)).state,'opened');
  assert.deepEqual(launched,[folder]); assert.equal(checks,2);
});
test('invalid and replaced folders are refused without launching', async t => {
  const root = mkdtempSync(join(tmpdir(),'folder-refuse-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  let calls=0;const opener=createDataFolderOpener({check:()=>{throw new Error('Newer data format.');},launch:async()=>{calls++;return {state:'opened'};}});
  assert.deepEqual(opener.pick(root,1),{ok:false,reason:'INVALID',detail:'Newer data format.'});
  const ok=createDataFolderOpener({check:()=>{},launch:async()=>{calls++;return {state:'opened'};}});
  const folder=join(root,'data');mkdirSync(folder);const pick=ok.pick(folder,1);assert.ok(pick.ok);
  renameSync(folder,join(root,'moved'));symlinkSync(join(root,'moved'),folder);
  assert.equal((await ok.open(pick.id,1)).state,'failed');assert.equal(calls,0);
});
test('a launch with no answer stays unconfirmed and is never repeated', async t => {
  const root=mkdtempSync(join(tmpdir(),'folder-unknown-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  let calls=0;const opener=createDataFolderOpener({check:()=>{},launch:async()=>{calls++;return {state:'unknown',detail:'No answer.'};}});
  const pick=opener.pick(root,1);assert.ok(pick.ok);
  assert.equal((await opener.open(pick.id,1)).state,'unknown');assert.equal((await opener.open(pick.id,1)).state,'unknown');assert.equal(calls,1);
});
test('child environment excludes secrets, user imports, model routes and parent process switches',()=>{
  const env=launchEnvironment('/restored',{PATH:'/bin',HOME:'/person',TMPDIR:tmpdir(),BACKBONE_HOME:'/current',BACKBONE_USER_HOME:'/private',OPENAI_API_KEY:'secret',BACKBONE_MODEL_ENDPOINT:'secret',NODE_OPTIONS:'--inspect',ELECTRON_RUN_AS_NODE:'1',BACKBONE_KEYS:'plaintext'},false);
  assert.deepEqual(env,{PATH:'/bin',HOME:'/person',TMPDIR:tmpdir(),BACKBONE_HOME:'/restored',BACKBONE_KEYS:'plaintext'});
  assert.equal(launchEnvironment('/r',{BACKBONE_KEYS:'plaintext'},true).BACKBONE_KEYS,undefined);
});
test('spawn is shell-free, uses the same executable and waits for actual child acknowledgement',async()=>{
  const child=Object.assign(new EventEmitter(),{unref(){},disconnect(){},connected:true});
  let options:unknown;let args:unknown;let exe:unknown;
  const result=launchDataFolder('/restored',{executable:'/app/Assistant',appPath:'/app/app.asar',packaged:true,env:{TOKEN:'secret'},spawn:(x,a,o)=>{exe=x;args=a;options=o;queueMicrotask(()=>child.emit('message',{state:'opened'}));return child;}});
  assert.equal((await result).state,'opened');assert.equal(exe,'/app/Assistant');assert.deepEqual(args,[]);
  assert.deepEqual(options,{env:{BACKBONE_HOME:'/restored'},detached:true,stdio:['ignore','ignore','ignore','ipc']});
});

for (const message of [{state:'already-open'}, {state:'failed',detail:'The original key holder is unavailable.'}]) {
  test(`the child's ${message.state} acknowledgement is preserved`, async()=>{
    const child=Object.assign(new EventEmitter(),{unref(){},disconnect(){},connected:true});
    const result=await launchDataFolder('/restored',{executable:'/app/Assistant',appPath:'/app/source',packaged:false,env:{},spawn:(_exe,args)=>{assert.deepEqual(args,['/app/source']);queueMicrotask(()=>child.emit('message',message));return child;}});
    assert.deepEqual(result,message);
  });
}
test('a child exit before acknowledgement is a failed start, never an opened result',async()=>{
  const child=Object.assign(new EventEmitter(),{unref(){},disconnect(){},connected:false});
  const result=await launchDataFolder('/restored',{executable:'/app/Assistant',appPath:'/app/source',packaged:false,env:{},spawn:()=>{queueMicrotask(()=>child.emit('exit',1));return child;}});
  assert.equal(result.state,'failed');
});
test('unrecognised child messages cannot establish success and the acknowledgement deadline stays unconfirmed',async()=>{
  const child=Object.assign(new EventEmitter(),{unref(){},disconnect(){},connected:true});
  const result=await launchDataFolder('/restored',{executable:'/app/Assistant',appPath:'/app/source',packaged:false,env:{},timeoutMs:1,spawn:()=>{queueMicrotask(()=>child.emit('message',{state:'running'}));return child;}});
  assert.equal(result.state,'unknown');
});
test('a spawn error gives its reason without an opened result',async()=>{
  const result=await launchDataFolder('/restored',{executable:'/app/Assistant',appPath:'/app/source',packaged:false,env:{},spawn:()=>{throw new Error('Executable unavailable.');}});
  assert.deepEqual(result,{state:'failed',detail:'Executable unavailable.'});
});


test('the last already-open message can arrive after exit and before disconnect', async()=>{
  const child=Object.assign(new EventEmitter(),{unref(){},disconnect(){},connected:true});
  const result=launchDataFolder('/restored',{executable:'/app',appPath:'/source',packaged:true,env:{},spawn:()=>{
    queueMicrotask(()=>{child.emit('exit',0);child.emit('message',{state:'already-open'});child.connected=false;child.emit('disconnect');});return child;
  }});
  assert.deepEqual(await result,{state:'already-open'});
});
test('a child flushes its report before exit and has a bounded fallback', async()=>{
  let sent:(()=>void)|undefined;let exits=0;
  decisions.reportBeforeExit({state:'already-open'},(_result,done)=>{sent=done;},()=>{exits++;},10);
  assert.equal(exits,0);sent!();assert.equal(exits,1);
  await new Promise(r=>setTimeout(r,20));assert.equal(exits,1);
  decisions.reportBeforeExit({state:'already-open'},()=>{},()=>{exits++;},1);
  await new Promise(r=>setTimeout(r,10));assert.equal(exits,2);
});
test('only an owning child with a successful read and a successful page reports opened',()=>{
  assert.deepEqual(decisions.folderVisibleResult({owns:true,readSucceeded:true,failed:false}),{state:'opened'});
  assert.equal(decisions.folderVisibleResult({owns:false,readSucceeded:true,failed:false}).state,'failed');
  assert.equal(decisions.folderVisibleResult({owns:true,readSucceeded:false,failed:false}).state,'failed');
  assert.equal(decisions.folderVisibleResult({owns:true,readSucceeded:true,failed:true}).state,'failed');
});
test('company folders cannot be chosen and a second launch opens only a live ready app',()=>{
  assert.equal(decisions.folderChoiceRefusal(true)?.ok,false);assert.equal(decisions.folderChoiceRefusal(false),undefined);
  assert.equal(decisions.secondLaunchAction(true,false,false),'focus');
  assert.equal(decisions.secondLaunchAction(false,true,false),'open');
  assert.equal(decisions.secondLaunchAction(false,false,false),'none');
  assert.equal(decisions.secondLaunchAction(false,true,true),'none');
});
test('a restored button expires on the injected clock and points to the picker without launching',async t=>{
  const folder=mkdtempSync(join(tmpdir(),'folder-expiry-'));t.after(()=>rmSync(folder,{recursive:true,force:true}));
  let now=0,calls=0;
  const opener=createDataFolderOpener({now:()=>now,check:()=>{},launch:async()=>{calls++;return {state:'opened'};}});
  const pick=opener.pick(folder,1);assert.ok(pick.ok);now=30*60_000+1;
  const result=await opener.open(pick.id,1);assert.equal(result.state,'failed');assert.match('detail' in result?result.detail:'',/Open another data folder…/);assert.equal(calls,0);
});
test('storage refusal happens before launch, including a removable-volume path',async t=>{
  const folder=mkdtempSync(join(tmpdir(),'folder-storage-'));t.after(()=>rmSync(folder,{recursive:true,force:true}));
  let calls=0;
  const opener=createDataFolderOpener({check:path=>decisions.checkFolderStorage(path,()=>{throw new Error('Network storage is not supported.');},'darwin'),launch:async()=>{calls++;return {state:'opened'};}});
  assert.equal(opener.pick(folder,1).ok,false);assert.equal(calls,0);
  assert.throws(()=>decisions.checkFolderStorage('/Volumes/Removable/work',()=>{},'darwin'),/removable/);
});
test('the original key refusal becomes a fixed local explanation, never an identity pause or raw error',()=>{
  const problem=decisions.folderStartupProblem(new KeysRefused('plaintext-home','secret value'));
  assert.equal(problem.kind,'keys');assert.match(problem.detail,/plain files/);assert.match(problem.detail,/command that created/);assert.doesNotMatch(problem.detail,/secret value|Team features/);
  assert.deepEqual(decisions.folderVisibleResult({owns:true,readSucceeded:false,failed:true,problem}),{state:'failed',detail:problem.detail});
  assert.match(decisions.folderStartupProblem(new KeysRefused('not-unwrapped','secret')).detail,/Keychain/);
});
test('a Keychain that is locked or refuses is a start to retry, not a folder this app can never open',()=>{
  for(const code of ['not-unwrapped','no-keychain'] as const){
    const problem=decisions.folderStartupProblem(new KeysRefused(code,'secret'),{holder:'keychain',wrap:'electron-safeStorage'});
    assert.equal(problem.kind,'keychain');assert.match(problem.detail,/Unlock the Keychain/);assert.match(problem.detail,/Nothing was changed/);
    assert.doesNotMatch(problem.detail,/secret|restore an export|command that created/);
  }
  assert.equal(decisions.folderStartupProblem(new KeysRefused('not-unwrapped','secret')).kind,'keychain');
  const borrowed=decisions.folderStartupProblem(new KeysRefused('test-database','secret'));
  assert.equal(borrowed.kind,'keys');assert.match(borrowed.detail,/test database/);assert.doesNotMatch(borrowed.detail,/secret/);
  assert.equal(decisions.folderStartupProblem(new KeysRefused('plaintext-home','secret')).kind,'keys');
  assert.doesNotMatch(decisions.folderStartupProblem(new Error('secret')).detail,/secret/);
});

test('choosing this window’s folder reports that fact without starting another process',async t=>{
  const folder=mkdtempSync(join(tmpdir(),'folder-current-'));t.after(()=>rmSync(folder,{recursive:true,force:true}));
  let calls=0;
  const opener=createDataFolderOpener({currentFolder:folder,check:()=>{},launch:async()=>{calls++;return {state:'opened'};}});
  const pick=opener.pick(folder,1);assert.ok(pick.ok);
  assert.deepEqual(await opener.open(pick.id,1),{state:'already-open',current:true});assert.equal(calls,0);
});

test('exit waits for disconnect even when connected becomes false before the last message',async()=>{
  const child=Object.assign(new EventEmitter(),{unref(){},disconnect(){},connected:true});
  const result=launchDataFolder('/restored',{executable:'/app',appPath:'/source',packaged:true,env:{},spawn:()=>{
    queueMicrotask(()=>{child.connected=false;child.emit('exit',0);setImmediate(()=>{child.emit('message',{state:'already-open'});child.emit('disconnect');});});return child;
  }});
  assert.deepEqual(await result,{state:'already-open'});
});


test('a default command system-store vault is diagnosed separately from a plaintext folder without changing keys',async t=>{
  const folder=mkdtempSync(join(tmpdir(),'folder-system-keys-'));t.after(()=>rmSync(folder,{recursive:true,force:true}));
  const items=new Map<string,Buffer>();
  const store={available:async()=>true,get:async(id:string)=>items.has(id)?Buffer.from(items.get(id)!):null,create:async(id:string,key:Buffer)=>{items.set(id,Buffer.from(key));}};
  t.after(()=>{for(const key of items.values())key.fill(0);});
  const selected=await chooseKeys(folder,{},store,{create:true});await Vault.open(folder,selected);
  const metadata=homeKeyProvider(folder);assert.equal(metadata?.wrap,'os-keyring-v1');
  const before=readFileSync(join(folder,'keys/vault.json'));
  const electron=keychainKeys({isAsyncEncryptionAvailable:async()=>true,encryptStringAsync:async()=>{throw new Error('must not write');},decryptStringAsync:async()=>{throw new Error('not a safeStorage envelope');}});
  let problem:ReturnType<typeof decisions.folderStartupProblem>|undefined;
  await assert.rejects(Vault.open(folder,electron,{readOnly:true}),error=>{
    assert.ok(error instanceof KeysRefused);assert.equal(error.code,'not-unwrapped');
    problem=decisions.folderStartupProblem(error,metadata);return true;
  });
  assert.equal(problem?.kind,'keys');assert.match(problem?.detail??'',/command’s system key store/);assert.match(problem?.detail??'',/different Keychain format/);
  assert.doesNotMatch(problem?.detail??'',/plain files|safeStorage envelope/);
  assert.deepEqual(readFileSync(join(folder,'keys/vault.json')),before);
});
