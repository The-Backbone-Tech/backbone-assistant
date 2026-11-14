import type { Ceiling, DenialReason } from './effects.ts';
import { covers, intersect, isSubset, normalize, type SetSpec } from './set-spec.ts';

/** Resource limits. `null` is "no limit of its own": the parent's bounds it. */
export interface Budget {
  readonly maxTokens: number | null;
  readonly maxCostMicros: number | null;
  readonly maxDurationMs: number | null;
  readonly maxEffects: number | null;
}

/** The terms of a mandate that attenuate. Who issued it, for whom and under which parent live with the stored row. */
export interface MandateTerms {
  readonly projects: SetSpec;
  readonly connections: SetSpec;
  readonly tools: SetSpec;
  readonly operations: SetSpec;
  readonly ceiling: Ceiling;
  readonly budget: Budget;
  /** Milliseconds since the epoch. */
  readonly expiresAt: number;
}

export const UNLIMITED: Budget = { maxTokens: null, maxCostMicros: null, maxDurationMs: null, maxEffects: null };

const LIMITS = ['maxTokens', 'maxCostMicros', 'maxDurationMs', 'maxEffects'] as const;

const smaller = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.min(a, b));
const fits = (child: number | null, parent: number | null) => parent === null || (child !== null && child <= parent);

export function intersectBudget(a: Budget, b: Budget): Budget {
  return Object.fromEntries(LIMITS.map((k) => [k, smaller(a[k], b[k])])) as unknown as Budget;
}

export function budgetWithin(child: Budget, parent: Budget): boolean {
  return LIMITS.every((k) => fits(child[k], parent[k]));
}

/** Delegation: exactly what was requested and what the parent holds. `isWithin(attenuate(p, r), p)` always holds. */
export function attenuate(parent: MandateTerms, requested: MandateTerms): MandateTerms {
  return {
    projects: intersect(parent.projects, requested.projects),
    connections: intersect(parent.connections, requested.connections),
    tools: intersect(parent.tools, requested.tools),
    operations: intersect(parent.operations, requested.operations),
    ceiling: Math.min(parent.ceiling, requested.ceiling) as Ceiling,
    budget: intersectBudget(parent.budget, requested.budget),
    expiresAt: Math.min(parent.expiresAt, requested.expiresAt),
  };
}

/** True when `child` grants nothing that `parent` does not. */
export function isWithin(child: MandateTerms, parent: MandateTerms): boolean {
  return (
    isSubset(child.projects, parent.projects) &&
    isSubset(child.connections, parent.connections) &&
    isSubset(child.tools, parent.tools) &&
    isSubset(child.operations, parent.operations) &&
    child.ceiling <= parent.ceiling &&
    budgetWithin(child.budget, parent.budget) &&
    child.expiresAt <= parent.expiresAt
  );
}

export function normalizeTerms(terms: MandateTerms): MandateTerms {
  return {
    ...terms,
    projects: normalize(terms.projects),
    connections: normalize(terms.connections),
    tools: normalize(terms.tools),
    operations: normalize(terms.operations),
  };
}

export interface Usage {
  readonly tokens: number;
  readonly costMicros: number;
  readonly elapsedMs: number;
  readonly effects: number;
}

export interface OperationRequest {
  readonly tool: string;
  readonly operation: string;
  readonly connection?: string;
  readonly project?: string;
}

/** Whether a mandate still stands for this act, and if not, why. Checked before routing by class. */
export function standing(
  terms: MandateTerms,
  request: OperationRequest,
  context: { readonly now: number; readonly revoked: boolean; readonly usage: Usage },
): 'ok' | DenialReason {
  if (context.revoked) return 'mandate_revoked';
  if (context.now >= terms.expiresAt) return 'mandate_expired';
  const spent: Record<(typeof LIMITS)[number], number> = {
    maxTokens: context.usage.tokens,
    maxCostMicros: context.usage.costMicros,
    maxDurationMs: context.usage.elapsedMs,
    maxEffects: context.usage.effects,
  };
  if (LIMITS.some((k) => terms.budget[k] !== null && spent[k] >= (terms.budget[k] as number))) return 'budget_exhausted';
  const inScope =
    covers(terms.tools, request.tool) &&
    covers(terms.operations, request.operation) &&
    (request.connection === undefined || covers(terms.connections, request.connection)) &&
    (request.project === undefined || covers(terms.projects, request.project));
  return inScope ? 'ok' : 'outside_mandate';
}
