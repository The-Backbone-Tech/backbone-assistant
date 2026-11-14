// Bind a side question to the Host's existing Core custody and route eligibility.
import type { TurnSelection, TurnSettings } from '../api.ts';
import { NO_ROUTE, type ModelRoutes } from '../models/route.ts';
import type { HarnessV1, ModelRoute } from '../ports/harness.ts';
import { continuedSelection } from '../selection/pin.ts';
import type { CoreLink } from './core.ts';
import { createSideChat } from './sidechat.ts';
import { createSideCore } from './sidechat-core.ts';
import type { StoredThread } from './thread-journal.ts';

type CoreDeps = Parameters<typeof createSideCore>[0];
type ChatDeps = Omit<Parameters<typeof createSideChat>[0], 'begin' | 'recoverRun' | 'plan'>;
type Wiring = {
  core: Promise<CoreLink>;
  coreDeps: CoreDeps;
  chatDeps: ChatDeps;
  threads(): Iterable<StoredThread>;
  mayRecover(): boolean;
  engine(): HarnessV1 | undefined;
  routes: ModelRoutes;
  continuing(thread: StoredThread, settings: TurnSettings, base: TurnSelection | undefined): { selection?: TurnSelection } | { refused: string };
  routeFor(thread: StoredThread, model: string | undefined, selection: TurnSelection | undefined): { route: ModelRoute } | { refused: string } | null;
};
const refused = (detail: string) => ({ ok: false as const, reason: 'NOT_AVAILABLE' as const, detail, outcome: 'REFUSED' as const });

export function createSideWiring(deps: Wiring) {
  const core = createSideCore(deps.coreDeps);
  const side = createSideChat({ ...deps.chatDeps, begin: core.begin, recoverRun: core.recoverRun,
    plan: (thread) => {
      const engine = deps.engine();
      if (!engine) return refused('Side questions need a configured model runtime.');
      const settings = thread.turns.findLast((turn) => turn.user.settings)?.user.settings;
      const base = continuedSelection(thread.turns);
      const selected = settings ? deps.continuing(thread, settings, base) : { selection: base };
      if ('refused' in selected) return refused(selected.refused);
      const pin = deps.routeFor(thread, settings?.model, selected.selection);
      if (!pin || !('route' in pin)) return refused(pin && 'refused' in pin ? pin.refused : deps.routes.settings().hint ?? NO_ROUTE);
      return { ok: true, value: { engine, route: pin.route } };
    },
  });
  // Core ownership is established before recovery; recovery never resends a question.
  const ready = deps.core.then(async () => { if (deps.mayRecover()) for (const thread of deps.threads()) await side.recover(thread); });
  void ready.catch(() => {});
  return { side, ready };
}
