// Retained objects must stop writing after H1's real integrity observer refuses a key.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {HomeWriteUnavailable,withHomeLock} from '../src/composition/home-lock.ts';
import {CredentialStore} from '../src/credentials/store.ts';
import {Vault,plaintextKeys,type HomeKeys} from '../src/keys/vault.ts';
import {freshDir} from './helpers.ts';
import {replaceHeldHomeLock} from './native-lock-observation.ts';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
function snapshot(home:string):string {
  const walk=(at:string):unknown=>fs.readdirSync(at).sort().map(name=>{
    const path=join(at,name),stat=fs.lstatSync(path);
    return [name,stat.mode,stat.isDirectory()?walk(path):fs.readFileSync(path).toString('base64')];
  });
  return JSON.stringify(walk(home));
}
const refused=(error:unknown)=>error instanceof HomeWriteUnavailable;
for(const target of ['root','keys'] as const)for(const master of [false,true])test(`retained Vault refuses ${target} loss before cached master=${master}`,async()=>{
  const home=freshDir('audit-admission-'),vault=await Vault.open(home,plaintextKeys());
  if(master)await vault.masterKey();
  await replaceHeldHomeLock(target==='root'?home:join(home,'keys'));
  const before=snapshot(home);
  await assert.rejects(vault.masterKey(),refused);
  assert.equal(snapshot(home)===before,true,'no bytes or folders change after observed loss');
});
for(const target of ['root','keys'] as const)for(const rewrap of [false,true])test(`delayed ${rewrap?'rewrap':'wrap'} refuses ${target} loss at vault write`,async()=>{
  const home=freshDir('audit-admission-wrap-'),entered=deferred(),resume=deferred();let delayed=false;
  const keys:HomeKeys={holder:'keychain',wrap:'fake-admission',async wrapKey(key){if(delayed){entered.resolve();await resume.promise;}return key;},async unwrapKey(key){return {key,rewrap};}};
  if(rewrap){await Vault.open(home,keys);Vault.forget(home);}
  await withHomeLock(join(home,'keys'),async()=>{
    delayed=true;
    const pending=Vault.open(home,keys);void pending.catch(()=>{});
    await entered.promise;
    await replaceHeldHomeLock(target==='root'?home:join(home,'keys'));
    const before=snapshot(home);resume.resolve();
    await assert.rejects(pending,refused);assert.equal(snapshot(home)===before,true);
  });
});

for(const target of ['root','credentials'] as const)test(`CredentialStore delayed master refuses ${target} loss before creating a folder`,async()=>{
  const home=freshDir('audit-admission-credentials-'),entered=deferred(),resume=deferred();
  const store=new CredentialStore(home,async()=>{entered.resolve();await resume.promise;return Buffer.alloc(32,7);});
  const pending=store.put('fake-only','fake label');void pending.catch(()=>{});await entered.promise;
  await replaceHeldHomeLock(target==='root'?home:join(home,'credentials'));
  const before=snapshot(home);resume.resolve();
  await assert.rejects(pending,refused);assert.equal(snapshot(home)===before,true);
});
for(const target of ['root','credentials'] as const)for(const action of ['put','revoke'] as const)test(`CredentialStore ${action} with cached master refuses ${target} loss`,async()=>{
  const home=freshDir('audit-admission-credential-cached-'),vault=await Vault.open(home,plaintextKeys());await vault.masterKey();
  const store=new CredentialStore(home,()=>vault.masterKey()),handle=await store.put('fake-only','fake label');
  await replaceHeldHomeLock(target==='root'?home:join(home,'credentials'));
  const before=snapshot(home);
  if(action==='put')await assert.rejects(store.put('replacement-fake','fake label'),refused);
  else assert.throws(()=>store.revoke(handle),refused);
  assert.equal(snapshot(home)===before,true);
});

test('retained missing master queued at the independent keys lock refuses a later root loss',async()=>{
  const home=freshDir('audit-admission-queued-'),vault=await Vault.open(home,plaintextKeys()),entered=deferred(),resume=deferred();
  const holder=withHomeLock(join(home,'keys'),async()=>{entered.resolve();await resume.promise;});await entered.promise;
  const pending=vault.masterKey();void pending.catch(()=>{});
  await replaceHeldHomeLock(home);const before=snapshot(home);resume.resolve();await holder;
  await assert.rejects(pending,refused);assert.equal(snapshot(home)===before,true);
});
for(const target of ['root','keys'] as const)test(`legacy master remains after ${target} loss between vault commit and legacy removal`,async t=>{
  const home=freshDir('audit-admission-legacy-'),vault=await Vault.open(home,plaintextKeys());
  fs.writeFileSync(join(home,'keys','master.key'),Buffer.alloc(32,9),{mode:0o600});
  const put=Vault.prototype.put;let before:string|undefined;
  t.mock.method(Vault.prototype,'put',async function(this:Vault,name:string,value:Buffer){
    await put.call(this,name,value);
    await replaceHeldHomeLock(target==='root'?home:join(home,'keys'));
    before=snapshot(home);
  });
  await assert.rejects(Vault.open(home),refused);
  assert.ok(before);assert.equal(snapshot(home)===before,true);
  assert.equal(fs.existsSync(join(home,'keys','master.key')),true);
  assert.equal(vault.get('credentials.master')?.equals(Buffer.alloc(32,9)),true,'the control commits first, then observes loss');
});
