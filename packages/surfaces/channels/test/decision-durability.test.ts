import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Ledger} from '../src/ledger.ts';
import {channelDecisions} from '../src/decisions.ts';
import type {ChannelHost,Conversation} from '../src/host-consumer.ts';

for(const mode of ['unknown','reconcile','revoked'] as const)test(`a channel decision ${mode} keeps its exact scope and does not replay an uncertain crossing`,async()=>{
 const home=mkdtempSync(join(tmpdir(),'channel-choice-'));let ledger=new Ledger(home),calls=0;
 const posts:string[]=[];
 ledger.pair('teams','tenant:person',ledger.invite());
 const generation=ledger.bindingVersion('teams','tenant:person');
 const conversation:Conversation={provider:'teams',conversation:'teams:private',sender:'tenant:person',threadId:'original-thread',bindingVersion:generation,direct:true};
 const choice={kind:'connector-read',threadId:'original-thread',observationId:'original-observation',title:'Retained read',detail:'One response',canReconcile:true} as const;
 const host:ChannelHost={on:()=>()=>{},async call(method,args){
  if(method==='threads.get')return {ok:true,value:{summary:{running:false}}} as never;
  if(method==='work.now'){if(mode==='revoked')ledger.unbind('teams','tenant:person');return {needsYou:[choice]} as never;}
  if(method==='connectors.resolveRead'){calls++;assert.deepEqual(args,{id:'original-observation',verdict:mode==='reconcile'?'reconcile':'discard'});if(mode==='unknown')throw new Error('Synthetic lost acknowledgement');return {ok:true,value:{id:'original-observation',state:'reconciled'}} as never;}
  throw new Error('Unexpected Host method');
 }};
 const post=async(_id:string,_provider:unknown,_conversation:string,text:string)=>{posts.push(text);};
 try{
  let decisions=channelDecisions(host,ledger,'project',post);await decisions.offer(conversation,choice);
  const code=posts[0].match(/\/decision ([a-f0-9]{32}) discard/)?.[1];assert.ok(code);
  const message={provider:'teams',id:'person-reply',conversation:'teams:private',sender:'tenant:person',bindingVersion:generation,direct:true,text:`/decision ${code} ${mode==='reconcile'?'reconcile':'discard'}`} as const;
  await decisions.consume(message);
  ledger.close();ledger=new Ledger(home);decisions=channelDecisions(host,ledger,'project',post);
  await decisions.consume({...message,id:'duplicate'});
  assert.equal(calls,mode==='revoked'?0:1);
  if(mode==='unknown')assert.ok(posts.at(-1)?.includes('will not be repeated'));
 }finally{ledger.close();rmSync(home,{recursive:true,force:true});}
});
