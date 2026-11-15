import {HomeOwned} from '@backbone-next/platform/composition';
import {HomeBusy,HomeWriteUnavailable} from '@backbone-next/platform/composition/home-lock';
import {RemoteError} from '@backbone-next/platform/remote/client';
import type { Method, Receipt } from '@backbone-next/platform';
import type { Host } from '@backbone-next/platform/composition';
import { teamAnswer } from './refusal.ts';

/** Used by both page transports. A page can request the native dialog, never authorize a program. */
export function callFromRenderer(host: Pick<Host, 'call'>, method: Method, args: unknown): Promise<unknown> {
  const fields = args && typeof args === 'object' ? args as Record<string, unknown> : {};
  const patch = fields.patch && typeof fields.patch === 'object' ? fields.patch : {};
  if ((method === 'schedules.create' && 'wakeGate' in fields) || (method === 'schedules.update' && 'wakeGate' in patch)) {
    const refusal: Receipt<never> = { ok: false, reason: 'NOT_AVAILABLE', outcome: 'REFUSED', detail: 'A script wake gate must be shown and confirmed in the desktop app’s native dialog.' };
    return Promise.resolve(refusal);
  }
  // Project changes keep their own reading of a refusal; Team changes get theirs from `teamAnswer`.
  return teamAnswer(method, host.call(method, args as never).catch(error=>{
    // Preserve known pre-write refusals before Electron or HTTP removes their type.
    // A transport failure with an unknown outcome stays thrown, even if its text names a refusal.
    if(method==='projects.update'&&(
      error instanceof HomeOwned||error instanceof HomeBusy||error instanceof HomeWriteUnavailable||
      (error instanceof Error&&error.name==='IdentityRefused')||
      (error instanceof RemoteError&&error.outcome==='REFUSED')
    ))return {ok:false,reason:'NOT_AVAILABLE',outcome:'REFUSED',detail:error instanceof RemoteError?error.message:'The project change was refused. Check project access and whether this data folder is available. Nothing was changed.'};
    throw error;
  }));
}
