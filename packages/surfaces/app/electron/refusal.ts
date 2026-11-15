// A named refusal becomes a refused receipt here, at the page transport, while its class is still known.
// Electron and the browser bridge both serialise a thrown error to its text, so past this point a refusal
// and an outcome that is not known would read alike. Anything not recognised below stays thrown, and the
// page reads it as not known: a refusal is never guessed from text, and nothing is retried.
import type { Method, Receipt } from '@backbone-next/platform';
import { CoreRefusal, IdentityRefused, IdentityUnavailable, SharedEngineRequired, definiteServerRefusal } from '@backbone-next/platform/composition';
import { RemoteError } from '@backbone-next/platform/remote/client';

/** The Team changes a person makes in Settings › People and roles and Sharing. Reads and sends keep their own handling. */
export const TEAM_CHANGES: ReadonlySet<Method> = new Set<Method>([
  'identity.invite', 'identity.role', 'identity.remove', 'identity.share',
  'identity.automation.create', 'identity.automation.revoke', 'identity.automation.run',
]);

const refused = (reason: 'NOT_AVAILABLE' | 'NOT_FOUND' | 'SHARED_WORK_REQUIRED', detail: string): Receipt<never> => ({ ok: false, reason, outcome: 'REFUSED', detail });

/**
 * The refused receipt for a thrown named refusal, or undefined when the error is not one. The cases
 * follow the HTTP bridge's own reading of the same classes (`identity-http.ts`), so a change refused on
 * this computer and one refused by a workspace joined over the network read the same.
 */
export function refusedReceipt(error: unknown): Receipt<never> | undefined {
  // A joined workspace answered over HTTP; only its explicit refusal is one.
  if (error instanceof RemoteError) return error.outcome === 'REFUSED' ? refused('NOT_AVAILABLE', error.message) : undefined;
  // The owner has no model for shared work: the person can set one, so the receipt names it.
  if (error instanceof SharedEngineRequired) return refused('SHARED_WORK_REQUIRED', error.message);
  if (error instanceof IdentityRefused) return refused(error.reason, error.message);
  if (error instanceof IdentityUnavailable) return refused('NOT_AVAILABLE', error.message);
  // The database refused the statement; a lost connection or an unknown commit is not a refusal.
  if (error instanceof CoreRefusal && definiteServerRefusal(error.cause)) return refused('NOT_AVAILABLE', 'Nothing was changed. Check the role and project permissions involved before trying again.');
  return undefined;
}

/** A Team change answers with a receipt; any other call is passed through unchanged. */
export function teamAnswer<T>(method: Method, pending: Promise<T>): Promise<T | Receipt<never>> {
  if (!TEAM_CHANGES.has(method)) return pending;
  return pending.catch((error: unknown) => {
    const receipt = refusedReceipt(error);
    if (receipt) return receipt;
    throw error;
  });
}
