import assert from 'node:assert/strict';
import {test} from 'node:test';
import {HomeOwned} from '@backbone-next/platform/composition';
import {HomeBusy} from '@backbone-next/platform/composition/home-lock';
import {RemoteError} from '@backbone-next/platform/remote/client';
import {callFromRenderer} from '../electron/renderer-api.ts';

const failing=(error:Error)=>({call:async()=>{throw error;}});
for(const error of [new HomeOwned('held'),new HomeBusy('busy'),Object.assign(new Error('Access ended'),{name:'IdentityRefused'}),new RemoteError('Refused by workspace','REFUSED')])test(`project refusal survives the page transport (${error.constructor.name}/${error.name})`,async()=>{
  const result=await callFromRenderer(failing(error),'projects.update',{id:'p',patch:{archived:true}});
  assert.equal((result as {outcome:string}).outcome,'REFUSED');
});
for(const error of [new RemoteError('Lost response','UNKNOWN'),new Error('Lost response mentioning IdentityRefused')])test(`unconfirmed project errors remain unknown (${error.message})`,async()=>{
  await assert.rejects(callFromRenderer(failing(error),'projects.update',{id:'p',patch:{archived:true}}),candidate=>candidate===error);
});
test('the project error adapter does not relabel other operations',async()=>{
  const error=new HomeBusy('busy');await assert.rejects(callFromRenderer(failing(error),'turns.send',{}),candidate=>candidate===error);
});
