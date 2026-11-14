import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as harnesses from '../src/composition/harnesses.ts';

test('people and automations require a known engine that declares no native tools',()=>{
 const allowed=(harnesses as unknown as {hostToolsOnly:(id:string,manifest?:unknown)=>boolean}).hostToolsOnly;
 assert.equal(typeof allowed,'function');
 assert.equal(allowed('harness-pi',{capabilities:{nativeTools:'none'}}),true);
 for(const id of ['harness-pi','harness-codex','harness-acp','unrecognised-engine'])assert.equal(allowed(id),false,id);
 assert.equal(allowed('unrecognised-engine',{capabilities:{nativeTools:'none'}}),false);
 assert.equal(allowed('harness-pi',{capabilities:{nativeTools:'account'}}),false);
 assert.equal(allowed('harness-stub'),true);
 assert.equal(allowed('scripted'),true);
});

test('mount-only startup survives an unavailable registration without renewing any authority',async()=>{
 const {pieceOnDisk,PIECE_DIRS}=await import('../src/composition/pieces.ts');
 const {freshDir}=await import('./helpers.ts');
 const link={person:()=>({}),read:async()=>{throw new Error('Registration is temporarily unavailable');},call:async()=>assert.fail('No registration'),grantPiece:async()=>assert.fail('No renewal')} as never;
 const loaded=await harnesses.loadHarness(link,pieceOnDisk(PIECE_DIRS['harness-pi']),freshDir('mount-only-'),harnesses.HARNESSES['harness-pi'],{},[],undefined,undefined,undefined,true);
 assert.equal(loaded.registration,null);
 assert.match(loaded.engine.label,/needs a current registration/);
 assert.throws(()=>loaded.engine.start(),/signed-in owner/);
});
