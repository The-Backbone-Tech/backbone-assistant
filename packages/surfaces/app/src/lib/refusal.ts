// What a change's failed answer tells the person, read one way on every Team screen. Only a refused
// receipt is a refusal: the page transport (electron/refusal.ts) has already turned each named refusal
// into one. A throw, a lost response or an unknown receipt is not known, whatever its text says, so it is
// never shown as a refusal and the change is never repeated to clear it.

/** A refusal says nothing was changed and why; `sharedWork` when setting a model for shared work is the way on. */
export type ChangeFailure = { kind: 'refused'; detail: string; sharedWork: boolean } | { kind: 'unknown' };

export function changeFailure(answer: unknown): ChangeFailure {
  const receipt = answer as { ok?: unknown; outcome?: unknown; reason?: unknown; detail?: unknown } | null | undefined;
  if (receipt && typeof receipt === 'object' && !(receipt instanceof Error) && receipt.ok === false && receipt.outcome === 'REFUSED') {
    return { kind: 'refused', detail: typeof receipt.detail === 'string' ? receipt.detail : '', sharedWork: receipt.reason === 'SHARED_WORK_REQUIRED' };
  }
  return { kind: 'unknown' };
}
