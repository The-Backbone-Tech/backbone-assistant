// A proposal ID is assigned by Core. The durable pre-proposal ticket lets us find its receipt
// after a lost reply. Orphans can only be cancelled here; this path never answers or dispatches.
import type { HeldCall } from '../api.ts';
import type { CoreLink } from '../composition/core.ts';
export interface ReplacementTicket extends HeldCall { replacementKey?: string; replacementEffect?: string }
export async function recoverReplacementOrphans(link: CoreLink, held: ReplacementTicket[]): Promise<string[]> {
  const consumed: string[] = [];
  for (const original of held.filter(h => h.replacementKey && !h.replacementEffect)) {
    const row = (await link.read<{ id: string; args_hash: string; status: string }>(link.person(), 'SELECT id, args_hash, status FROM app.effects WHERE idempotency_key=$1', [original.replacementKey])).rows[0];
    if (row && !held.some(h => h.effect === row.id)) {
      if (!(await link.connectorStatementMatches(row.id, row.args_hash, original.args, original.statement))) continue;
      if (['awaiting_checker', 'allowed', 'claimed'].includes(row.status))
        await link.call(link.person(), 'SELECT gov.cancel_effect($1,$2)', [row.id, 'An interrupted person release had no retained call. Its replacement was cancelled without sending.']);
    }
    consumed.push(original.effect);
  }
  return consumed;
}
