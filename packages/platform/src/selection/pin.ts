// Solution selection, between the choice and the run: the chosen route as a concrete model route,
// pinned on the turn when it is admitted and checked again when it starts, so what runs is what was
// chosen or nothing runs. A local model must remain explicitly selected, including historical discoveries;
// every choice runs on the configured route only while that is still the one chosen (for a native
// engine, the same engine and account, running the model the turn names).
//
// Whose choice a turn runs on: the person's ordinary follow-ups continue the chat's latest choice; a goal
// run keeps the one it recorded when it was allowed, for its work and its checks; schedules and triggers
// run as they were allowed; a goal run's own turns never become the chat's choice. Whoever starts a turn,
// it never runs on a route outside the limits of a selected task in its history or its parents' (that
// work goes out with it): it is refused with the reason, and a schedule or goal run stops on it. A model
// the person named explicitly is never silently replaced, and the Allow
// line shows the route and model a write will run on and refuses it if that moved (composition/api-line.ts).
import { governedPolicy, routeDecision, PolicyRefused } from '../policy/index.ts';
import type { LocalModels, Receipt, RouteRecord, ShownSelection, TaskNeeds, Turn, TurnSelection } from '../api.ts';
import { LOOPBACK } from '../models/route.ts';
import type { ModelRoute } from '../ports/harness.ts';
import type { Route, Selection } from './choose.ts';
import { routeFingerprint, chatModel } from './route-identity.ts';

/** A policy is machine-wide: no home or caller can choose a different policy source. */
function managedRouteRefusal(route: ModelRoute): string | null {
  try { routeDecision(governedPolicy(''), route); return null; }
  catch (error) { if (error instanceof PolicyRefused) return error.message; throw error; }
}

export const recordOf = (route: RouteRecord & { credential?: string | null }): RouteRecord => {
  const { kind, provider, baseUrl, model, label } = route;
  const fingerprint = 'credential' in route ? routeFingerprint(route) : route.fingerprint;
  return { kind, provider, baseUrl, model, label, ...(fingerprint ? { fingerprint } : {}) };
};
const same = (a: RouteRecord, b: RouteRecord) => a.kind === b.kind && a.provider === b.provider && a.baseUrl === b.baseUrl && a.model === b.model;
/** A native engine runs the model each turn names from its own catalog, so its route is the engine and account, and the model is the turn's. */
const sameEngine = (a: RouteRecord, b: RouteRecord) => a.kind === b.kind && a.provider === b.provider && a.baseUrl === b.baseUrl;

/** The route with another model, its label saying so. */
export const withModel = <R extends RouteRecord>(route: R, model: string): R => ({ ...route, model, label: route.label.split(' · ').map((part) => (part === route.model ? model : part)).join(' · ') });

/** The concrete route a chosen one names: a local model's own server, else the configured route of its kind; null when there is none now. */
export function concreteRoute(choice: Route, local: LocalModels, configured: ModelRoute | null): ModelRoute | null {
  if (choice.kind === 'local-model') {
    for (const r of local.runtimes) for (const model of r.models) {
      if (choice.id === `local:${r.provider}:${model}`) return { kind: 'endpoint', provider: 'openai-compatible', baseUrl: r.baseUrl, model, label: `${r.name} · ${model} · on this computer, keyless`, credential: null };
    }
    return null;
  }
  if (choice.kind === 'agent-engine') return configured?.kind === 'agent' ? configured : null;
  if (choice.kind === 'model-route') return configured && configured.kind !== 'native' && configured.kind !== 'agent' ? configured : null;
  if (choice.kind === 'native-engine') return configured?.kind === 'native' ? configured : null;
  return null;
}

/** Why a concrete route breaks the task's hard constraints, or null. Only the loopback stays off the network; only a keyless local endpoint costs nothing. */
export function outsideTask(route: RouteRecord & { credential?: string | null }, task: TaskNeeds): string | null {
  const loopback = LOOPBACK.test(route.baseUrl);
  if (!task.network && !loopback) return `${route.label} reaches the network, which this task may not`;
  if (task.spend === 'none' && (!loopback || route.kind !== 'endpoint' || route.credential)) return `${route.label} may cost, and this task may spend nothing`;
  return null;
}

/** The pin for a choice, or why the choice cannot be pinned to a route that meets its task. */
export function pinFor(choice: Route, reasons: string[], task: TaskNeeds, local: LocalModels, configured: ModelRoute | null): { selection: TurnSelection } | { refused: string } {
  const route = concreteRoute(choice, local, configured);
  if (!route) return { refused: `The best route here is ${choice.label}, but it is not set up as a route this engine can run now. Nothing was started.` };
  if (!chatModel(route.model)) return { refused: 'This model is not a chat model. Nothing was started.' };
  const approved = task.approvedRoute;
  if (approved && (approved.routeId !== choice.id || approved.fingerprint !== routeFingerprint(route) || approved.model !== route.model || approved.spend !== choice.spends)) return { refused: 'The approved route or spend class changed before admission. Nothing was started; choose again.' };
  const managed = managedRouteRefusal(route);
  if (managed) return { refused: managed };
  const outside = outsideTask(route, task);
  const { approvedRoute: _admitted, ...limits } = task;
  return outside ? { refused: `${outside}. Nothing was started.` } : { selection: { task: limits, routeId: choice.id, reasons, pinned: recordOf(route) } };
}

/**
 * The route a selected turn runs on, checked as it starts: a local choice on its pinned server; a native
 * choice on the configured engine and account, with its pinned model; any other on the configured route,
 * only if that is still the one chosen. Otherwise why it may not run.
 */
export function pinnedRoute(selection: TurnSelection, configured: ModelRoute | null): { route: ModelRoute } | { refused: string } {
  const { pinned } = selection;
  if (!chatModel(pinned.model)) return { refused: 'This model is not a chat model. Select a chat model in Settings before continuing.' };
  const outsidePinned = outsideTask(pinned, selection.task);
  if (outsidePinned) return { refused: `${outsidePinned}. Nothing was sent.` };
  const native = pinned.kind === 'native' && configured?.kind === 'native' && sameEngine(configured, pinned);
  const route = native ? withModel(configured, pinned.model) : configured;
  if (route && pinned.fingerprint && pinned.fingerprint !== routeFingerprint(route)) return { refused: 'The approved endpoint or configured credential changed before the run. Nothing was sent; choose again.' };
  if (!route || !same(route, pinned)) return { refused: `This task was chosen to run on ${pinned.label}, which is no longer the configured route${route ? ` (now ${route.label})` : ''}. It was not run on another route; choose again.` };
  const managed = managedRouteRefusal(route);
  if (managed) return { refused: managed };
  const outside = outsideTask(route, selection.task);
  return outside ? { refused: `${outside}. Nothing was sent.` } : { route };
}

/** The route a turn runs on: its chosen one (pinnedRoute), else the configured route, with the model it names where the engine runs it (a native engine, or a child's own); null with no route. */
export function turnRoute(selection: TurnSelection | undefined, model: string | undefined, configured: ModelRoute | null, child: boolean): { route: ModelRoute } | { refused: string } | null {
  if (configured?.kind === 'agent' && model && !['stub', 'none', 'chosen-by-agent'].includes(model)) return { refused: 'This ACP agent chooses its own model; the host cannot honor a named model.' };
  if (selection) return pinnedRoute(selection, configured);
  const own = !!configured && !!model && !['stub', 'none'].includes(model) && model !== configured.model && (configured.kind === 'native' || (child && configured.kind !== 'agent'));
  if (!configured) { governedPolicy(''); return null; }
  const route = own ? withModel(configured, model!) : configured;
  const managed = managedRouteRefusal(route);
  return managed ? { refused: managed } : { route };
}

/**
 * A selected task that may not reach the network, or may spend less than metered. Work it would set off
 * on the configured route is not offered or not started: children, cards and goals; memory proposals;
 * and what memory learns from it after it ends (consolidation and skill drafts call the configured model).
 */
export const boundedSelection = (selection: TurnSelection | undefined): boolean => !!selection && (!selection.task.network || selection.task.spend !== 'metered');

/**
 * The chat's chosen task, as the person's next ordinary turn continues it: the latest selected turn's,
 * including after reopen or fork. A copy, never the original: it has no execution receipt (`ran`), since
 * nothing of the new turn has run, and no choice options, which only the turn solutions.run started may
 * answer a repeated key with.
 */
export function continuedSelection(turns: readonly Turn[]): TurnSelection | undefined {
  const selection = turns.findLast((turn) => turn.selection && turn.selection.origin !== 'goal-run')?.selection;
  if (!selection) return undefined;
  const { ran: _ran, options: _options, origin: _origin, ...continued } = structuredClone(selection);
  return continued;
}

/**
 * Why a route may not carry this history: a selected turn in it was a task this route breaks (it may
 * not reach the network, or may spend nothing), and its words and answers go out with every later turn.
 * Null when every selected task in it allows the route. One rule for every turn, whoever starts it.
 */
export function historyRefusal(route: RouteRecord & { credential?: string | null }, history: readonly Turn[]): string | null {
  for (const turn of history) {
    const outside = turn.selection && outsideTask(route, turn.selection.task);
    if (outside) return `${outside}, and this chat holds that task's work, which every later turn carries. Nothing was sent; start a new chat for work on another route.`;
  }
  return null;
}

/**
 * Keep a model the person named explicitly, where the engine runs named models: on a native engine the
 * chosen route runs it, and the turn records it; where the chosen route runs only its own model (a
 * child admitted on another), nothing starts rather than run something else. `model` is the settings'
 * model; `child`, whether the turn is a child's, admitted on a model of its own. The Allow line and
 * admission both decide through this. The same selection when nothing changes.
 */
export function withNamedModel(selection: TurnSelection, model: string | undefined, child: boolean): { selection: TurnSelection } | { refused: string } {
  // The settings choose the model only where the engine runs the model they name: a native engine's catalog, or a child's own.
  if (selection.pinned.kind === 'agent' && model && !['stub', 'none', 'chosen-by-agent'].includes(model)) return { refused: 'This ACP agent chooses its own model; the host cannot honor a named model.' };
  const named = selection.pinned.kind === 'native' || child ? model : undefined;
  if (!named || ['stub', 'none'].includes(named) || named === selection.pinned.model) return { selection };
  if (selection.pinned.kind === 'native') return { selection: { ...selection, pinned: withModel(selection.pinned, named), reasons: [...selection.reasons, `${named} is the model named for this turn`] } };
  return { refused: `This chat's task was chosen to run on ${selection.pinned.label}, which cannot run ${named}. Nothing was started; choose again to change its route.` };
}

/** What a caller is shown of a selection: its task, route and pinned destination, no more. */
export const shownOf = (selection: TurnSelection | undefined): ShownSelection => (selection ? { task: structuredClone(selection.task), routeId: selection.routeId, pinned: recordOf(selection.pinned) } : null);
const canonical = (s: ShownSelection) => JSON.stringify(s && { task: { needs: s.task.needs, network: s.task.network, spend: s.task.spend, structured: !!s.task.structured }, routeId: s.routeId, pinned: recordOf(s.pinned) });
/** Whether a selection is the one a caller was shown; `undefined` means the caller showed nothing and does not ask. */
export const asShown = (selection: TurnSelection | undefined, shown: ShownSelection | undefined): boolean => shown === undefined || canonical(shownOf(selection)) === canonical(shown);

/**
 * A repeated solutions.run with a key that already started a turn: that turn, with the selection
 * recorded when it started, never a new choice that would not be what runs; refused when that turn is in
 * another project. Null when the key is new.
 */
export function replayOf(threads: Iterable<{ summary: { id: string; projectId: string }; clientKeys: string[]; turns: Turn[] }>, threadId: string | undefined, clientKey: string, projectId: string): Receipt<{ selection: Selection; started: { threadId: string; turnId: string } | null; detail: string }> | null {
  const thread = [...threads].find((t) => (!threadId || t.summary.id === threadId) && t.clientKeys.includes(clientKey));
  const turn = thread?.turns.find((_, i) => thread.clientKeys[i] === clientKey);
  if (!thread || !turn) return null;
  // As admission refuses it: a key's turn in another project is not this request's.
  if (thread.summary.projectId !== projectId) return { ok: false, reason: 'INVALID', detail: 'Use the active chat project.', outcome: 'REFUSED' };
  const recorded = turn.selection;
  if (!recorded?.options) return { ok: false, reason: 'INVALID', detail: 'This key already started a turn that solution selection did not choose. Use a new key.', outcome: 'REFUSED' };
  return { ok: true, value: { selection: recorded.options, started: { threadId: thread.summary.id, turnId: turn.id }, detail: `Already started with this key on ${recorded.options.choice?.route.label ?? recorded.routeId} (${recorded.pinned.label}); nothing new was started.` } };
}
