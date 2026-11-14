import {randomBytes} from 'node:crypto';
import type {WorkNow} from '@backbone-next/platform';
import type {ChannelHost,Conversation} from './host-consumer.ts';
import type {Inbound,Ledger,Provider,DeliveryAuthority} from './ledger.ts';

type ReadChoice=WorkNow['needsYou'][number];
type Card={code:string;observation:string;thread:string;provider:Provider;conversation:string;sender:string;generation:number;state:'pending'|'sending'|'answered'|'unknown'};
type Post=(id:string,provider:Provider,conversation:string,text:string,authority?:DeliveryAuthority)=>Promise<void>;
/** These are person commands on retained reads, never model instructions or provider calls. */
export function channelDecisions(host:ChannelHost,ledger:Ledger,projectId:string,post:Post){
 const cards=()=>ledger.get<Card[]>('read-decisions')??[];
 const save=(card:Card)=>ledger.set('read-decisions',[...cards().filter(c=>c.code!==card.code),card]);
 const current=(c:Conversation)=>c.direct&&ledger.bound(c.provider,c.sender)&&ledger.bindingVersion(c.provider,c.sender)===c.bindingVersion;
 return {
  prune(c?:Conversation,choices:readonly ReadChoice[]=[]){
   const before=cards();
   const remaining=before.filter(card=>{
    if(!ledger.bound(card.provider,card.sender)||ledger.bindingVersion(card.provider,card.sender)!==card.generation)return false;
    if(!c||card.provider!==c.provider||card.conversation!==c.conversation||card.sender!==c.sender)return true;
    if(card.thread!==c.threadId)return false;
    // Keep uncertain attempts while Needs you still lists the read. Forgetting one
    // there could mint a fresh code and repeat an unconfirmed choice after restart.
    return choices.some(choice=>choice.kind==='connector-read'&&choice.observationId===card.observation&&choice.threadId===card.thread);
   });
   if(remaining.length!==before.length)ledger.set('read-decisions',remaining);
  },
  async offer(c:Conversation,choice:ReadChoice){
   if(choice.kind!=='connector-read'||!choice.observationId||choice.threadId!==c.threadId||!current(c))return;
   let card=cards().find(v=>v.observation===choice.observationId&&v.provider===c.provider&&v.conversation===c.conversation&&v.sender===c.sender&&v.generation===c.bindingVersion);
   if(!card){card={code:randomBytes(16).toString('hex'),observation:choice.observationId,thread:c.threadId,provider:c.provider,conversation:c.conversation,sender:c.sender,generation:c.bindingVersion,state:'pending'};save(card);}
   if(card.state!=='pending')return;
   await post(`connector-read:${card.observation}`,c.provider,c.conversation,
    `A connector read needs your decision. Open the app and go to Needs you in this project.\n${choice.title}\n${choice.detail}\nReply /decision ${card.code} discard to discard this read from agent use.${choice.canReconcile?` Or reply /decision ${card.code} reconcile to register its retained response.`:''} You can also decide in Needs you. Neither choice sends the connector call again.`,
    {sender:c.sender,generation:c.bindingVersion});
  },
  async consume(m:Inbound):Promise<boolean>{
   if(!/^\/decision(?:\s|$)/i.test(m.text.trim()))return false;
   const match=m.text.trim().match(/^\/decision ([a-f0-9]{32}) (discard|reconcile)$/i);
   const reply=(text:string)=>post(`decision-reply:${m.provider}:${m.id}`,m.provider,m.conversation,text,{sender:m.sender,generation:m.bindingVersion!});
   const card=match&&cards().find(c=>c.code===match[1].toLowerCase()&&c.provider===m.provider&&c.conversation===m.conversation&&c.sender===m.sender&&c.generation===m.bindingVersion);
   if(!card||!ledger.bound(m.provider,m.sender)||ledger.bindingVersion(m.provider,m.sender)!==m.bindingVersion){await reply('Use the decision command shown in this chat, or open Needs you.');return true;}
   if(card.state!=='pending'){await reply(card.state==='answered'?'This decision was already answered.':'This decision attempt has no confirmed reply. Check Needs you; it will not be repeated automatically.');return true;}
   const thread=await host.call('threads.get',{id:card.thread});
   if(!thread.ok||thread.value.summary.running){await reply('Wait for this chat to stop, then check Needs you.');return true;}
   const now=await host.call('work.now',{projectId});
   const choice=now.needsYou.find(c=>c.kind==='connector-read'&&c.observationId===card.observation&&c.threadId===card.thread);
   if(!choice){await reply('This read no longer needs a decision. Check Needs you for its current state.');return true;}
   const verdict=match![2].toLowerCase() as 'discard'|'reconcile';
   if(verdict==='reconcile'&&!choice.canReconcile){await reply('This read cannot be reconciled now. Check Needs you, or discard it from agent use.');return true;}
   if(!ledger.bound(m.provider,m.sender)||ledger.bindingVersion(m.provider,m.sender)!==m.bindingVersion)return true;
   // Persist intent before crossing. A crash or lost acknowledgement must not resend a choice.
   save({...card,state:'sending'});
   try{
    const result=await host.call('connectors.resolveRead',{id:card.observation,verdict});
    save({...card,state:result.ok?'answered':result.outcome==='UNKNOWN'?'unknown':'pending'});
    await reply(result.ok?`Read ${result.value.state}. The connector call was not sent again.`:result.outcome==='UNKNOWN'?'The decision outcome is unknown. Check Needs you before taking another action.':'The decision was refused. Check Needs you for its current state.');
   }catch{save({...card,state:'unknown'});await reply('The decision outcome is unknown. Check Needs you before taking another action.');}
   return true;
  }
 };
}
