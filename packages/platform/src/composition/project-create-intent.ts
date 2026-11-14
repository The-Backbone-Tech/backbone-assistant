// Decision over a durable project-creation intent. The caller holds the home lock and persists
// every returned state before performing its associated filesystem effect.
import type { Project } from '../api.ts';

export type ProjectIntent = {
  key: string;
  name: string;
  kind: Project['kind'];
  project: Project & { dir: string };
  phase: 'reserved' | 'started' | 'ready' | 'failed';
  partial?: boolean;
};
export type IntentDecision =
  | { action: 'reserve'; intent: ProjectIntent }
  | { action: 'start'; intent: ProjectIntent }
  | { action: 'ready'; intent: ProjectIntent }
  | { action: 'failed'; intent: ProjectIntent }
  | { action: 'unknown' }
  | { action: 'conflict' };

/** A started effect is never repeated merely because its receipt is missing. */
export function decideProjectIntent(prior: ProjectIntent | null, proposed: ProjectIntent, recorded: ProjectIntent['project'] | undefined): IntentDecision {
  if (!prior) return { action: 'reserve', intent: proposed };
  if (prior.key !== proposed.key || prior.name !== proposed.name || prior.kind !== proposed.kind) return { action: 'conflict' };
  if (recorded) {
    if (recorded.id !== prior.project.id || recorded.name !== prior.project.name || recorded.kind !== prior.project.kind || recorded.dir !== prior.project.dir || recorded.createdAt !== prior.project.createdAt) return { action: 'unknown' };
    return { action: 'ready', intent: {...prior, phase:'ready'} };
  }
  if (prior.phase === 'failed') return { action: 'failed', intent: prior };
  if (prior.phase === 'started' || prior.phase === 'ready') return { action: 'unknown' };
  return { action: 'start', intent: {...prior, phase:'started'} };
}
