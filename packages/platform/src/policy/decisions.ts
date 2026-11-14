import { settingLabel } from './enforcement.ts';
import { refuse, type VerifiedPolicy } from './verify.ts';
const allowed = (list: readonly string[] | undefined, value: string) => list === undefined || list.includes(value);
export function engineDecision(policy: VerifiedPolicy | undefined, id: string, config?: { acceptsProcessVisibility?: boolean; environment?: string }): void {
  const r = policy?.requirements;
  if (!allowed(r?.harnesses, id)) refuse('requirement', 'the selected engine is fixed by policy (harnesses).');
  if (id === 'harness-acp' && r?.acceptsProcessVisibility === false) refuse('requirement', 'policy forbids engines with process visibility.');
  if (config?.environment === 'person-rights' && r?.personRights === false) refuse('requirement', 'policy forbids the person-rights environment.');
}
export function harnessDecision(policy: VerifiedPolicy | undefined, personal: string | undefined, fallback = 'harness-stub'): string {
  const selected = personal ?? policy?.defaults.harnesses?.[0] ?? fallback;
  engineDecision(policy, selected);
  return selected;
}
export function keyDecision(policy: VerifiedPolicy | undefined, holder: string): void {
  if (!allowed(policy?.requirements.keyHolders, holder)) refuse('requirement', 'the home key holder is forbidden by policy.');
}
export function standingDecision(policy: VerifiedPolicy | undefined, server: string): void {
  if (policy?.requirements.standingSignatures === false || !allowed(policy?.requirements.standingServers, server)) refuse('requirement', 'standing signatures for this connector server are forbidden by policy.');
}
export function auditDecision(policy: VerifiedPolicy | undefined, content: boolean): void {
  if (content && policy?.requirements.auditContent === false) refuse('requirement', 'audit export with content is forbidden by policy.');
}
export function routeDecision(policy: VerifiedPolicy | undefined, route: { kind: string; provider: string }): void {
  if (!allowed(policy?.requirements.modelProviders, route.provider) || !allowed(policy?.requirements.modelRoutes, route.kind)) refuse('requirement', 'the selected model route or provider is forbidden by policy.');
}
export function telemetryDecision(policy: VerifiedPolicy | undefined, personal: string | false | undefined): string | undefined {
  const r = policy?.requirements;
  const endpoint = r?.telemetryEndpoint ?? (personal === false ? (r?.telemetryRequired ? policy?.defaults.telemetryEndpoint : undefined) : personal ?? policy?.defaults.telemetryEndpoint);
  const enabled = r?.telemetryRequired ?? (personal !== undefined ? true : policy?.defaults.telemetryRequired);
  if (r?.telemetryRequired === false || (personal === false && !r?.telemetryRequired && !r?.telemetryEndpoint) || (!personal && r?.telemetryRequired === undefined && policy?.defaults.telemetryRequired === false)) return undefined;
  if (!endpoint) { if (enabled) refuse('requirement', 'policy requires telemetry but no collector endpoint is configured.'); return undefined; }
  if (r?.telemetryHost !== undefined && new URL(endpoint).hostname !== r.telemetryHost) refuse('requirement', 'the telemetry endpoint host is fixed by policy.');
  return endpoint;
}
export function policyDescription(result: import('./verify.ts').PolicyResult) {
  if (result.status === 'refused') return { name: 'policy', status: 'fail' as const, detail: result.detail };
  if (result.status === 'none') return { name: 'policy', status: 'ok' as const, detail: 'no managed policy' };
  const p = result.policy;
  return { name: 'policy', status: p.warnings.length ? 'warn' as const : 'ok' as const, detail: `${p.id} version ${p.version}; fixed by policy: ${Object.keys(p.requirements).map(settingLabel).join('; ') || 'none'}${p.warnings.length ? '; unknown defaults ignored' : ''}` };
}
