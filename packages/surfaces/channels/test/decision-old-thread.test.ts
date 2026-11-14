import '../../../../scripts/lib/test-local-network.cjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../src/ledger.ts';
import {channelDecisions} from '../src/decisions.ts';
import type {ChannelHost,Conversation} from '../src/host-consumer.ts';

test('a new conversation thread prunes earlier-thread cards without erasing other conversations',async()=>{
 const home=mkdtempSync(join(tmpdir(),'decision-old-thread-')),ledger=new Ledger(home);
 ledger.pair('teams','tenant:person',ledger.invite());
 const c:Conversation={provider:'teams',conversation:'private',sender:'tenant:person',threadId:'old-thread',bindingVersion:ledger.bindingVersion('teams','tenant:person'),direct:true};
 const choice={kind:'connector-read',threadId:'old-thread',observationId:'old-read',title:'Retained read',detail:'One response',canReconcile:true} as const;
 const host:ChannelHost={on:()=>()=>{},call:async()=>{throw new Error('No crossing expected');}};
 const decisions=channelDecisions(host,ledger,'project',async()=>{});
 try{
  await decisions.offer(c,choice);await decisions.offer({...c,conversation:'other'},choice);
  decisions.prune({...c,threadId:'new-thread'},[choice]);
  const cards=ledger.get<{conversation:string}[]>('read-decisions')!;
  assert.equal(cards.length,1);assert.equal(cards[0].conversation,'other');
 }finally{ledger.close();rmSync(home,{recursive:true,force:true});}
});
