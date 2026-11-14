import {AsyncLocalStorage} from 'node:async_hooks';
import {canonicalHome} from '../doors/protocol.ts';
// A local resource can move while admission awaits Core or a home lock. Recheck
// its identity under the acquired lock; detached work receives no stale grant.
const scope=new AsyncLocalStorage<{home:string;active:boolean;check():void}>();
export function checkIdentityLocal(home:string){const current=scope.getStore();if(current?.active&&current.home===canonicalHome(home))current.check();}
export async function withIdentityLocal<T>(home:string,check:()=>void,work:()=>Promise<T>):Promise<T>{
 const current={home:canonicalHome(home),active:true,check};
 try{return await scope.run(current,work);}finally{current.active=false;}
}
