import { AsyncLocalStorage } from 'node:async_hooks';
import type { Args, Method, Result } from '../api.ts';
import { pendingTurnStops } from './turn-stops.ts';
import { turnAdmissions } from './turn-admission.ts';

interface RequestDeps {
  home: string;
  stopMark(id: string): number;
  call<M extends Method>(session: string | undefined, method: M, args: Args<M>): Promise<Result<M>>;
  enter(method: Method): void;
  leave(): void;
  closing(): boolean;
}

/** Authentication and turn preparation leave capacity for an authorized Stop. */
export function identityRequests(deps: RequestDeps) {
  const requestedStop = new AsyncLocalStorage<number>();
  const stoppingRequests = pendingTurnStops();
  const inStartRequest = new AsyncLocalStorage<{ active: boolean }>();
  const serializeRequest = turnAdmissions(deps.home);
  // Route probes run outside this queue; their final reservation still serializes.
  const startsTurn = new Set<Method>(['turns.send', 'children.merge', 'queue.send', 'goals.run', 'goals.resume', 'schedules.run', 'identity.automation.run']);
  // Capture the generation before authentication, but only an authorized dispatch
  // can register a Stop. Wait for one bounded batch before joining either queue.
  const activeRequests=new Set<Promise<unknown>>();
  const invoke=async<M extends Method>(session:string|undefined,method:M,args:Args<M>):Promise<Result<M>>=>{
    deps.enter(method);
    try{
    // A child start is stopped through its parent: capture the parent's generation too.
    const id=(args as {threadId?:string})?.threadId??(method==='children.start'?(args as {parentThreadId?:string})?.parentThreadId:undefined);
    return await requestedStop.run(id?deps.stopMark(id):0,async()=>{
      if(!startsTurn.has(method))return deps.call(session,method,args);
      await stoppingRequests.wait(id);
      return serializeRequest(async()=>{
        const queued={active:true};
        try{return await inStartRequest.run(queued,()=>deps.call(session,method,args));}
        finally{queued.active=false;}
      });
    });
    }catch(error){
      // An already admitted side question keeps its own closing receipt even
      // when identity lookup yields before it reaches the local reservation.
      if(method==='sidechat.ask'&&deps.closing())return { ok: false, reason: 'NOT_AVAILABLE', outcome: 'REFUSED', detail: 'This app is closing; nothing was read, changed, signed or sent.' } as Result<M>;
      throw error;
    }finally{deps.leave();}
  };
  const request=<M extends Method>(session:string|undefined,method:M,args:Args<M>):Promise<Result<M>>=>{
    const job=invoke(session,method,args);activeRequests.add(job);
    void job.finally(()=>activeRequests.delete(job)).catch(()=>{});return job;
  };
  return { requestedStop, stoppingRequests, inStartRequest, activeRequests, request };
}
