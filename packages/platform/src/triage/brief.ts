// The morning brief, built from the core's receipts and the job's notes: what was done (drafts) and
// what is proposed (labels and moves), each with its outcome and its recovery class, then what needs
// the person and why. Nothing here is written by the model: outcomes come from effect statuses,
// recovery classes from the connector, reasons from the job's own checks.
import type { Brief, BriefItem, BriefOutcome, CapabilityView, RecoveryClass, TriagedRequest, TriageView } from '../api.ts';
import { sameMailbox } from './items.ts';
import { summaryOf } from './capability.ts';
import type { Item, Stored } from './service.ts';

export interface EffectView {
  id: string;
  status: string;
  route_reason: string | null;
  decision_id: string | null;
  decision_status: string | null;
  operation: string;
  args?: Record<string, unknown>;
  resolver_id?: string | null;
  resolve_by?: Date | string | null;
}

const DRAFT: Record<string, BriefOutcome> = {
  succeeded: 'DONE', failed: 'FAILED', denied: 'REFUSED', cancelled: 'CANCELLED', unknown: 'UNKNOWN',
  proposed: 'PENDING', allowed: 'PENDING', claimed: 'PENDING', dispatching: 'PENDING', awaiting_checker: 'PENDING',
};

/** A proposal's outcome: waiting, accepted and held (writes gated), discarded, or what the provider did. */
function proposalOutcome(e: EffectView): BriefOutcome {
  if (e.status === 'awaiting_checker') return 'PROPOSED';
  if (e.status === 'denied') return e.decision_status === 'rejected' ? 'DISCARDED' : 'REFUSED';
  if (e.status === 'allowed' || e.status === 'claimed') return 'ACCEPTED';
  return DRAFT[e.status] ?? 'UNKNOWN';
}

const REASON: Record<string, string> = {
  outside_mandate: 'before formation the job only reads',
  mandate_revoked: 'its grant was revoked',
  mandate_expired: 'its grant expired',
  repeat_unknown_blocked: 'the same change is UNKNOWN and is never resent',
  already_rejected: 'the person discarded this change before',
};

export function briefOf(state: Stored, effects: Map<string, EffectView>): Brief {
  const items = Object.values(state.items).filter((i) => sameMailbox(i, state.connection)).sort((a, b) => a.date.localeCompare(b.date));
  const from = (i: Item) => (i.from.name ? `${i.from.name} <${i.from.address}>` : i.from.address);
  const message = (i: Item) => ({ id: i.id, from: from(i), subject: i.subject });
  const requests: TriagedRequest[] = [];
  const done: BriefItem[] = [];
  const proposed: BriefItem[] = [];
  const needsYou: Brief['needsYou'] = [];
  const counts = { requests: items.length, read: 0, drafted: 0, proposed: 0, accepted: 0, discarded: 0, needsYou: 0, unknown: 0, refused: 0 };
  const restorations = Object.values(state.restorations ?? {}).filter((i) => sameMailbox(i, state.connection));
  for (const i of [...items, ...restorations]) {
    if (i.read) counts.read++;
    let draft: BriefItem | null = null;
    const d = i.draft?.effect ? effects.get(i.draft.effect) : undefined;
    if (i.draft && d) {
      const outcome = DRAFT[d.status] ?? 'UNKNOWN';
      draft = {
        effect: d.id,
        kind: 'draft',
        message: message(i),
        summary: `Drafted a reply to ${i.note?.requester.name || i.note?.requester.address || from(i)}`,
        outcome,
        recovery: 'exact-undo',
        undo: 'Discard the draft; the mailbox never saw it',
        materialId: outcome === 'DONE' ? i.draft.document : undefined,
        decidable: false,
        detail: outcome === 'REFUSED' ? `Not drafted: ${REASON[d.route_reason ?? ''] ?? d.route_reason}.` : outcome === 'UNKNOWN' ? 'The app stopped during this write; it is not written again. Check the draft.' : undefined,
      };
      if (outcome === 'DONE') counts.drafted++;
      done.push(draft);
    }
    let proposal: BriefItem | null = null;
    const p = i.proposal?.effect ? effects.get(i.proposal.effect) : undefined;
    if (i.proposal && p) {
      const outcome = proposalOutcome(p);
      proposal = {
        effect: p.id,
        kind: 'proposal',
        message: message(i),
        summary: i.proposal.summary,
        outcome,
        recovery: (i.proposal.recovery as RecoveryClass | null) ?? null,
        undo: i.proposal.undo,
        undoable: outcome === 'DONE' && !!i.proposal.undoRequest && !i.proposal.undoEffect && !state.disconnecting && !state.stoppedByPerson && state.capabilities.at(-1)?.state === 'active' && !!state.connection && i.proposal.binding?.provider === state.connection.provider && i.proposal.binding?.account === state.connection.account && i.proposal.binding?.registration === state.connection.registration.id,
        decidable: outcome === 'PROPOSED',
        detail: outcome === 'ACCEPTED' ? 'Accepted; it waits until writes to the mailbox open.' : outcome === 'REFUSED' ? `Not proposed: ${REASON[p.route_reason ?? ''] ?? p.route_reason}.` : outcome === 'UNKNOWN' ? 'The provider did not answer; a probe settles it, and it is never sent again.' : undefined,
      };
      if (outcome === 'PROPOSED') counts.proposed++;
      if (outcome === 'ACCEPTED' || outcome === 'DONE') counts.accepted++;
      if (outcome === 'DISCARDED') counts.discarded++;
      proposed.push(proposal);
    }
    for (const x of [draft, proposal]) {
      if (x?.outcome === 'UNKNOWN') counts.unknown++;
      if (x?.outcome === 'REFUSED') counts.refused++;
    }
    if (i.needsYou) {
      counts.needsYou++;
      needsYou.push({ message: message(i), reason: i.needsYou });
    }
    if (!restorations.includes(i)) requests.push({
      id: i.id,
      from: from(i),
      subject: i.subject,
      requester: i.note ? (i.note.requester.name ? `${i.note.requester.name} <${i.note.requester.address}>` : i.note.requester.address) : null,
      category: i.note?.category ?? null,
      urgency: i.note?.urgency ?? null,
      suspicious: !!i.note?.suspicious,
      needsYou: i.needsYou ?? null,
      draft,
      proposal,
    });
  }
  // A reconnect or later item version must not hide uncertainty from an older task/item.
  const visible = new Set([...done, ...proposed].map((i) => i.effect));
  for (const e of effects.values()) {
    if (e.status !== 'unknown' || visible.has(e.id)) continue;
    const mail = e.operation.startsWith('mail.');
    const deadline = e.resolve_by instanceof Date ? e.resolve_by.toISOString() : e.resolve_by;
    const retained: BriefItem = {
      effect: e.id, kind: mail ? 'proposal' : 'draft', outcome: 'UNKNOWN',
      message: { id: String(e.args?.message ?? e.args?.id ?? e.id), from: 'Earlier mailbox work', subject: 'Unresolved operation' },
      summary: `Unresolved earlier ${mail ? 'mailbox change' : 'draft'}`,
      recovery: e.operation === 'workspace.write_document' ? 'exact-undo' : null,
      undo: null, decidable: false,
      detail: `UNKNOWN receipt ${e.id}.${e.resolver_id ? ` Resolver: ${e.resolver_id}.` : ''}${deadline ? ` Review by: ${deadline}.` : ''} Inspect and reconcile it; it is not resent.`,
    };
    (mail ? proposed : done).push(retained);
    counts.unknown++;
  }
  const last = state.runs.at(-1);
  const stopped = last && last.outcome && last.outcome !== 'done' ? (last.reason ?? last.outcome) : null;
  return { done, proposed, needsYou, requests, counts, stopped };
}

export function viewOf(state: Stored, effects: Map<string, EffectView>, extra: Pick<TriageView, 'available' | 'offer' | 'running' | 'writes'>): TriageView {
  const c = state.capabilities.at(-1) ?? null;
  const capability: CapabilityView | null = c && {
    id: c.payload.id,
    version: c.payload.version,
    state: c.state === 'active' && Date.parse(c.payload.expiresAt) <= Date.now() ? 'expired' : c.state,
    hash: c.hash,
    summary: summaryOf(c.payload),
    effectiveSummary: c.effective && JSON.stringify(c.effective) !== JSON.stringify(c.payload) ? summaryOf(c.effective) : undefined,
    signedAt: c.signedAt,
    signedWith: c.signedWith,
    expiresAt: c.payload.expiresAt,
    reason: c.reason ?? null,
  };
  const conn = state.connection;
  const last = state.runs.at(-1);
  return {
    ...extra,
    connection: conn && { provider: conn.provider, account: conn.account, label: conn.label, detail: conn.detail, readOnly: capability?.state !== 'active' },
    capability,
    lastRun: last ? { startedAt: last.startedAt, endedAt: last.endedAt ?? null, outcome: last.outcome ?? null, reason: last.reason ?? null, handled: last.handled } : null,
    projectId: conn?.projectId ?? null,
    brief: briefOf(state, effects),
  };
}
