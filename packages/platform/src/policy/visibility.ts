import { POLICY_LABELS } from './enforcement.ts';
import { policyFor } from './source.ts';
import type { PolicyCode } from './verify.ts';
export type PolicyView = { state: 'none' } | { state: 'refused'; code: PolicyCode; detail: string } | { state: 'verified'; id: string; version: number; fixed: string[]; descriptions: Record<string, string>; warnings: readonly string[] };
/** A content-free projection for Settings: never sends trust keys, policy bytes or endpoint values. */
export function policyView(home: string): PolicyView {
  const result = policyFor(home);
  if (result.status === 'none') return { state: 'none' };
  if (result.status === 'refused') return { state: 'refused', code: result.code, detail: result.detail };
  return { state: 'verified', id: result.policy.id, version: result.policy.version, fixed: Object.keys(result.policy.requirements), descriptions: Object.fromEntries(Object.keys(result.policy.requirements).map(key => [key, POLICY_LABELS[key]])), warnings: result.policy.warnings };
}
