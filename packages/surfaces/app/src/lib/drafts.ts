// One ordered draft writer per renderer. It survives closing a tab and uses the existing platform
// draft store; no browser-local copy of work and no second API implementation.
import type { Args } from '@backbone-next/platform';
import { call, clientKey } from './api.ts';
import { createWriteBehind } from './write-behind.ts';

// A revision is learned from an authoritative Host response, never from the pending cache.
const revisions = new Map<string, number>();
const blocked = new Map<string, Error>();
const uncertain = new Map<string, {request: Args<'drafts.put'>; error: Error}>();
const retrying = new Set<string>();
const writers = new Map<string, ReturnType<typeof createWriteBehind<Args<'drafts.put'>>>>();
function writerFor(key: string) {
  let writer = writers.get(key);
  if (writer) return writer;
  writer = createWriteBehind<Args<'drafts.put'>>({
  delay: 250,
  async write(batch) {
    for (const value of batch.values()) {
      const hold = blocked.get(value.key) ?? uncertain.get(value.key)?.error;
      if (hold) throw hold;
      value.baseRevision ??= revisions.get(value.key) ?? 0;
      let result;
      try {
        result = await call('drafts.put', value);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        uncertain.set(value.key, {request:structuredClone(value),error:failure});
        throw failure;
      }
      if (!result.ok) {
        const failure = new Error(result.detail);
        if (result.reason === 'STALE_BASE') blocked.set(value.key, failure);
        else if (result.outcome === 'UNKNOWN') uncertain.set(value.key, {request:structuredClone(value),error:failure});
        throw failure;
      }
      revisions.set(value.key, result.value.revision);
    }
  },
  });
  writers.set(key, writer);
  return writer;
}

export function persistDraft(key: string, text: string, meta?: Record<string, string | number>) {
  return writerFor(key).set(key, { key, text, meta, clientKey: clientKey() });
}

/** Written now rather than on the delay, for what must be safe before the next step leaves. */
export function persistDraftNow(key: string, text: string, meta?: Record<string, string | number>) {
  const saved = persistDraft(key, text, meta);
  void writerFor(key).flush().catch(() => {});
  return saved;
}

export async function readDraft(key: string) {
  const local = writers.get(key)?.get(key);
  if (local) return { key, text: local.text, meta: local.meta, updatedAt: '', revision: revisions.get(key) ?? 0 };
  return call('drafts.get', { key });
}

/** Bind a revision only after this consumer actually applies that read to its view.
 * A read can precede an acknowledged write in this renderer (including a send's clear).
 * Applying that earlier snapshot must never rewind the ordered writer's base.
 */
export function acceptDraftRead(key: string, revision: number) {
  if (!hasUnconfirmedDraft(key) && !writers.get(key)?.get(key) && Number.isSafeInteger(revision) && revision >= 0) revisions.set(key, Math.max(revisions.get(key) ?? 0, revision));
}

/** A failed draft remains local until the person reviews the authoritative saved value. */
export function hasUnconfirmedDraft(key: string): boolean { return blocked.has(key) || uncertain.has(key); }
export function hasUncertainDraft(key: string): boolean { return uncertain.has(key); }
/** Retry exactly the request whose acknowledgement was lost, only on explicit action. */
export async function retryUncertainDraft(key: string): Promise<void> {
  const pending=uncertain.get(key);
  if (!pending || retrying.has(key)) throw new Error('This draft is not ready to retry.');
  retrying.add(key);
  try {
    const result=await call('drafts.put',pending.request);
    if (!result.ok) {
      if (result.reason==='STALE_BASE') {uncertain.delete(key);blocked.set(key,new Error(result.detail));}
      else if (result.outcome!=='UNKNOWN') uncertain.delete(key);
      throw new Error(result.detail);
    }
    revisions.set(key,result.value.revision);
    uncertain.delete(key);
    const current=writers.get(key)?.get(key);
    if (current?.clientKey===pending.request.clientKey) writers.get(key)?.discard(key);
  } finally {retrying.delete(key);}
}
export async function reviewSavedDraft(key: string) { return call('drafts.get', {key}); }
/** Explicitly replace only this local pending draft after confirming the saved revision is unchanged. */
export async function useReviewedDraft(key: string, revision: number) {
  if (!hasUnconfirmedDraft(key) || retrying.has(key)) throw new Error('This draft is not ready for review.');
  const saved = await call('drafts.get', {key});
  if ((saved?.revision ?? 0) !== revision) throw new Error('The saved draft changed again. Review it before choosing.');
  // Fence any earlier request whose body is still in transit before discarding local work.
  const fenced = await call('drafts.put', {key, text:saved?.text ?? '', ...(saved?.meta === undefined ? {} : {meta:saved.meta}), clientKey:clientKey(), baseRevision:revision});
  if (!fenced.ok) throw new Error(fenced.detail);
  writers.get(key)?.discard(key);
  blocked.delete(key);
  uncertain.delete(key);
  revisions.set(key, fenced.value.revision);
  return fenced.value;
}
/** Explicitly keep the currently edited text against the revision the person reviewed. */
export async function keepReviewedDraft(key: string, revision: number, text: string, meta?: Record<string, string | number>) {
  if (!hasUnconfirmedDraft(key) || retrying.has(key)) throw new Error('This draft is not ready for review.');
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('The saved draft revision is invalid.');
  revisions.set(key, revision);
  blocked.delete(key);
  uncertain.delete(key);
  return persistDraftNow(key, text, meta);
}

/** Join only this key's pending persistence. */
export function flushDraft(key: string): Promise<void> { return writers.get(key)?.flush() ?? Promise.resolve(); }

// These are pending UI continuations, not another durable work owner. Closing first joins
// them, since Save/send may enqueue a newer draft after their transport response arrives.
const operations = new Set<Promise<unknown>>();
export function trackDraftOperation<T>(operation: () => Promise<T>): Promise<T> {
  const pending = Promise.resolve().then(operation);
  operations.add(pending);
  void pending.then(() => operations.delete(pending), () => operations.delete(pending));
  return pending;
}

export class ConflictCopyError extends Error {
  readonly keys: string[];
  constructor(keys: string[]) { super(`Could not keep conflict copies for: ${keys.join(', ')}`); this.keys = keys; }
}
let approvedCloseLoss = new Map<string, string>();
/** One explicit close approval applies only to the exact local versions visible when approved. */
export function approveCloseWithoutConflictCopies(keys: string[]) {
  approvedCloseLoss = new Map(keys.flatMap(key => { const local=writers.get(key)?.get(key); return local ? [[key,local.clientKey] as const] : []; }));
}

export async function flushDrafts(): Promise<void> {
  const closeLoss = approvedCloseLoss;
  approvedCloseLoss = new Map();
  for (;;) {
    if (operations.size) await Promise.all([...operations]);
    const keys = [...writers.keys()];
    const outcomes = await Promise.allSettled(keys.map(key => writerFor(key).flush()));
    const missing: string[] = [];
    for (let i = 0; i < outcomes.length; i++) {
      const outcome = outcomes[i], key = keys[i];
      if (outcome.status === 'rejected') {
        if (!hasUnconfirmedDraft(key)) throw outcome.reason;
        const local = writers.get(key)?.get(key);
        if (local && closeLoss.get(key) === local.clientKey) continue;
        try { await preserveConflict(key); } catch { missing.push(key); }
      }
    }
    if (missing.length) throw new ConflictCopyError(missing);
    if (!operations.size) return;
  }
}

export type DraftConflictCopy = { id: string; text: string; meta?: Record<string, string | number> };
const conflictKey = (key: string) => `draft-conflict:${key}`;
function parseConflictCopies(text: string | undefined): DraftConflictCopy[] {
  if (!text) return [];
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || value.some(item => !item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id || typeof item.text !== 'string' || (item.meta !== undefined && (!item.meta || typeof item.meta !== 'object' || Array.isArray(item.meta) || Object.values(item.meta).some(value => typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))))))) throw new Error('The conflict copies could not be read safely.');
  const copies = value as DraftConflictCopy[];
  if (new Set(copies.map(copy => copy.id)).size !== copies.length) throw new Error('The conflict copies have duplicate identities.');
  return copies;
}
/** The copies are separate from the person's current draft and never replace it. */
export async function readConflictCopies(key: string): Promise<DraftConflictCopy[]> {
  const saved = await call('drafts.get', {key:conflictKey(key)});
  return parseConflictCopies(saved?.text);
}
async function preserveConflict(key: string): Promise<void> {
  const local = writers.get(key)?.get(key);
  if (!local) throw new Error(`The unconfirmed ${key} draft is unavailable.`);
  const id = local.clientKey;
  const target = conflictKey(key); const prior = await call('drafts.get',{key:target});
  const copies = parseConflictCopies(prior?.text);
  const existing = copies.find(copy => copy.id === id);
  if (existing) { if (existing.text !== local.text || JSON.stringify(existing.meta ?? null) !== JSON.stringify(local.meta ?? null)) throw new Error('The conflict copy identity is inconsistent.'); return; }
  const copy: DraftConflictCopy = {id, text:local.text, ...(local.meta === undefined ? {} : {meta:local.meta})};
  const result = await call('drafts.put',{key:target, text:JSON.stringify([...copies,copy]), meta:{kind:'draft-conflicts-v1'}, clientKey:id, baseRevision:prior?.revision ?? 0});
  if (!result.ok) throw new Error(result.detail);
}
/** Explicitly discard one reviewed copy, retaining all other copies with CAS. */
export async function discardConflictCopy(key: string, id: string): Promise<void> {
  const target=conflictKey(key), prior=await call('drafts.get',{key:target}); const copies=parseConflictCopies(prior?.text);
  if (!copies.some(copy=>copy.id===id)) throw new Error('This conflict copy changed. Review it again.');
  const remaining=copies.filter(copy=>copy.id!==id);
  const result=await call('drafts.put',{key:target,text:remaining.length ? JSON.stringify(remaining) : '',meta:{kind:'draft-conflicts-v1'},clientKey:clientKey(),baseRevision:prior?.revision ?? 0});
  if (!result.ok) throw new Error(result.detail);
}
