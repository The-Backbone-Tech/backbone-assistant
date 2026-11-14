import { WorkspaceStore } from '../workspace/store.ts';
import { outsideHomeLocks } from './home-lock.ts';
const report = (error: unknown) => { process.stderr.write(`[workspace] Cleanup remains pending: ${error instanceof Error ? error.message : 'unknown error'}\n`); };
/** Called only after ownHome acquired the live-owner socket; released before that ownership ends. */
export function startWorkspaceSweep(home: string, intervalMs = 60_000, store = new WorkspaceStore(home)): () => Promise<void> {
  let stopped = false, pending: Promise<void> | undefined;
  const sweep = () => {
    if (stopped || pending) return;
    const work = outsideHomeLocks(() => store.sweep()).catch(report); pending = work;
    void work.finally(() => { pending = undefined; });
  };
  sweep(); const timer = setInterval(sweep, intervalMs); timer.unref();
  return async () => { stopped = true; clearInterval(timer); await pending; };

}
/** No Core work or home writes. Durable deletion is replayed if cleanup is interrupted. */
export function cleanThreadWorkspace(home: string, threadId: string, store = new WorkspaceStore(home)): Promise<void> {
  return outsideHomeLocks(() => store.remove(threadId)).catch(report);
}
