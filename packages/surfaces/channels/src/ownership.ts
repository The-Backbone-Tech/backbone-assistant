import { secureChannelsHome } from './home.ts';
import { join, resolve } from 'node:path';
import { withHomeLock } from '@backbone-next/platform/composition/home-lock';

const active = new Set<string>();
/** One service owns recovery. CLI journal operations use their own SQLite transactions. */
export async function ownService<T extends { close(): Promise<void> }>(home: string, start: () => Promise<T>): Promise<T> {
  secureChannelsHome(home);
  const key = resolve(home);
  if (active.has(key)) throw new Error('The channel service already runs for this home.');
  active.add(key);
  let ready!: (service: T) => void, failed!: (e: unknown) => void, finish!: () => void;
  const result = new Promise<T>((r,j)=>{ready=r;failed=j;});
  const lifetime = new Promise<void>(r=>{finish=r;});
  const held = withHomeLock(join(home,'channels','service'),async lost=>{
    const service = await start();
    let closed: Promise<void> | undefined;
    const close = () => closed ??= (async()=>{try {await service.close();}finally {finish();}})();
    lost.addEventListener('abort',()=>{void close();},{once:true});
    ready({...service,close:async()=>{await close();await held;}});
    await lifetime;
  },0).finally(()=>active.delete(key));
  void held.catch(failed);
  return result;
}
