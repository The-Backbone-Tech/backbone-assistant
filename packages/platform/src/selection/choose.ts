// Task-level solution selection, its first steps (docs/specs/solution-selection.md): which routes
// exist here and whether each is eligible, then a proportionate, reasoned choice under the task's
// hard constraints. Pure: the inventory is gathered elsewhere (composition/selection.ts), and nothing
// here runs, buys or connects anything. When no eligible route meets the task, the answer is the
// concrete limitation, never a fabricated winner.

import type { RouteApproval } from '../api-models.ts';
import { chatModel } from './route-identity.ts';
export type Capability = 'model' | 'code' | 'files' | 'mail';
export type Spend = 'none' | 'plan' | 'metered';

export interface Route {
  id: string;
  label: string;
  /** native-engine: a signed-in tool the person already has; model-route: a configured API route; local-model: on this computer; code-only: a maintained tool for a known job, run here with no model. */
  /** A client-setup observation has no executor and can never be selected, even if a caller marks it eligible. */
  kind: 'client-setup' | 'agent-engine' | 'native-engine' | 'model-route' | 'local-model' | 'code-only';
  capabilities: Capability[];
  /** Whether using it reaches the network. */
  network: boolean;
  /** What using it costs: nothing, an existing plan (already paid, not unlimited), or metered spend. */
  spends: Spend;
  eligible: boolean;
  model?: string;
  fingerprint?: string;
  /** Why it is not eligible now, in words the person can act on (a missing key, signed out). */
  blocked?: string;
  availability?: { state: 'now' | 'setup' | 'entitlement'; detail: string };
}

export interface TaskNeeds {
  /** Trusted line's one-admission constraint; stripped before the task is persisted. */
  approvedRoute?: RouteApproval;
  /** Public evidence topic or exact Arena record; never private task text. */
  evidenceQuery?: string;
  needs: Capability[];
  /** May the work reach the network? A restricted task says no. */
  network: boolean;
  /** The most it may cost. */
  spend: Spend;
  /** Exact figures from structured data: code that computes them is preferred over a model's arithmetic. */
  structured?: boolean;
}

export interface Option { route: Route; reasons: string[] }
export interface Selection {
  /** Eligible routes that meet every hard constraint, best first. */
  evidence?: import('./arena.ts').ArenaEvidence;
  feasible: Option[];
  /** Routes ruled out, each with why: a constraint, or why it is not available now. */
  excluded: Option[];
  choice: Option | null;
  /** Why nothing can do the task here, when nothing can. */
  limitation: string | null;
}

const SPEND_ORDER: Spend[] = ['none', 'plan', 'metered'];
const KIND_ORDER: Route['kind'][] = ['native-engine', 'agent-engine', 'local-model', 'code-only', 'model-route', 'client-setup'];

/**
 * Hard constraints first (eligible now, network, spend, capabilities), each exclusion with its
 * reason; then a preference among what is left: code for structured work, less spend, a tool the
 * person already has before a new route. Equally defensible options are kept, best first.
 */
export function choose(routes: readonly Route[], task: TaskNeeds): Selection {
  const feasible: Option[] = [];
  const excluded: Option[] = [];
  for (const found of routes) {
    const setup = found.kind === 'client-setup' || found.kind === 'local-model';
    const route: Route = { ...found, eligible: !setup && found.eligible, availability: setup
      ? { state: 'setup', detail: found.availability?.detail ?? found.blocked ?? 'Configure a supported executor before this client can run a task.' }
      : found.availability ?? { state: found.eligible ? 'now' : 'setup', detail: found.eligible ? 'Available in the discovered configuration; usage and entitlement limits remain with the provider.' : found.blocked ?? 'Configure this route before use.' } };
    const why: string[] = [];
    if (route.model && !chatModel(route.model)) why.push('this model is not a chat model');
    if (task.approvedRoute && (task.approvedRoute.routeId !== route.id || task.approvedRoute.fingerprint !== route.fingerprint || task.approvedRoute.model !== route.model || task.approvedRoute.spend !== route.spends)) why.push('the approved route or spend class changed before admission; choose again');
    if (!route.eligible) why.push(route.blocked ?? 'not available here now');
    else if (route.availability && route.availability.state !== 'now') why.push(route.availability.detail);
    if (route.network && !task.network) why.push('reaches the network, which this task may not');
    if (SPEND_ORDER.indexOf(route.spends) > SPEND_ORDER.indexOf(task.spend)) why.push(`costs more than allowed (${route.spends}, allowed ${task.spend})`);
    const missing = task.needs.filter((c) => !route.capabilities.includes(c));
    if (missing.length) why.push(`cannot ${missing.map((c) => ({ model: 'reason over text', code: 'run code', files: 'read and write files', mail: 'reach the mailbox' })[c]).join(' or ')}`);
    (why.length ? excluded : feasible).push({ route, reasons: why });
  }
  const score = (r: Route) => [
    ['local-model', 'client-setup'].includes(r.kind) ? 1 : 0,
    task.structured && r.capabilities.includes('code') ? 0 : 1,
    SPEND_ORDER.indexOf(r.spends),
    KIND_ORDER.indexOf(r.kind),
  ];
  feasible.sort((a, b) => { const x = score(a.route), y = score(b.route); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || x[3] - y[3] || a.route.id.localeCompare(b.route.id); });
  for (const o of feasible) {
    if (task.structured && o.route.capabilities.includes('code')) o.reasons.push('supports computing figures in code; verify the inputs and calculation');
    o.reasons.push(o.route.spends === 'none' ? 'costs nothing' : o.route.spends === 'plan' ? 'within a plan already paid (usage still counts)' : 'metered spend, within the allowed budget');
    if (o.route.kind === 'native-engine') o.reasons.push('a tool the person already uses');
  }
  const choice = feasible[0] ?? null;
  const limitation = choice ? null
    : `No route here can do this task under its constraints: ${excluded.map((o) => `${o.route.label}: ${o.reasons.join('; ')}`).join(' · ') || 'none is configured'}.`;
  return { feasible, excluded, choice, limitation };
}
