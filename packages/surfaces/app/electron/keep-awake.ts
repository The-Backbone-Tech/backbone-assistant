// While a goal runs on its own, the computer stays awake (Electron's powerSaveBlocker), so a long run
// is not cut short by sleep. The hold starts when any goal is running and ends when none is: paused,
// met, blocked or out of budget. Stop and UNKNOWN keep their rules; this only keeps the machine up.
import type { ApiEvent, GoalRun } from '@backbone-next/platform';

interface Host { call(method: 'goals.runs', args: Record<string, never>): Promise<GoalRun[]>; on(listener: (e: ApiEvent) => void): () => void }
interface Blocker { start(type: 'prevent-app-suspension'): number; stop(id: number): void }

/** Holds the machine awake while a goal runs; returns the release, for quit. */
export function keepAwake(host: Host, blocker: Blocker): () => void {
  let held: number | null = null;
  let checking = Promise.resolve();
  const check = () => {
    checking = checking.then(async () => {
      const running = (await host.call('goals.runs', {}).catch(() => [])).some((r) => r.status === 'running');
      if (running && held === null) held = blocker.start('prevent-app-suspension');
      else if (!running && held !== null) { blocker.stop(held); held = null; }
    });
  };
  const off = host.on((e) => { if (e.topic === 'goals') check(); });
  check();
  return () => { off(); if (held !== null) { blocker.stop(held); held = null; } };
}
