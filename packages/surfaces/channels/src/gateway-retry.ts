/** Keep a revoked credential from causing a tight login loop or a line per retry. */
export function gatewayRetry(baseMs=1000){
 const base=Number.isFinite(baseMs)?Math.max(1,Math.min(baseMs,60_000)):1000;
 let failures=0,pending=0,lastNotice:number|undefined;
 return {
  failed(now=Date.now()){
   failures++;pending++;
   const waitMs=Math.min(60_000,base*2**Math.min(failures-1,30));
   let notice:string|undefined;
   if(lastNotice===undefined||now-lastNotice>=300_000){
    notice=lastNotice===undefined?'channels: Discord Gateway is unavailable; retrying with backoff.':
     'channels: Discord Gateway remains unavailable ('+pending+' failed attempts since the last report); retrying with backoff.';
    lastNotice=now;pending=0;
   }
   return {waitMs,notice};
  },
  recovered(){
   if(!failures)return;
   failures=0;pending=0;lastNotice=undefined;
   return 'channels: Discord Gateway listener period ended; renewing.';
  }
 };
}
