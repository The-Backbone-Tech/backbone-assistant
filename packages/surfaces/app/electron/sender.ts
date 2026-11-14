// Electron's security checklist, item 17 ("Validate the sender of all IPC messages"): main answers
// only the app's own top-level page, loaded from the renderer file the app ships. A subframe,
// another page, or a window navigated elsewhere gets nothing.

/** The parts of Electron's WebFrameMain this check reads. */
interface Frame {
  url: string;
  parent: unknown;
}

export function trustedSender(frame: Frame | null | undefined, page: string): boolean {
  if (!frame || frame.parent) return false;
  try {
    const url = new URL(frame.url);
    const ours = new URL(page);
    return url.protocol === 'file:' && url.pathname === ours.pathname;
  } catch {
    return false;
  }
}
