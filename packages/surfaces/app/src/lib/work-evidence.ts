// A reading view of existing turn/material records. Matching a version is not a proof of correctness.
import type { FileLink, MaterialEntry, Turn } from '@backbone-next/platform';

export interface EvidenceLink {
  file: FileLink;
  role: 'read' | 'available' | 'attached' | 'output';
  state: 'current' | 'changed' | 'withdrawn' | 'access-changed' | 'held' | 'missing' | 'unknown';
  note: string;
  canOpen: boolean;
}

export function workEvidence(turn: Turn, entries: MaterialEntry[] | undefined): { sources: EvidenceLink[]; available: EvidenceLink[]; outputs: EvidenceLink[]; incomplete: boolean } {
  // The legacy controlled harness records read activity without binding it into Turn.reads.
  // Preserve known attachments, but never manufacture identities by parsing activity prose.
  const unboundReads = turn.work?.steps?.some((step) => step.kind === 'read')
    && !turn.reads?.some((read) => !read.inherited && !read.told && !read.available);
  const hasReadSet = turn.reads !== undefined && !unboundReads;
  const byId = entries && new Map(entries.map((e) => [e.id, e]));
  const describe = (file: FileLink, role: EvidenceLink['role'], withdrawals?: number): EvidenceLink => {
    const row = (state: EvidenceLink['state'], note: string, canOpen = false): EvidenceLink => ({ file, role, state, note, canOpen });
    if (!entries) return row('unknown', 'Current state not checked.');
    const entry = byId!.get(file.materialId);
    if (!entry) return row('missing', 'No longer in the current document list.');
    const history = entry.withdrawals ?? [];
    if (history.length && !history.at(-1)!.restoredAt) return row('withdrawn', 'Withdrawn from later work.');
    if (entry.held) return row('held', 'Held for the person to resolve.');
    if ((role === 'read' || role === 'available') && history.length !== withdrawals) return row('access-changed', 'Access changed since this turn, even if restored.');
    if (!entry.versions.some((v) => v.n === file.version)) return row('missing', 'The recorded version is unavailable.');
    if (entry.current !== file.version) return row('changed', `Recorded v${file.version}; current is v${entry.current}.`, true);
    return row('current', 'Recorded version is still current.', true);
  };
  // A direct read of the same version takes precedence over its staged availability.
  const key = (r: NonNullable<Turn['reads']>[number]) => `${r.id}\0${r.version}\0${r.withdrawals}`;
  const observed = new Set((turn.reads ?? []).filter(r => !r.available).map(key));
  const available = [...new Map((turn.reads ?? []).filter(r => r.available && !observed.has(key(r))).map(r => [key(r), r])).values()];
  return {
    available: available.map(r => describe({ materialId: r.id, name: r.name, version: r.version }, 'available', r.withdrawals)),
    sources: turn.reads && (turn.reads.length > 0 || hasReadSet)
      ? turn.reads.filter(r => !r.available).map((r) => describe({ materialId: r.id, name: r.name, version: r.version }, 'read', r.withdrawals))
      : turn.user.attachments.map((f) => describe(f, 'attached')),
    outputs: (turn.answer?.files ?? []).map((f) => describe(f, 'output')),
    incomplete: !hasReadSet || !!turn.unknownSources,
  };
}
