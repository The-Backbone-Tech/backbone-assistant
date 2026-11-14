/**
 * An effect's lifecycle. Every arrow is one transition written by one crossing; the database's
 * table (`sec.effect_transition_allowed`) and this one must agree.
 *
 *   proposed → allowed | awaiting_checker | denied | cancelled
 *   awaiting_checker → allowed | denied | cancelled
 *   allowed → claimed | cancelled
 *   claimed → dispatching | allowed (claim lost) | cancelled
 *   dispatching → succeeded | failed | unknown      (authority is spent: only observation remains)
 *   unknown → succeeded | failed                    (settled by its resolver, never resent)
 */
export type EffectStatus =
  | 'proposed'
  | 'awaiting_checker'
  | 'allowed'
  | 'denied'
  | 'claimed'
  | 'dispatching'
  | 'succeeded'
  | 'failed'
  | 'unknown'
  | 'cancelled';

export const EFFECT_TRANSITIONS: Readonly<Record<EffectStatus, readonly EffectStatus[]>> = {
  proposed: ['allowed', 'awaiting_checker', 'denied', 'cancelled'],
  awaiting_checker: ['allowed', 'denied', 'cancelled'],
  allowed: ['claimed', 'cancelled'],
  denied: [],
  claimed: ['dispatching', 'allowed', 'cancelled'],
  dispatching: ['succeeded', 'failed', 'unknown'],
  succeeded: [],
  failed: [],
  unknown: ['succeeded', 'failed'],
  cancelled: [],
};

export const EFFECT_STATUSES = Object.keys(EFFECT_TRANSITIONS) as readonly EffectStatus[];

export function canTransition(from: EffectStatus, to: EffectStatus): boolean {
  return EFFECT_TRANSITIONS[from].includes(to);
}

export function isTerminal(status: EffectStatus): boolean {
  return EFFECT_TRANSITIONS[status].length === 0;
}

/** Once dispatch begins the act may have happened: it is observed, never cancelled or resent. */
export function isAuthoritySpent(status: EffectStatus): boolean {
  return status === 'dispatching' || status === 'unknown' || status === 'succeeded' || status === 'failed';
}
