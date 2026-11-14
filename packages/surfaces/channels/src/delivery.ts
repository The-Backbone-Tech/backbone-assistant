import type { Adapter } from 'chat';
import { TelegramAdapter, type TelegramAdapterConfig } from '@chat-adapter/telegram';
import { Ledger, type Provider, type DeliveryAuthority } from './ledger.ts';

class EndpointRefused extends Error {}

/** Telegram's default fetch has no deadline. Bound it without adding another send path. */
export class BoundedTelegram extends TelegramAdapter {
  private deadline: number;
  constructor(config: TelegramAdapterConfig, deadline: number) { super(config); this.deadline = deadline; }
  protected override throwTelegramApiError(method: string, status: number, data: { ok: boolean; error_code?: number; description?: string }): never {
    // The SDK otherwise wraps an explicit Telegram 5xx refusal as a generic network error.
    if (data.ok === false) throw new EndpointRefused('The endpoint refused this request.');
    return super.throwTelegramApiError(method,status,data);
  }
  protected override telegramFetch<T>(method: string, payload?: Record<string, unknown> | FormData, request?: { signal?: AbortSignal }): Promise<T> {
    return super.telegramFetch<T>(method,payload,{ signal: request?.signal ?? AbortSignal.timeout(this.deadline) });
  }
}
function refused(error: unknown): boolean {
  const e = error as { code?: string; name?: string };
  return error instanceof EndpointRefused || e?.code === 'slack_webapi_platform_error' || e?.code === 'slack_webapi_rate_limited_error' || ['AuthenticationError','PermissionError','ResourceNotFoundError','ValidationError','AdapterRateLimitError'].includes(e?.name ?? '');
}
export function deliveries(ledger: Ledger, adapters: Record<string, Adapter>) {
  let tail=Promise.resolve(),closed=false;
  const timers=new Map<string,{timer:ReturnType<typeof setTimeout>; done:Promise<void>; resolve:()=>void}>();
  function schedule(id:string){
    if(closed||timers.has(id))return;
    let resolve!:()=>void;
    const done=new Promise<void>(r=>{resolve=r;});
    const timer=setTimeout(()=>{timers.delete(id);void dispatch(id,false,true);resolve();},1000);
    timers.set(id,{timer,done,resolve});
  }
  function dispatch(id:string,allowUnbound=false,retryReady=false){
    if(closed)return Promise.resolve();
    tail=tail.then(async()=>{
      const message=ledger.outgoingMessage(id);if(!message)return;
      for(;;){
        const retryUnknown=ledger.attempts(id).includes('unknown');
        const safeNotice=message.sender!==null && (id.startsWith('intake-refused:') || id.startsWith('intake-waiting:'));
        const state=ledger.delivery(id);
        if(retryUnknown && safeNotice && state && ['unknown','failed'].includes(state.state) && state.attempts<3 && !retryReady){if(ledger.outgoing().some(m=>m.id===id))schedule(id);return;}
        const allowed=message.sender!==null&&message.generation!==null
          ? ledger.bound(message.provider,message.sender)&&ledger.bindingVersion(message.provider,message.sender)===message.generation
          : allowUnbound;
        if(!allowed){ledger.blockDelivery(id);return;}
        if(!ledger.beginDelivery(id))return;
        try{await adapters[message.provider].postMessage(message.conversation,{raw:retryUnknown&&safeNotice ? (id.startsWith('intake-waiting:') ? 'This message is kept and will run when the cause clears.' : 'This message could not be taken.') : message.text});ledger.finishDelivery(id,'delivered');}
        catch(e){ledger.finishDelivery(id,refused(e)?'failed':'unknown');}
        // Each retry after an unknown gets its own queue turn and delay.
        retryReady=false;
      }
    });return tail;
  }
  return {
    post(id:string,provider:Provider,conversation:string,text:string,authority?:DeliveryAuthority){
      const created=ledger.createDelivery(id,provider,conversation,text,authority);
      // A refusal is authorized only by this live inbound request, never by restart.
      return dispatch(id,created&&!authority);
    },
    replay:(id:string)=>dispatch(id),
    async idle(){
      for(;;){const current=tail;await current;if(timers.size)await Promise.all([...timers.values()].map(t=>t.done));else if(current===tail)return;}
    },
    async close(){
      closed=true;
      for(const t of timers.values()){clearTimeout(t.timer);t.resolve();}
      timers.clear();await tail;
    }
  };
}
