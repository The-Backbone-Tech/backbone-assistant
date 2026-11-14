import { setTimeout as delay } from 'node:timers/promises';
import type { Ledger, Inbound } from './ledger.ts';
export interface IntakeResult { done: boolean; busy?: boolean }

/** Each conversation keeps its order; a refusal never owns another conversation's worker. */
export function intakeWorkers(ledger: Ledger, handle: (m: Inbound) => Promise<IntakeResult>, report: (text: string) => void, baseMs = 100) {
  const stop=new AbortController(), workers=new Map<string,Promise<void>>();
  function kick() {
    if(stop.signal.aborted)return;
    for(const lane of ledger.pendingConversations()){
      const key=JSON.stringify([lane.provider,lane.conversation]);
      if(workers.has(key))continue;
      const work=(async()=>{
        let failures=0,reported=false;
        while(!stop.signal.aborted){
          const m=ledger.pendingHead(lane.provider,lane.conversation);if(!m)return;
          let result:IntakeResult;
          try{result=await handle(m);}catch{result={done:false};}
          if(stop.signal.aborted)return;
          if(result.done){ledger.finishIntake(m.seq);failures=0;reported=false;continue;}
          if(!result.busy && ++failures>=3 && !reported){report(`channels: ${lane.provider} work is waiting for the Host; intake is retained and retries continue.`);reported=true;}
          await delay(Math.min(2000,baseMs*2**Math.min(failures,5)),undefined,{signal:stop.signal}).catch(()=>{});
        }
      })().catch(()=>{report(`channels: ${lane.provider} intake could not be processed; its journal needs attention.`);}).finally(()=>workers.delete(key));
      workers.set(key,work);
    }
  }
  return {kick,async idle(){while(workers.size)await Promise.all([...workers.values()]);},async close(){stop.abort();await Promise.all([...workers.values()]);}};
}
