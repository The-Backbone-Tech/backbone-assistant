import type { Receipt } from '@backbone-next/platform';
import type { Host } from '@backbone-next/platform/composition';

/** Main has checked the sender. This command can only end, never give or widen a signature. */
export async function endConnectorSignature(host: Pick<Host, 'endConnectorSignature'>, serverId: unknown, tool: unknown): Promise<Receipt<{ ended: true }>> {
  if (typeof serverId !== 'string' || !serverId || serverId.length > 1024 || typeof tool !== 'string' || !tool || tool.length > 1024)
    return { ok: false, reason: 'INVALID', outcome: 'REFUSED', detail: 'A server and tool of at most 1024 characters each are required.' };
  try { return await host.endConnectorSignature(serverId, tool); }
  catch {
    // Local removal may have committed. Use only the Host's fixed diagnostic, never backend text.
    return { ok: false, reason: 'NOT_AVAILABLE', outcome: 'UNKNOWN',
      detail: 'The permission end could not be confirmed. Local authority stays closed and its receipt will be retried. Run backbone doctor.' };
  }
}
