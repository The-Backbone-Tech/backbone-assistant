import type { Method } from '../api.ts';
import type { StoredThread } from './thread-journal.ts';

/** Every turn, including an automation, can write project files. Other projects stay usable. */
export function rewindAdmission(threads: Iterable<StoredThread>, projectId: string, threadId?: string): string | undefined {
  const held = [...threads].find(thread => thread.rewindPending && (thread.summary.id === threadId || thread.summary.projectId === projectId));
  return held && rewindNotice(held);
}
function rewindNotice(thread: StoredThread): string {
  return `Open the pending rewind in “${thread.summary.title}” (turn ${thread.rewindPending!.turnId}) to resume or finish without restoring remaining files.`;
}
/** Hold only mutations of the pending conversation and files. */
export function rewindWriteHold(threads: Iterable<StoredThread>, method: Method, args: unknown): string | undefined {
  if (method === 'threads.rewind' || method === 'threads.rewindFinish') return;
  const input = args as { id?: string; threadId?: string; parentThreadId?: string; projectId?: string } | null;
  const held = [...threads].find(thread => {
    if (!thread.rewindPending) return false;
    if (method.startsWith('material.')) return thread.rewindPending.files.some(file => file.materialId === input?.id);
    if (method === 'terminal.run' || method === 'terminal.start') return thread.summary.projectId === input?.projectId;
    if (method.startsWith('files.')) return thread.summary.projectId === input?.projectId && thread.rewindPending.files.length > 0;
    return thread.summary.id === input?.threadId || thread.summary.id === input?.parentThreadId || method.startsWith('threads.') && thread.summary.id === input?.id;
  });
  return held && rewindNotice(held);
}
