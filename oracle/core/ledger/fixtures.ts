import type { Id, Session, Target } from '../../target.ts';

/** One ledger entry as a member reads it. */
export interface Entry {
  seq: number;
  type: string;
  actor: Id | null;
  subject: string | null;
  payload: Record<string, unknown>;
  text: string;
}

export const ledgerOf = (session: Session, subject?: string) =>
  session.observe<Entry>('ledger', subject === undefined ? {} : { subject });

/** A 64-hex digest. */
export const DIGEST = /^[0-9a-f]{64}$/;

export interface Claimed {
  workspace: Id;
  run: Id;
  fence: number;
  secret: string;
}

/** Ask the cross-workspace queue for the next claimable run, from an empty session. */
export const claimNext = (t: Target, worker = 'w1') =>
  t.setWorkspace(null).call<Claimed | null>('run.claim_next', { worker, leaseMs: 60_000 });
