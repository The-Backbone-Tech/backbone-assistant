// Retry only the explicit slot refusal: it confirms that no export session was created.
import {AUDIT_SLOT_BUSY} from '@backbone-next/platform/audit';
import type {Receipt} from '@backbone-next/platform';
export async function waitForAuditSlot<T>(call:()=>Promise<Receipt<T>>,waiting:()=>void,
  limits={waitMs:180000,retryMs:500},clock={now:()=>Date.now(),sleep:(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms))}):Promise<Receipt<T>>{
  const end=clock.now()+limits.waitMs;let announced=false;
  for(;;){
    const result=await call();
    if(result.ok||result.detail!==AUDIT_SLOT_BUSY)return result;
    if(!announced){waiting();announced=true;}
    const left=end-clock.now();
    if(left<=0)throw new Error('The holder audit slot did not become free within 3 minutes; retry later.');
    await clock.sleep(Math.min(limits.retryMs,left));
  }
}
