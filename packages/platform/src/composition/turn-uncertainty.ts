import { unknownChecked } from './unknown-checks.ts';
import type { HeldCall, Turn } from '../api.ts';

/** Unknowns without exact provenance, including old turns, are never inferred resolved. */
export async function turnUnresolved(threadId: string, turn: Turn, verified: (threadId: string, turnId: string, effect: string) => Promise<boolean>, held: readonly Pick<HeldCall, 'threadId' | 'turnId' | 'effect' | 'state'>[] = []): Promise<boolean> {
  // A killed send can leave durable custody without ever returning a turn marker.
  const calls = held.filter(call => call.threadId === threadId && call.turnId === turn.id && (call.state === 'waiting' || call.state === 'unknown'));
  if (!turn.unknownOutcome && !calls.length) return false;
  const evidence = turn.unknownEvidence;
  if (turn.unknownOutcome && !unknownChecked(turn) && (!evidence || evidence.other || !Array.isArray(evidence.connectorEffects) || !evidence.connectorEffects.length || evidence.connectorEffects.some(id => typeof id !== 'string' || !id))) return true;
  try {
    for (const effect of new Set([...calls.map(call => call.effect), ...(turn.unknownOutcome ? evidence?.connectorEffects ?? [] : [])])) if (!await verified(threadId, turn.id, effect)) return true;
    return false;
  } catch { return true; }
}
