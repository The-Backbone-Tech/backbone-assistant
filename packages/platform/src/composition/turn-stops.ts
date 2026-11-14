// Only authorized dispatches enter this set. Waiting snapshots a bounded batch;
// later Stops cannot keep another thread behind a global turn admission queue.
export function pendingTurnStops(waitMs=1_000) {
 const pending=new Map<string,Set<Promise<void>>>();
 return {
  has:(id:string)=>pending.has(id),
  begin(id:string){
   let release!:()=>void;const done=new Promise<void>(resolve=>{release=resolve;});
   const batch=pending.get(id)??new Set<Promise<void>>();batch.add(done);pending.set(id,batch);
   return()=>{release();batch.delete(done);if(!batch.size&&pending.get(id)===batch)pending.delete(id);};
  },
  async wait(id:string|undefined){
   if(!id)return;const batch=[...(pending.get(id)??[])];if(!batch.length)return;
   let timer:ReturnType<typeof setTimeout>|undefined;
   try{await Promise.race([Promise.allSettled(batch),new Promise<void>(resolve=>{timer=setTimeout(resolve,waitMs);})]);}
   finally{if(timer)clearTimeout(timer);}
  },
 };
}
