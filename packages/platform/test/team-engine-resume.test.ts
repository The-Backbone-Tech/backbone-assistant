import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createIdentityHost} from '../src/composition/identity-host.ts';
import type {IdentityHostDeps} from '../src/composition/identity-host.ts';
import type {StoredThread} from '../src/composition/thread-journal.ts';
import {freshDir} from './helpers.ts';

for(const native of [true,false])for(const actor of ['device','colleague','automation'])test(`restart rechecks the current engine for ${actor}, native=${native}`,async()=>{
 const automation={id:'automation',person:'device',project:'project',mandate:'mandate',piece:null,revoked:false};
 const link={id:{workspace:'workspace',person:'device'},deviceAvailable:false,person:()=>({workspace:'workspace',principal:'device'}),legacyDeviceOnly:async()=>true,
  identities:{devicePerson:'device',requireReady(){},admitPerson:async(_person:string,work:()=>Promise<void>)=>work(),asPerson:async(_person:string,work:()=>Promise<void>)=>work(),asAutomation:async(_automation:unknown,work:()=>Promise<void>)=>work()},
  read:async(_actor:unknown,sql:string)=>({rows:sql.includes('identity_automations')?[automation]:[{access:'editor'}]}),
 };
 const adapter=createIdentityHost({home:freshDir('resume-engine-'),readOnly:false,link:async()=>link,projects:()=>[],threads:new Map(),summary:async(thread:StoredThread)=>thread.summary,material:{},piece:()=>null,nativeEngine:()=>native,emit(){},abort(){},on:()=>()=>{},dispatch:async()=>{throw new Error('No dispatch');}} as unknown as IdentityHostDeps);
 const thread={summary:{projectId:'project'},personId:actor==='colleague'?'colleague':'device',...(actor==='automation'?{automationId:'automation'}:{})} as StoredThread;
 let ran=false;const resume=()=>adapter.resumeAsActor(thread,async()=>{ran=true;});
 if(native&&actor!=='device'){await assert.rejects(resume(),/identity or project permission/);assert.equal(ran,false);}
 else{await resume();assert.equal(ran,true);}
});
