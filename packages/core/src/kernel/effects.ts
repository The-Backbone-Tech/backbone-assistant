/**
 * Effect classes (effect-gateway contract): how final an act is decides its route. A class only
 * rises; an unknown target is treated as class 3 or higher.
 */
export const EffectClass = {
  /** Read, search, draft or compute. */
  Read: 1,
  /** A reversible change inside the workspace. */
  InternalChange: 2,
  /** A reversible change in an outside system. */
  ExternalReversible: 3,
  /** An outside effect that can be held back before it leaves: send, publish. */
  Delayable: 4,
  /** Final or sensitive: pay, delete, export personal data. */
  Final: 5,
  /** Widening any authority. Never decided by its requester. */
  Elevation: 6,
} as const;
export type EffectClass = (typeof EffectClass)[keyof typeof EffectClass];

/** The highest class a mandate may allow without a checker; final effects and elevation always need one. */
export type Ceiling = 1 | 2 | 3 | 4;

export function isEffectClass(value: number): value is EffectClass {
  return Number.isInteger(value) && value >= 1 && value <= 6;
}

/** A hint from the tool itself is untrusted: it may raise the decided class, never lower it. */
export function raiseOnly(decided: EffectClass, hint?: EffectClass | null): EffectClass {
  return hint != null && hint > decided ? hint : decided;
}

export interface Taint {
  /** The run read content from outside the workspace. */
  readonly untrustedInput: boolean;
  /** The run touched private material. */
  readonly sensitiveData: boolean;
}

/** Untrusted ∧ private ∧ external: the rule of two (I-7) sends the act to a checker. */
export function ruleOfTwoApplies(taint: Taint, externalParty: boolean): boolean {
  return taint.untrustedInput && taint.sensitiveData && externalParty;
}

/** Why the gateway refuses an act outright. */
export type DenialReason = 'outside_mandate' | 'mandate_expired' | 'mandate_revoked' | 'budget_exhausted' | 'already_rejected';
/** Why an act waits for a checker. */
export type CheckerReason = 'above_ceiling' | 'final' | 'elevation' | 'rule_of_two';

export type Route =
  | { readonly kind: 'free' }
  | { readonly kind: 'allowed' }
  | { readonly kind: 'allowed_after_window' }
  | { readonly kind: 'needs_checker'; readonly reason: CheckerReason }
  | { readonly kind: 'denied'; readonly reason: DenialReason };

export interface RouteInput {
  readonly effectClass: EffectClass;
  /** Whether the mandate stands for this act (see `standing`), or why not. */
  readonly standing: 'ok' | DenialReason;
  readonly ceiling: Ceiling;
  readonly taint: Taint;
  /** The act reaches a party outside the workspace. */
  readonly externalParty: boolean;
  /**
   * Trusted code fixes a read's outbound arguments (or there are none). Never stated by the model;
   * an account's OAuth consent alone does not fix them.
   */
  readonly outboundFixed: boolean;
}

/**
 * The route of a proposed act. Pure; the database states the same table (`sec.route_effect`) and
 * the oracle checks that both agree on every input.
 */
export function route(input: RouteInput): Route {
  if (input.standing !== 'ok') return { kind: 'denied', reason: input.standing };
  const c = input.effectClass;
  const twoMarks = ruleOfTwoApplies(input.taint, input.externalParty);
  if (c === EffectClass.Elevation) return { kind: 'needs_checker', reason: 'elevation' };
  if (c === EffectClass.Final) return { kind: 'needs_checker', reason: 'final' };
  if (c === EffectClass.Read) return twoMarks && !input.outboundFixed ? { kind: 'needs_checker', reason: 'rule_of_two' } : { kind: 'free' };
  if (c >= EffectClass.ExternalReversible && twoMarks) return { kind: 'needs_checker', reason: 'rule_of_two' };
  if (c > input.ceiling) return { kind: 'needs_checker', reason: 'above_ceiling' };
  return c === EffectClass.Delayable ? { kind: 'allowed_after_window' } : { kind: 'allowed' };
}
