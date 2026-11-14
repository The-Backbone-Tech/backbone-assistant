// Add a row whenever a known setting lacks a complete product enforcement mechanism.
// This is the single list of known settings this build cannot yet honour everywhere.
export const ENFORCEMENT_GAPS: Readonly<Record<string, { readonly hunks: readonly string[]; readonly reason: string } | undefined>> = Object.freeze({});
export const POLICY_LABELS: Record<string, string> = {
  harnesses: 'the engines a person may choose',
  acceptsProcessVisibility: 'whether an engine may inspect the person’s processes',
  personRights: 'whether ACP may run with the person’s unrestricted rights',
  keyHolders: 'the permitted ways to protect a home’s keys',
  standingSignatures: 'whether tools may receive standing signatures',
  standingServers: 'the connector servers eligible for standing signatures',
  telemetryRequired: 'whether telemetry must run',
  telemetryHost: 'the permitted collector host',
  telemetryEndpoint: 'the collector traces address',
  auditContent: 'whether audit exports may include content',
  modelProviders: 'the permitted model providers',
  modelRoutes: 'the permitted kinds of model route',
};
export const settingLabel = (key: string) => `${key}: ${POLICY_LABELS[key] ?? 'unknown setting'}`;
