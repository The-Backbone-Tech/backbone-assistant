// Catalogue/history inspection only, on the caller's existing Core connection. No vault or installer.
import {SIGNATURE_LEDGER_VERSION,verifySignatureLedger} from '@backbone/core/db';
import type {StandingSignatureStatus} from '../api.ts';
import type {CoreLink} from './core.ts';
export function verifyStandingSignatures(link: Pick<CoreLink,'read'|'person'>) {
  const reader = {query: (sql: string, values?: unknown[]) => link.read(link.person(), sql, values)};
  return verifySignatureLedger(reader as unknown as Parameters<typeof verifySignatureLedger>[0]);
}
export async function standingSignatureStatus(link: Pick<CoreLink,'read'|'person'>): Promise<StandingSignatureStatus> {
  const status = await verifyStandingSignatures(link);
  return {step: SIGNATURE_LEDGER_VERSION, state: status.state};
}
