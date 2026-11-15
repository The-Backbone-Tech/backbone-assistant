import type { PolicyResult } from '@backbone-next/platform/policy';

// Existing managed settings describe engines and routes, not personal browsing destinations.
// Refuse until policy has a complete browser network rule, rather than infer broader permission.
export function browserPolicyDecision(result: PolicyResult): string | undefined {
  if (result.status === 'refused') return result.detail;
  if (result.status === 'verified') return 'Managed policy is active. Personal browsing is blocked because this policy does not define permitted browser network access.';
}
