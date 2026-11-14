import type { BehaviourTarget, BehaviourUse } from '../../../behaviour/target.ts';
import { journeyPort } from './journey.ts';

/** A port this target has no surface for yet: every use says so, by name. */
function notWired<T extends object>(port: string, why: string): T {
  return new Proxy({} as T, {
    get(_t, member) {
      return () => Promise.reject(new Error(`the successor's ${port} port is not wired: ${why} (${String(member)})`));
    },
  });
}

/**
 * The successor's behaviour target. Journeys run J-01 through the app's HTTP bridge on the core.
 * Scenes need programmed agents over channels and connected servers, and homes need a command
 * line with export, import, backup and restore; neither surface exists yet.
 */
export function openSuccessorBehaviour(): BehaviourTarget {
  let usage: BehaviourUse[] = [];
  return {
    name: 'successor',
    journeys: journeyPort({ push: (...u: BehaviourUse[]) => usage.push(...u) } as unknown as BehaviourUse[]),
    scenes: notWired('scenes', 'no programmed-agent harness, channel or connected-server fakes yet'),
    homes: notWired('homes', 'no command line with export, import, backup or restore yet'),
    drainUsage() {
      const drained = usage;
      usage = [];
      return drained;
    },
  };
}
