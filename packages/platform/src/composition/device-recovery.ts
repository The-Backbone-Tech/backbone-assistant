// Only native main receives these controls. They are absent from Method and from
// every transport; the renderer's main-process window binding supplies admission.
import type {CoreLink} from './core.ts';
import type {Host} from './host-types.ts';
export function deviceRecoveryControls(deps:{core():Promise<CoreLink>;ready():Promise<void>;writable():boolean;inflight:Set<Promise<unknown>>}):Pick<Host,'deviceRecoveryStatus'|'restoreDeviceAccess'>{
 const track=<T>(work:()=>Promise<T>):Promise<T>=>{
  const job=work();deps.inflight.add(job);
  void job.finally(()=>deps.inflight.delete(job)).catch(()=>{});return job;
 };
 return {
  deviceRecoveryStatus:()=>track(async()=>{
   const result=await(await deps.core()).deviceRecoveryStatus();
   return {...result,available:deps.writable()&&result.available};
  }),
  restoreDeviceAccess:(signal)=>track(async()=>{
   signal?.throwIfAborted();
   if(!deps.writable())throw new Error('Device recovery requires the writable local Host.');
   await deps.ready();const link=await deps.core();
   if(!deps.writable())throw new Error('The local Host closed before recovery.');
   signal?.throwIfAborted();
   await link.restoreDeviceAccess(signal);
  }),
 };
}
