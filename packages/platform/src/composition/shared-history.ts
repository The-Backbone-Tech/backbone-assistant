// Route identities carry no endpoint or secret. Earlier personal context stays with its carrier.
import type { Turn } from '../api.ts';
import type { ModelRoute } from '../ports/harness.ts';
import { routeFingerprint } from '../selection/route-identity.ts';
import { PersonalConversationRequired } from './identity-core.ts';
import type { StoredThread } from './thread-journal.ts';

export function assertSharedHistory(thread: StoredThread, route: ModelRoute | null, threads?: Map<string, StoredThread>, seen = new Set<string>()) {
  if (seen.has(thread.summary.id)) return;
  seen.add(thread.summary.id);
  const related = threads && [...threads.values()].filter(other => other.child?.parentThreadId === thread.summary.id || other.summary.id === thread.child?.reviews || other.summary.id === thread.child?.parentThreadId || other.summary.id === thread.forkedFrom?.threadId || thread.turns.some(turn => turn.handovers?.some(report => report.threadId === other.summary.id)));
  for (const other of related ?? []) assertSharedHistory(other, route, threads, seen);
  for (const turn of thread.turns) {
    const carriers = turn.work.carriers;
    // Old personal turns have no verifiable route identity. Do not infer it from today's settings.
    const personal = carriers?.filter(carrier => !carrier.shared);
    if ((!carriers?.length && !turn.sharedEngine) || personal?.some(carrier => !route || carrier.fingerprint !== routeFingerprint(route) || carrier.model !== route.model)) {
      throw new PersonalConversationRequired();
    }
  }
}
export function recordCarrier(turn: Turn, engine: string, route: ModelRoute, shared: boolean) {
  const carrier = { engine, fingerprint: routeFingerprint(route), model: route.model, label: route.label, shared };
  const previous = turn.work.carriers?.at(-1);
  if (!previous || previous.engine !== engine || previous.fingerprint !== carrier.fingerprint || previous.model !== carrier.model || previous.shared !== shared) (turn.work.carriers ??= []).push(carrier);
}
