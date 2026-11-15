// New chat is a request to write. A click leaves the keyboard on the control that was clicked, and the
// message box otherwise takes focus only when nothing else has it, so the first keys typed after New chat
// went nowhere. The request is kept briefly because the new-chat view may still be mounting when it is made.
const REQUEST_LASTS_MS = 5_000;
let requestedAt = 0;
const listeners = new Set<() => void>();

export function requestComposerFocus(now = Date.now()): void {
  requestedAt = now;
  for (const listener of [...listeners]) listener();
}

/** True once per request, and only while the request is recent. */
export function takeComposerFocusRequest(now = Date.now()): boolean {
  const wanted = requestedAt > 0 && now - requestedAt <= REQUEST_LASTS_MS;
  requestedAt = 0;
  return wanted;
}

export function onComposerFocusRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
