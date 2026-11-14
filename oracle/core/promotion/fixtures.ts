import { randomUUID } from 'node:crypto';
import type { Id, Session } from '../../target.ts';
import { candidateWithEvidence, requestPromotion, verifierAnswer, type World } from '../harness.ts';

/** Knowledge as a member reads it, with the terms it was accepted under. */
export interface KnowledgeRecord {
  id: Id;
  candidate: Id;
  decision: Id;
  owner: Id;
  statement: string;
  topic: string;
  status: string;
  validFrom: Date;
  validTo: Date | null;
  retractedReason: string | null;
}

export interface CandidateRecord {
  id: Id;
  statement: string;
  status: string;
  proposedBy: Id;
  owner: Id | null;
}

export const knowledgeOf = (w: Pick<World, 'owner$'>, candidate: Id) =>
  w.owner$.observe<KnowledgeRecord>('pro.knowledge', { candidate });

export async function knowledge(w: Pick<World, 'owner$'>, id: Id): Promise<KnowledgeRecord> {
  const [row] = await w.owner$.observe<KnowledgeRecord>('pro.knowledge', { id });
  if (!row) throw new Error(`knowledge ${id} is not visible to the owner`);
  return row;
}

export async function candidate(w: Pick<World, 'owner$'>, id: Id): Promise<CandidateRecord> {
  const [row] = await w.owner$.observe<CandidateRecord>('pro.candidate', { id });
  if (!row) throw new Error(`candidate ${id} is not visible to the owner`);
  return row;
}

/** Questions asked about a subject (a candidate). */
export const questionsAbout = (w: Pick<World, 'owner$'>, subject: Id) =>
  w.owner$.observe('decision', { subject });

/** Ledger entries of one type about one subject, as the owner reads them. */
export async function entries(session: Session, subject: Id, type: string) {
  const rows = await session.observe<{ type: string; actor: Id | null; payload: Record<string, unknown> }>(
    'ledger',
    { subject },
  );
  return rows.filter((r) => r.type === type);
}

/** Knowledge owned by `owner`, accepted through an independent verifier's answer; returns its id. */
export async function accepted(w: World, owner: Id): Promise<Id> {
  const text = `Recorded correction source ${randomUUID()}`;
  const { candidate: c } = await candidateWithEvidence(w, text, text);
  await verifierAnswer(w.verifier$, w, await requestPromotion(w, c, w.agent$, owner));
  const [row] = await knowledgeOf(w, c);
  if (!row) throw new Error('the approved candidate was not promoted');
  return row.id;
}
