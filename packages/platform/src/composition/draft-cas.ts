// A transition over one durable draft. The caller serializes the read/transition/write.
import { createHash } from 'node:crypto';
import type { Draft } from '../api.ts';

type DraftInput = { key: string; text: string; meta?: Record<string, string | number>; clientKey: string; baseRevision?: number };
type Operation = { key: string; digest: string; revision: number };
export type DraftRecord = Draft & { revision: number; operations: Operation[] };
export type DraftTransition = { state: 'accepted'; record: DraftRecord; replay: boolean } | { state: 'stale' } | { state: 'conflict' };

function digest(input: DraftInput) {
  const meta = input.meta === undefined ? null : Object.entries(input.meta).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return createHash('sha256').update(JSON.stringify([input.key, input.baseRevision, input.text, meta])).digest('hex');
}

export function transitionDraft(prior: DraftRecord | null, input: DraftInput, at: string): DraftTransition {
  const base = input.baseRevision;
  if (typeof input.key !== 'string' || !input.key || typeof input.clientKey !== 'string' || !input.clientKey || typeof input.text !== 'string' || (input.meta !== undefined && (!input.meta || typeof input.meta !== 'object' || Array.isArray(input.meta) || Object.values(input.meta).some(v => typeof v !== 'string' && (typeof v !== 'number' || !Number.isFinite(v))))) || (base !== undefined && (!Number.isSafeInteger(base) || base < 0))) return {state: 'conflict'};
  const revision = prior?.revision ?? 0;
  const previous = prior?.operations.find(op => op.key === input.clientKey);
  const identity = digest(input);
  if (previous) {
    if (previous.digest !== identity) return {state: 'conflict'};
    return previous.revision === revision ? {state:'accepted', record: prior!, replay: true} : {state:'stale'};
  }
  // A legacy caller can create a new draft, but cannot overwrite any existing record or tombstone.
  if ((base === undefined && prior !== null) || (base !== undefined && base !== revision)) return {state:'stale'};
  const next = revision + 1;
  if (!Number.isSafeInteger(next)) return {state:'conflict'};
  return {state:'accepted', replay:false, record: {key:input.key, text:input.text, ...(input.meta === undefined ? {} : {meta:input.meta}), updatedAt:at, revision:next, operations:[{key:input.clientKey, digest:identity, revision:next}]} };
}

/** Read the old unversioned record without changing the person's saved contents. */
export function decodeDraft(value: unknown, key: string): DraftRecord | null {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Draft record is unreadable');
  const raw = value as Record<string, unknown>;
  if (raw.key !== key || typeof raw.text !== 'string' || typeof raw.updatedAt !== 'string') throw new Error('Draft record is unreadable');
  if (raw.meta !== undefined && (!raw.meta || typeof raw.meta !== 'object' || Array.isArray(raw.meta) || Object.values(raw.meta).some(v => typeof v !== 'string' && (typeof v !== 'number' || !Number.isFinite(v))))) throw new Error('Draft metadata is unreadable');
  const revision = raw.revision === undefined ? 0 : raw.revision;
  const operations = raw.operations === undefined && raw.revision === undefined ? [] : raw.operations;
  if (!Number.isSafeInteger(revision) || (revision as number) < 0 || !Array.isArray(operations)) throw new Error('Draft revision is unreadable');
  if ((revision === 0 && operations.length !== 0) || ((revision as number) > 0 && operations.length !== 1)) throw new Error('Draft history is invalid');
  const seen = new Set<string>(); let last = 0;
  for (const op of operations) {
    if (!op || typeof op.key !== 'string' || !op.key || seen.has(op.key) || typeof op.digest !== 'string' || !/^[a-f0-9]{64}$/.test(op.digest) || !Number.isSafeInteger(op.revision) || op.revision !== revision) throw new Error('Draft history is unreadable');
    seen.add(op.key); last = op.revision;
  }
  if ((revision as number) > 0 && last !== revision) throw new Error('Draft history is invalid');
  return { key, text:raw.text, ...(raw.meta === undefined ? {} : {meta:raw.meta as Record<string, string | number>}), updatedAt:raw.updatedAt, revision:revision as number, operations:operations as Operation[] };
}
export function publicDraft(record: DraftRecord): Draft {
  const { operations: _operations, ...draft } = record;
  return draft;
}
