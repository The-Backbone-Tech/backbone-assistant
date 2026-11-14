// A signed capability (work-planes-lab decision 0007 §6 as amended, with its three clarifications):
// a bound approval the owner gives once, at formation, for one job. The payload is immutable and
// is shown with its hash; it becomes the intent of a root mandate, which the core freezes and
// hashes itself (`sec.args_hash`), so the hash on the screen is the one the core records.
//
// - The signature authorises a grant, not effects: every later effect still gets its own bound
//   authorisation from the gateway (its arguments' hash, its input version, a single-use claim)
//   under the authority current at that moment.
// - A widening needs a new signature: a new class, destination or scope, a later pinned version,
//   an expiry extension, or a budget reset (`widenings`). Narrowing does not.
// - Suspension is not revocation: both revoke the mandate in the core at once (so effects not yet
//   sent are cancelled, pending releases voided); a suspended capability may be signed again while
//   its underlying authority is live, a revoked one never. Re-signing makes a new grant; nothing
//   revoked, expired or cancelled comes back.
import { randomUUID } from 'node:crypto';

/** One operation the capability names, with its class and what the job does with it. */
export interface NamedClass {
  operation: string;
  effectClass: number;
  /** `act`: inside the grant, no question; `propose`: each one waits for the person's accept or discard. */
  mode: 'act' | 'propose';
  recovery: string | null;
}

export interface Pin {
  id: string;
  version: string;
  digest: string;
}

/** The immutable signed payload. Its field order is fixed; the core hashes its canonical form. */
export interface CapabilityPayload {
  capability: string;
  id: string;
  version: number;
  tenant: string;
  plane: 'personal';
  contract: string;
  owner: { id: string; name: string };
  purpose: string;
  scope: { account: string; folders: string[] };
  tools: string[];
  destinations: { drafts: 'requester-only'; sends: 'none'; accounts: string[] };
  classes: NamedClass[];
  irreversible: string[];
  budget: { effectsPerDay: number; modelTurnsPerDay: number; renewal: 'daily' };
  expiresAt: string;
  pins: { model: { route: string; model: string }; tool: Pin; adapter: Pin; configuration: string };
}

export type Axis = 'class' | 'destination' | 'scope' | 'pinned version' | 'expiry' | 'budget';

const DAY = 86_400_000;
/** The contract this payload's shape follows; a new shape is a new contract version. */
export const CONTRACT = 'mail-triage/1';

export interface OfferInputs {
  tenant: string;
  owner: { id: string; name: string };
  account: string;
  model: { route: string; model: string };
  tool: Pin;
  adapter: Pin;
  configuration: string;
  /** The capability being re-signed or widened; a new one otherwise. */
  previous?: CapabilityPayload;
  now?: number;
  days?: number;
}

/** Operation classes implemented by this job, independent of any supplied payload. */
export const JOB_CLASSES: readonly NamedClass[] = [
  { operation: 'mail.list', effectClass: 1, mode: 'act', recovery: null },
  { operation: 'mail.read', effectClass: 1, mode: 'act', recovery: null },
  { operation: 'mail.labels', effectClass: 1, mode: 'act', recovery: null },
  { operation: 'workspace.write_document', effectClass: 2, mode: 'act', recovery: 'exact-undo' },
  { operation: 'mail.label', effectClass: 3, mode: 'propose', recovery: 'exact-undo' },
  { operation: 'mail.move', effectClass: 3, mode: 'propose', recovery: 'exact-undo' },
];

/** The first capability for mail triage: read mail and draft replies; label and move as proposals. */
export function offerFor(inputs: OfferInputs): CapabilityPayload {
  const now = inputs.now ?? Date.now();
  return {
    capability: 'mail-triage',
    id: inputs.previous?.id ?? randomUUID(),
    version: inputs.previous ? inputs.previous.version + 1 : 1,
    tenant: inputs.tenant,
    plane: 'personal',
    contract: CONTRACT,
    owner: inputs.owner,
    purpose: 'Read mail, draft replies; later label and move',
    scope: { account: inputs.account, folders: ['INBOX'] },
    tools: ['mail.list', 'mail.read', 'mail.labels', 'workspace.write_document', 'mail.label', 'mail.move'],
    destinations: { drafts: 'requester-only', sends: 'none', accounts: [inputs.account] },
    classes: JOB_CLASSES.map((c) => ({ ...c })),
    irreversible: [],
    budget: { effectsPerDay: 400, modelTurnsPerDay: 200, renewal: 'daily' },
    expiresAt: new Date(now + (inputs.days ?? 30) * DAY).toISOString(),
    pins: { model: inputs.model, tool: inputs.tool, adapter: inputs.adapter, configuration: inputs.configuration },
  };
}

/** The highest class it acts on without asking: the mandate's ceiling. */
export const ceilingOf = (p: CapabilityPayload) => Math.max(1, ...p.classes.filter((c) => c.mode === 'act').map((c) => c.effectClass));
/** The operations the mandate names. */
export const operationsOf = (p: CapabilityPayload) => [...new Set(p.tools.filter((operation) => p.classes.some((c) => c.operation === operation)))].sort();

const within = <T>(next: T[], prev: T[]) => next.every((x) => prev.includes(x));
const samePin = (a: Pin, b: Pin) => a.id === b.id && a.version === b.version && a.digest === b.digest;

/**
 * The axes on which `next` grants more than `prev`. Anything not plainly narrower counts as wider:
 * a different pinned revision is a later one until a signature says otherwise.
 */
export function widenings(prev: CapabilityPayload, next: CapabilityPayload): Axis[] {
  const out = new Set<Axis>();
  const prevClass = new Map(prev.classes.map((c) => [c.operation, c]));
  for (const c of next.classes) {
    const was = prevClass.get(c.operation);
    if (!was || c.effectClass > was.effectClass || (was.mode === 'propose' && c.mode === 'act')) out.add('class');
  }
  if (!within(next.irreversible, prev.irreversible) || !within(next.tools, prev.tools)) out.add('class');
  if (next.destinations.drafts !== prev.destinations.drafts || next.destinations.sends !== prev.destinations.sends || !within(next.destinations.accounts, prev.destinations.accounts)) out.add('destination');
  if (next.scope.account !== prev.scope.account || !within(next.scope.folders, prev.scope.folders) || next.plane !== prev.plane || next.tenant !== prev.tenant) out.add('scope');
  if (
    !samePin(next.pins.tool, prev.pins.tool) || !samePin(next.pins.adapter, prev.pins.adapter) || next.pins.configuration !== prev.pins.configuration ||
    next.pins.model.model !== prev.pins.model.model || next.pins.model.route !== prev.pins.model.route || next.contract !== prev.contract
  ) out.add('pinned version');
  if (Date.parse(next.expiresAt) > Date.parse(prev.expiresAt)) out.add('expiry');
  if (next.budget.effectsPerDay > prev.budget.effectsPerDay || next.budget.modelTurnsPerDay > prev.budget.modelTurnsPerDay || next.budget.renewal !== prev.budget.renewal) out.add('budget');
  return [...out];
}

/** The payload in plain lines, for the one screen. */
export function summaryOf(p: CapabilityPayload): string[] {
  const acts = p.classes.filter((c) => c.mode === 'act' && c.effectClass > 1).map((c) => (c.operation === 'workspace.write_document' ? 'draft replies (kept in the app; nothing is sent)' : c.operation));
  const proposes = p.classes.filter((c) => c.mode === 'propose').map((c) => c.operation.replace('mail.', ''));
  return [
    `Purpose: ${p.purpose}`,
    `Mailbox: ${p.scope.account} (${p.scope.folders.join(', ')})`,
    `Without asking: read mail; ${acts.join('; ')}`,
    `Proposed for your one-click accept: ${proposes.join(' and ')} (each with an exact undo)`,
    `Never: send, forward or delete mail${p.irreversible.length ? '' : '; no irreversible action is named'}`,
    `Drafts are addressed only to the person who asked`,
    `Budget: ${p.budget.effectsPerDay} actions and ${p.budget.modelTurnsPerDay} model turns a day`,
    `Until: ${new Date(p.expiresAt).toUTCString().replace(/:\d\d GMT$/, ' UTC')}`,
    `Pinned: ${p.pins.model.model} via ${p.pins.model.route}; ${p.pins.tool.id.split('/').pop()} ${p.pins.tool.version}; ${p.pins.adapter.id.split('/').pop()} ${p.pins.adapter.version} (${p.pins.adapter.digest.slice(0, 19)}…)`,
    `Capability ${p.id.slice(0, 8)} v${p.version} · ${p.contract} · owner ${p.owner.name} · tenant ${p.tenant.slice(0, 8)} · plane ${p.plane}`,
  ];
}

export type CapabilityState = 'active' | 'suspended' | 'revoked' | 'expired';

/** What the data home keeps about one signed capability; the core keeps the payload and its hash. */
export interface CapabilityRecord {
  payload: CapabilityPayload;
  /** Effective attenuation, separate from the immutable payload the owner signed. */
  effective?: CapabilityPayload;
  /** Only this UTC day’s bounded grant is live; the signature permits daily renewal. */
  window?: { day: string; expiresAt: string };
  /** Durable until every grant is confirmed ended; suspension here fails closed locally. */
  endPending?: { state: 'suspended' | 'revoked'; reason: string };
  /** Terminal owner intent, persisted before awaiting the core; never cleared by a suspension. */
  terminalRevocation?: { requestedAt: string; reason: string };
  hash: string;
  /** The root mandate the signature issued (or a narrower child of it), current while active. */
  mandate: string;
  signedAt: string;
  signedWith: 'touch-id' | 'device-password';
  state: CapabilityState;
  reason?: string;
  /** Every grant this capability has had, oldest first: a re-signature adds one, never revives one. */
  mandates: string[];
}
