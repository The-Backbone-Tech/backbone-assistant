// The native question owns the answer. The renderer supplies only the exact turn identity.
import type { Host } from '@backbone-next/platform/composition';
import { unknownCheckConfirmation, type UnknownCheck, type Receipt } from '@backbone-next/platform';
import type { MessageBoxOptions } from 'electron';

export async function confirmUnknownCheck(host: Host, request: unknown, show: (options: MessageBoxOptions) => Promise<{ response: number }>, appName: string, signal?: AbortSignal): Promise<Receipt<UnknownCheck>> {
  const refuse = (detail: string): Receipt<UnknownCheck> => ({ ok: false, outcome: 'REFUSED', reason: 'NOT_AVAILABLE', detail });
  if (!request || typeof request !== 'object') return refuse('Choose the conversation and turn.');
  const { threadId, turnId } = request as { threadId: string; turnId: string };
  const q = await host.unknownChecks.question({ threadId, turnId }, signal);
  if (!q.ok) return q;
  const answer = await show({ type: 'question', message: unknownCheckConfirmation(appName),
    detail: `Conversation: ${threadId}\nTurn: ${turnId}\n${q.value.steps.map(s => `${s.at}: ${JSON.stringify(s.label)}`).join('\n')}`,
    buttons: ['Mark as checked', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true });
  if (answer.response !== 0 || signal?.aborted) return refuse('Nothing was marked as checked.');
  return host.unknownChecks.check({ threadId, turnId, revision: q.value.revision }, signal);
}
