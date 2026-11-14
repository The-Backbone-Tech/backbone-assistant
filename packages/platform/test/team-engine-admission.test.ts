import assert from 'node:assert/strict';
import {test} from 'node:test';
import {nativeToolsForProject,SHARED_ENGINE_REFUSAL} from '../src/composition/engine-admission.ts';
for(const id of ['harness-codex','harness-acp','unknown'])test(`${id} checks the live audience before native tools`,async()=>{
 let checks=0;
 const link={nativeAccountToolsAllowed:async()=>{checks++;return false;}};
 const work=()=>nativeToolsForProject(id,undefined,link,'shared');
 if(id==='harness-codex')assert.equal(await work(),false);
 else await assert.rejects(work,{message:SHARED_ENGINE_REFUSAL});
 assert.equal(checks,1);
});
test('only a checked host-tools-only engine skips native account admission',async()=>{
 const link={nativeAccountToolsAllowed:async()=>{throw new Error('unexpected native admission');}};
 assert.equal(await nativeToolsForProject('harness-pi',{capabilities:{nativeTools:'none'}},link,'shared'),false);
});
