import type { RouteRecord } from './api.ts';

/** Public metadata derived from the same resolved route as the next turn. */
export interface ModelRouteView {
  kind: RouteRecord['kind'];
  label: string;
  model?: string;
  /** Opaque endpoint/credential-handle identity, never a URL or credential. */
  fingerprint?: string;
  /** True only for an effective keyless loopback endpoint; stored settings alone cannot establish it. */
  keylessLoopback?: boolean;
}

/** A one-admission constraint computed before native confirmation, never a grant. */
export interface RouteApproval { routeId: string; fingerprint: string; model: string; spend: 'none' | 'plan' | 'metered' }
