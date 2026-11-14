import assert from 'node:assert/strict';
import {test} from 'node:test';
import {settleSharedSend} from '../src/lib/shared-send-recovery.ts';

test('an unseen lost reply stays unknown; a matching turn releases draft and vault without resending',async()=>{
  const actions:string[]=[];let observed=false;
  const ports={find:async(key:string)=>{actions.push(`read:${key}`);return observed?'thread':undefined;},release:async(key:string)=>{actions.push(`release:${key}`);},clear:async()=>{actions.push('clear');}};
  assert.equal(await settleSharedSend('lost',false,ports),undefined);assert.deepEqual(actions,['read:lost']);
  observed=true;assert.equal(await settleSharedSend('lost',false,ports),'thread');assert.deepEqual(actions,['read:lost','read:lost','release:lost','clear']);
});
test('the person’s inspection releases an unknown send without a retry or a success claim',async()=>{
  const actions:string[]=[];
  assert.equal(await settleSharedSend('lost',true,{find:async()=>{throw new Error('No automatic conclusion');},release:async()=>{actions.push('release');},clear:async()=>{actions.push('clear');}}),null);
  assert.deepEqual(actions,['release','clear']);
});
test('failed reservation release retains the saved unknown draft',async()=>{
  await assert.rejects(settleSharedSend('lost',true,{find:async()=>undefined,release:async()=>{throw new Error('vault unavailable');},clear:async()=>{assert.fail('Must retain the draft');}}),/vault unavailable/);
});
