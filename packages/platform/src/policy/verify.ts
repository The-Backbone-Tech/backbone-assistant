// Pure parsing and verification. System discovery and filesystem authority live in source.ts.
import { ENFORCEMENT_GAPS, settingLabel } from './enforcement.ts';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { getNodeValue, parseTree, type ParseError, type Node } from 'jsonc-parser';

export interface PolicySettings {
  harnesses?: readonly string[];
  acceptsProcessVisibility?: boolean;
  personRights?: boolean;
  keyHolders?: readonly ('plaintext' | 'keychain')[];
  standingSignatures?: boolean;
  standingServers?: readonly string[];
  telemetryRequired?: boolean;
  telemetryHost?: string;
  telemetryEndpoint?: string;
  auditContent?: boolean;
  modelProviders?: readonly string[];
  modelRoutes?: readonly ('own' | 'gateway' | 'endpoint' | 'native' | 'agent')[];
}
export interface VerifiedPolicy {
  readonly id: string;
  readonly version: number;
  readonly notAfter?: string;
  readonly scope?: { readonly machine?: string; readonly organisation?: string };
  readonly rollbackOf?: number;
  readonly requirements: Readonly<PolicySettings>;
  readonly defaults: Readonly<PolicySettings>;
  readonly warnings: readonly string[];
}
export const REFUSALS = ['io', 'missing', 'unsafe-trust', 'unsupported-platform', 'format', 'unknown-requirement', 'not-enforceable', 'weakening-default', 'signature', 'expired', 'scope', 'rollback', 'deployment', 'requirement'] as const;
export type PolicyCode = typeof REFUSALS[number];
export type PolicyResult = { status: 'none' } | { status: 'verified'; policy: VerifiedPolicy } | { status: 'refused'; code: PolicyCode; detail: string };
export class PolicyRefused extends Error {
  readonly code: PolicyCode;
  constructor(code: PolicyCode, detail: string) { super(`Managed policy refused (${code}): ${detail}`); this.name = 'PolicyRefused'; this.code = code; }
}
export function refuse(code: PolicyCode, detail: string): never { throw new PolicyRefused(code, detail); }
export function refusal(error: unknown): Extract<PolicyResult, { status: 'refused' }> {
  return error instanceof PolicyRefused ? { status: 'refused', code: error.code, detail: error.message } : { status: 'refused', code: 'format', detail: 'Managed policy refused (format): invalid policy or trust document.' };
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\p{Cc}\p{Cf}]/u.test(v);
const version = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
export function strictJson(bytes: Uint8Array): unknown {
  if (bytes.length > 131072) refuse('format', 'document exceeds the size limit.');
  const errors: ParseError[] = [];
  const tree = parseTree(new TextDecoder('utf-8', { fatal: true }).decode(bytes), errors, { disallowComments: true, allowTrailingComma: false });
  if (!tree || errors.length) refuse('format', 'expected strict JSON.');
  const walk = (n: Node) => {
    if (n.type === 'object') {
      const keys = (n.children ?? []).map(p => p.children![0].value);
      if (new Set(keys).size !== keys.length) refuse('format', 'duplicate JSON keys.');
    }
    for (const child of n.children ?? []) walk(child);
  };
  walk(tree);
  return getNodeValue(tree);
}
const listKeys = ['harnesses', 'keyHolders', 'standingServers', 'modelProviders', 'modelRoutes'];
const booleanKeys = ['acceptsProcessVisibility', 'personRights', 'standingSignatures', 'telemetryRequired', 'auditContent'];
const stringKeys = ['telemetryHost', 'telemetryEndpoint'];
export const POLICY_KEYS = [...listKeys, ...booleanKeys, ...stringKeys] as const;
function settings(value: unknown, required: boolean, warnings: string[]): PolicySettings {
  if (!object(value)) refuse('format', 'requirements and defaults must be objects.');
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, v] of Object.entries(value)) {
    if (!POLICY_KEYS.includes(key)) {
      if (required) refuse('unknown-requirement', 'this runtime does not implement a required setting.');
      warnings.push('An unknown default was ignored.'); continue;
    }
    if (!required && !['harnesses', 'personRights', 'keyHolders', 'telemetryRequired', 'telemetryEndpoint'].includes(key)) { warnings.push('A default without an automatic choice was ignored; personal consent or credentials are required.'); continue; }
    if (listKeys.includes(key)) {
      if (!Array.isArray(v) || v.length > 256 || v.some(x => !text(x)) || new Set(v).size !== v.length) refuse('format', 'allowlists must contain unique nonempty identifiers.');
      if (key === 'keyHolders' && v.some(x => !['keychain', 'plaintext'].includes(x))) refuse('format', 'unknown key holder.');
      if (key === 'modelRoutes' && v.some(x => !['own', 'gateway', 'endpoint', 'native', 'agent'].includes(x))) refuse('format', 'unknown model route kind.');
      result[key] = Object.freeze([...v]);
    } else if (booleanKeys.includes(key)) {
      if (typeof v !== 'boolean') refuse('format', 'policy switches must be booleans.');
      result[key] = v;
    } else {
      if (typeof v !== 'string' || !v || v.length > 2048) refuse('format', 'policy address must be a nonempty string.');
      try {
        const url = new URL(key === 'telemetryHost' ? `https://${v}` : v);
        if (key === 'telemetryHost') {
          if (url.hostname !== v || url.host !== v || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error();
        } else {
          const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
          if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) || !url.hostname || url.pathname === '/' || url.username || url.password || /[?#\s\x00-\x1f]/.test(v)) throw new Error();
        }
      } catch { refuse('format', 'invalid telemetry address.'); }
      result[key] = v;
    }
  }
  return Object.freeze(result);
}
export interface VerifyInput { bytes: Uint8Array; signature: Uint8Array; trust: Uint8Array; machine: string; now: number }
/** No IO, environment, home files, clock reads or mutable state. Verifies the exact bytes. */
export function verifyPolicy(input: VerifyInput): PolicyResult {
  try {
    const trust = strictJson(input.trust);
    if (!object(trust) || !exact(trust, ['keys', 'deployment', 'organisation']) || !Array.isArray(trust.keys) || trust.keys.length < 1 || trust.keys.length > 32 || trust.keys.some(k => typeof k !== 'string') || (trust.organisation !== undefined && !text(trust.organisation))) refuse('format', 'invalid trust file.');
    const deployment = trust.deployment;
    if (!object(deployment) || !exact(deployment, ['id', 'version', 'sha256']) || !text(deployment.id) || !version(deployment.version) || typeof deployment.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(deployment.sha256)) refuse('format', 'invalid protected deployment record.');
    const keys = trust.keys.map(k => createPublicKey(k));
    if (keys.some(k => k.asymmetricKeyType !== 'ed25519') || input.signature.length !== 64 || !keys.some(k => verify(null, input.bytes, k, input.signature))) refuse('signature', 'no trusted Ed25519 signature for these bytes.');
    const p = strictJson(input.bytes);
    if (!object(p) || !exact(p, ['id', 'version', 'notAfter', 'scope', 'rollbackOf', 'requirements', 'defaults']) || !text(p.id) || !version(p.version) || (p.rollbackOf !== undefined && !version(p.rollbackOf))) refuse('format', 'invalid signed metadata.');
    const warnings: string[] = [];
    const requirements = settings(p.requirements, true, warnings), defaults = settings(p.defaults, false, warnings);
    if (requirements.telemetryRequired === true && !requirements.telemetryEndpoint && !requirements.telemetryHost) refuse('format', 'telemetryRequired: mandatory telemetry needs an endpoint or host in requirements.');
    if (defaults.personRights === true || defaults.keyHolders?.some(holder => holder !== 'keychain')) refuse('weakening-default', 'Defaults may only tighten protection: personRights must be false and keyHolders may name only keychain.');
    for (const section of [p.requirements, p.defaults]) for (const key of Object.keys(section as object)) {
      const gap = ENFORCEMENT_GAPS[key as keyof typeof ENFORCEMENT_GAPS];
      if (gap) refuse('not-enforceable', `${settingLabel(key)} is not enforceable in this build; ${gap.reason}. Needs ${gap.hunks.join(', ')}.`);
    }
    if (p.notAfter !== undefined) {
      if (typeof p.notAfter !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(p.notAfter) || !Number.isFinite(Date.parse(p.notAfter)) || new Date(p.notAfter).toISOString() !== (p.notAfter.includes('.') ? p.notAfter : p.notAfter.replace('Z', '.000Z'))) refuse('format', 'notAfter must be an RFC3339 UTC instant.');
      if (!Number.isFinite(input.now) || input.now >= Date.parse(p.notAfter)) refuse('expired', 'the signed policy has expired.');
    }
    if (p.scope !== undefined) {
      if (!object(p.scope) || !exact(p.scope, ['machine', 'organisation']) || !Object.keys(p.scope).length || Object.values(p.scope).some(v => !text(v))) refuse('format', 'invalid scope.');
      if ((p.scope.machine !== undefined && p.scope.machine !== input.machine) || (p.scope.organisation !== undefined && p.scope.organisation !== trust.organisation)) refuse('scope', 'the signed scope does not match this machine or organisation.');
    }
    if (p.version < deployment.version && p.rollbackOf !== deployment.version) refuse('rollback', 'version is below the protected deployment floor without an explicit signed rollback.');
    if (p.rollbackOf !== undefined && (p.version >= deployment.version || p.rollbackOf !== deployment.version)) refuse('rollback', 'rollback does not name the protected high-water version.');
    if (p.id !== deployment.id || (p.version > deployment.version) || createHash('sha256').update(input.bytes).digest('hex') !== deployment.sha256) refuse('deployment', 'policy does not match the protected active deployment.');
    const policy = Object.freeze({ id: p.id, version: p.version, ...(p.notAfter ? { notAfter: p.notAfter as string } : {}), ...(p.scope ? { scope: Object.freeze({ ...p.scope as object }) } : {}), ...(p.rollbackOf ? { rollbackOf: p.rollbackOf as number } : {}), requirements, defaults, warnings: Object.freeze(warnings) }) as VerifiedPolicy;
    return { status: 'verified', policy };
  } catch (error) { return refusal(error); }
}
