import type { Method, Receipt } from '@backbone-next/platform';
import type { Host } from '@backbone-next/platform/composition';

/** Used by both page transports. A page can request the native dialog, never authorize a program. */
export function callFromRenderer(host: Pick<Host, 'call'>, method: Method, args: unknown): Promise<unknown> {
  const fields = args && typeof args === 'object' ? args as Record<string, unknown> : {};
  const patch = fields.patch && typeof fields.patch === 'object' ? fields.patch : {};
  if ((method === 'schedules.create' && 'wakeGate' in fields) || (method === 'schedules.update' && 'wakeGate' in patch)) {
    const refusal: Receipt<never> = { ok: false, reason: 'NOT_AVAILABLE', outcome: 'REFUSED', detail: 'A script wake gate must be shown and confirmed in the desktop app’s native dialog.' };
    return Promise.resolve(refusal);
  }
  return host.call(method, args as never);
}
