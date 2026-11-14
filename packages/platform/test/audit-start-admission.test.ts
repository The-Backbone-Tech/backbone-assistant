import { hangDetector } from '../../../scripts/lib/test-hang.ts';
// A preparation refusal closes the captured link, not just its rejected startup promise.
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {createConnection} from 'node:net';
import {join} from 'node:path';
import {test} from 'node:test';
import {CoreLink} from '../src/composition/core.ts';
import {createHost,hostClosed} from '../src/composition/host.ts';
import {Vault,writePlaintextVault} from '../src/keys/vault.ts';
import {freshDir} from './helpers.ts';
import {replaceHeldHomeLock} from './native-lock-observation.ts';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
const reachable=(port:number)=>new Promise<boolean>(resolve=>{const socket=createConnection({host:'127.0.0.1',port});socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));});
for(const loss of [false,true])test(`failed master preparation closes link, close cache and owned server (root loss=${loss})`,{timeout:600_000},async t=>{
  const home=freshDir('audit-start-admission-');writePlaintextVault(home);
  let opened:CoreLink|undefined;const open=CoreLink.open;
  t.mock.method(CoreLink,'open',async (options:Parameters<typeof CoreLink.open>[0])=>{opened=await open.call(CoreLink,options);return opened;});
  const master=Vault.prototype.masterKey,close=CoreLink.prototype.close,closing=deferred(),resume=deferred();let closes=0;
  const masterMock=t.mock.method(Vault.prototype,'masterKey',async function(this:Vault){
    if(loss){await replaceHeldHomeLock(home);return master.call(this);}
    throw new Error('FAKE-PRIVATE-key-provider-detail');
  });
  const closeMock=t.mock.method(CoreLink.prototype,'close',async function(this:CoreLink){closes++;closing.resolve();await resume.promise;await close.call(this);});
  const host=createHost({home,harness:'harness-stub'});t.after(()=>host.close());
  const pending=host.call('projects.list',{});void pending.catch(()=>{});
  try{
    // The race asserts ordering; the shared three-minute detector only diagnoses a hang under load.
    const outcome=await hangDetector(Promise.race([closing.promise.then(()=> 'closing'),pending.then(()=> 'started',()=> 'refused-before-close')]), 'CoreLink.close entry or startup refusal', {diagnostic:()=>JSON.stringify({loss,closes,linkOpened:!!opened,coreClosePending:!!CoreLink.pendingClose(home)})});
    assert.equal(outcome,'closing');
    const {port}=JSON.parse(readFileSync(join(home,'pg','cluster.json'),'utf8')) as {port:number};assert.equal(await reachable(port),true);
    resume.resolve();
    await assert.rejects(pending,error=>error instanceof Error&&error.message==="This home's keys could not be prepared; nothing was started.");
    host.close();await hangDetector(hostClosed(home), 'hostClosed(home)', {diagnostic:()=>JSON.stringify({loss,closes,coreClosePending:!!CoreLink.pendingClose(home)})});
    assert.equal(closes,1);assert.equal(CoreLink.pendingClose(home),undefined);await hangDetector(CoreLink.whenClosed(home), 'CoreLink.whenClosed(home)');
    assert.equal(await reachable(port),false);assert.equal(existsSync(join(home,'pg','data','postmaster.pid')),false);
    closeMock.mock.restore();masterMock.mock.restore();
    if(!loss){
      const next=createHost({home,harness:'harness-stub'});
      try{assert.deepEqual(await hangDetector(next.call('projects.list',{}), 'reopened Host projects.list'),[]);}finally{next.close();await hangDetector(hostClosed(home), 'hostClosed(home)', {diagnostic:()=>JSON.stringify({loss,closes,coreClosePending:!!CoreLink.pendingClose(home)})});}
    }
  }finally{
    resume.resolve();host.close();await hostClosed(home);
    // On a deliberately failing mutation, still stop the link the old startup leaked.
    if(!closes&&opened)await close.call(opened);
  }
});
