import type { AgentRole } from './api.ts';

/** Bounded discovery, with explicit incomplete-list and ownership-review notices. */
export interface AgentRoleListing {
  roles: AgentRole[];
  truncated: boolean;
  manualReview: boolean;
}
