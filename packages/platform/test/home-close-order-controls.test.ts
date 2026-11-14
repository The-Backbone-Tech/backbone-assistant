import { hangDetector } from '../../../scripts/lib/test-hang.ts';
// Baseline negative controls for R1. Native Core ordering runs; Vault never opens a database.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import {observeNativeHomeLocks} from './native-lock-observation.ts';
import {CoreLink} from '../src/composition/core.ts';
import {withHomeLock} from '../src/composition/home-lock.ts';
import {Vault} from '../src/keys/vault.ts';

function context(t:TestContext){const home=mkdtempSync(join(tmpdir(),'backbone-close-control-'));t.after(()=>rmSync(home,{recursive:true,force:true}));return home;}
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};

test('a completed historical close does not prevent Core open under the home lock',async t=>{
 const home=context(t),sentinel=new Error('Controlled Vault boundary');let closes=0,vaults=0;
 t.mock.method(Vault,'open',async()=>{vaults++;throw sentinel;});
 const finalLink={close:async()=>{closes++;}} as unknown as CoreLink;
 CoreLink.closeWhenOpen(home,Promise.resolve(finalLink));await CoreLink.whenClosed(home);
 await withHomeLock(home,async()=>assert.rejects(CoreLink.open({home}),error=>error===sentinel));
 assert.equal(closes,1);assert.equal(vaults,1);
});

test('a captured failed close propagates while later opens and closes inspect independently',async t=>{
 const home=context(t),failure=new Error('Synthetic failed Core close'),sentinel=new Error('Fresh inspection reached Vault'),release=deferred();let vaults=0;
 t.mock.method(Vault,'open',async()=>{vaults++;throw sentinel;});
 const finalLink={close:async()=>{await release.promise;throw failure;}} as unknown as CoreLink;
 CoreLink.closeWhenOpen(home,Promise.resolve(finalLink));
 const first=CoreLink.open({home});const refused=assert.rejects(first,error=>error===failure);
 release.resolve();await refused;await assert.rejects(CoreLink.whenClosed(home),error=>error===failure);
 assert.equal(vaults,0,'an opener that captured the pending failure performs no Vault/DB operation');
 await withHomeLock(home,async()=>assert.rejects(CoreLink.open({home}),error=>error===sentinel));
 assert.equal(vaults,1,'a later opener independently rechecks this home');
 let closedAgain=0;
 CoreLink.closeWhenOpen(home,Promise.resolve({close:async()=>{closedAgain++;}} as unknown as CoreLink));
 await CoreLink.whenClosed(home);assert.equal(closedAgain,1,'a later close does not inherit predecessor rejection');
});

test('an open never waits for a later close that joins that same open', {timeout:240_000},async t=>{
 const home=context(t),sentinel=new Error('Controlled Vault boundary'),claimStarted=deferred(),emergencyCleanup=deferred();
 let closes=0;
 t.mock.method(Vault,'open',async()=>{throw sentinel;});
 observeNativeHomeLocks(t,home,claimStarted.resolve);
 const opened=CoreLink.open({home}).then(()=>null,error=>error);
 await claimStarted.promise;
 const finalLink={close:async()=>{closes++;}} as unknown as CoreLink;
 CoreLink.closeWhenOpen(home,Promise.race([opened,emergencyCleanup.promise]).then(()=>finalLink));

 try{
  const outcome=await hangDetector(opened,'Core open before the later close that joins it');
  assert.equal(outcome,sentinel);await CoreLink.whenClosed(home);assert.equal(closes,1);
 }finally{emergencyCleanup.resolve();await Promise.allSettled([opened,CoreLink.whenClosed(home)]);}
});
