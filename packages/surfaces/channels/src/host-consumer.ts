import { channelDecisions } from './decisions.ts';
import { join } from 'node:path';
import { withHomeLock } from '@backbone-next/platform/composition/home-lock';
import type { Args, ApiEvent, Method, Result, TurnSettings } from '@backbone-next/platform';
import type { IntakeResult } from './intake.ts';
import type { Ledger, Inbound, Provider, DeliveryAuthority } from './ledger.ts';

export interface ChannelHost {
  call<M extends Method>(method: M, args: Args<M>): Promise<Result<M>>;
  on(listener: (event: ApiEvent) => void): () => void;
}
export interface Conversation { provider: Provider; conversation: string; sender: string; threadId: string; bindingVersion:number; direct:true }
interface Consumption extends IntakeResult { notice?:{id:string;text:string} }
function invalidHostError(error:unknown):string|undefined {
  if(!(error instanceof Error))return;
  const reason=(error as Error&{reason?:unknown}).reason;
  // CoreRefusal preserves the crossing's reason; PostgreSQL invalid exceptions use
  // this exact leading word. Paused/stale/transport errors do not prove invalid input.
  return reason==='invalid'||(reason===undefined&&error.message.startsWith('invalid:'))?error.message:undefined;
}
export function hostConsumer(host: ChannelHost, ledger: Ledger, config: { home: string; projectId: string; settings: TurnSettings }, post: (id: string, provider: Provider, conversation: string, text: string, authority?:DeliveryAuthority) => Promise<void>, stopped: () => boolean) {
  const decisions=channelDecisions(host,ledger,config.projectId,post);
  const conversations = () => ledger.get<Conversation[]>('conversations') ?? [];
  const drop = (c:Conversation) => ledger.set('conversations',conversations().filter(v=>v.threadId!==c.threadId));
  function refuse(m:Inbound,reason:string,detail:string):Consumption{
    if(!ledger.refuseIntake(m,reason,detail))return {done:false};
    return {done:true,notice:{id:`intake-refused:${m.provider}:${m.id}`,text:`This message could not be taken: ${detail}`}};
  }
  async function sync() {
    decisions.prune();
    for (const c of conversations()) {
      if (!c.direct || !ledger.bound(c.provider,c.sender) || c.bindingVersion!==ledger.bindingVersion(c.provider,c.sender)) continue;
      try {
      const view = await host.call('threads.get',{id:c.threadId});
      if (!view.ok) continue;
      const authority={sender:c.sender,generation:c.bindingVersion};
      for (const turn of view.value.turns) {
        const notice=()=>post(`notice:${turn.id}:${turn.status}`,c.provider,c.conversation,turn.withheld?'The answer was withheld because its source changed.':turn.answer?.text||turn.refusal?.detail||turn.failure?.detail||`Work ${turn.status}.`,authority);
        if(turn.status!=='running'&&turn.status!=='done')await notice();
        for(const [n,step] of turn.work.steps.entries()) {
          if(step.kind==='note'&&!turn.completed)continue;
          if(step.label.length>(c.provider==='telegram'?4096:4000))continue;
          await post(`progress:${turn.id}:${n}`,c.provider,c.conversation,step.label,authority);
        }
        if(turn.status==='running'||(turn.status==='done'&&!turn.completed))continue;
        if(turn.completed&&turn.status==='done'&&turn.answer&&!turn.withheld)await post(`answer:${turn.id}`,c.provider,c.conversation,turn.answer.text,authority);
        else if(turn.status==='done')await notice();
      }
      } catch { /* The next Host event or intake retry rechecks this conversation. */ }
    }
    const bound=conversations().filter(c=>c.direct&&ledger.bound(c.provider,c.sender)&&c.bindingVersion===ledger.bindingVersion(c.provider,c.sender));
    for(const c of bound){
      const thread=await host.call('threads.get',{id:c.threadId});
      if(!thread.ok){if(thread.reason==='NOT_FOUND')decisions.prune(c,[]);continue;}
      if(thread.value.summary.running)continue;
      // Read the decisions after verifying the thread stopped: a successful read may
      // have finished between projections and must not leave a stale notice.
      const now=await host.call('work.now',{projectId:config.projectId});
      decisions.prune(c,now.needsYou);
      for(const decision of now.needsYou){
        if(decision.kind!=='connector-read'||!decision.observationId||decision.threadId!==c.threadId)continue;
        await decisions.offer(c,decision);
      }
    }
  }
  return { sync, async consume(m: Inbound):Promise<IntakeResult> {
    if(await decisions.consume(m))return {done:true};
    let known = conversations().find(c=>c.provider===m.provider&&c.conversation===m.conversation&&c.sender===m.sender);
    if(known&&(!known.direct||known.bindingVersion!==m.bindingVersion)){drop(known);known=undefined;}
    if (known) {
      const t=await host.call('threads.get',{id:known.threadId});
      if (!t.ok) {
        if(t.reason==='NOT_FOUND'){drop(known);known=undefined;}
        else return {done:false};
      } else if(t.value.summary.running) return {done:false,busy:true};
    }
    if (stopped()) return {done:false,busy:true};
    const result=await withHomeLock<Consumption>(join(config.home,'channels','authority'),async()=>{
      if (stopped()) return {done:false,busy:true};
      if (!ledger.bound(m.provider,m.sender) || m.bindingVersion!==ledger.bindingVersion(m.provider,m.sender)) return {done:true};
      let sent:Result<'turns.send'>;
      try{sent=await host.call('turns.send',{projectId:config.projectId,threadId:known?.threadId,text:m.text,attachments:[],settings:config.settings,clientKey:`channel:${m.provider}:${m.id}`});}
      catch(error){const detail=invalidHostError(error);if(detail===undefined){const text='This message is kept and will run when the cause clears.';return ledger.waitIntake(m,'',text)?{done:false,notice:{id:`intake-waiting:${m.provider}:${m.id}`,text}}:{done:false};}return refuse(m,'INVALID',detail);}
      if (!sent.ok) {
        if((sent.reason==='NOT_FOUND'||sent.reason==='INVALID')&&known){drop(known);return {done:false};}
        if(sent.reason==='NOT_AVAILABLE'&&sent.outcome==='REFUSED'&&ledger.waitIntake(m,sent.detail))return {done:false,notice:{id:`intake-waiting:${m.provider}:${m.id}`,text:`This message is kept and will run when the cause clears: ${sent.detail}`}};
        if(sent.outcome==='REFUSED'&&sent.reason!=='NOT_AVAILABLE')return refuse(m,sent.reason,sent.detail);
        return {done:false};
      }
      if (!known) ledger.set('conversations',[...conversations(),{provider:m.provider,conversation:m.conversation,sender:m.sender,threadId:sent.value.threadId,bindingVersion:m.bindingVersion!,direct:true}]);
      return {done:true};
    });
    // Dispatch never owns the admission lock: a silent provider cannot delay revocation.
    if(result.notice)await post(result.notice.id,m.provider,m.conversation,result.notice.text,{sender:m.sender,generation:m.bindingVersion!});
    return {done:result.done,busy:result.busy};
  }};
}
