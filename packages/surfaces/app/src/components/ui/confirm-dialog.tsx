import * as React from 'react';
import { Button } from './button';
import { Dialog, DialogClose, DialogContent } from './dialog';

/**
 * The one confirmation for a change that cannot be undone inside the app (a change that can be undone gets an Undo, not
 * this). A short question names the thing; one sentence says the consequence; Cancel has focus when it opens; the danger
 * button is named by the act and is never the default; Escape cancels; focus returns to the control that opened it, or to
 * `restoreFocus()` when that control is gone or disabled. While the request is pending nothing can be sent twice.
 */
export function ConfirmDialog({ open, onOpenChange, title, consequence, action, onConfirm, restoreFocus }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** A short question naming the person or thing: "Remove Ana?". */
  title: string;
  /** One plain sentence on what happens, with real numbers where the page has them. */
  consequence: string;
  /** The act, as the danger button says it: "Remove Ana". */
  action: string;
  /** Resolves when the request has been answered, whatever the answer; the page shows the outcome. */
  onConfirm(): Promise<unknown> | void;
  /** Where focus goes if the opener no longer takes it (its row is gone, or the control is now disabled). */
  restoreFocus?(): HTMLElement | null | undefined;
}) {
  const cancel = React.useRef<HTMLButtonElement>(null);
  const opener = React.useRef<HTMLElement | null>(null);
  const [pending, setPending] = React.useState(false);
  const sent = React.useRef(false);
  // Radix reads the close handler after the dialog has unmounted; keep the target the page chose while it was open.
  const fallback = React.useRef(restoreFocus);
  if (open) fallback.current = restoreFocus;
  // Escape cancels this question only: take the key before the dialog beneath it (Settings) can hear it.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation(); event.preventDefault();
      if (!sent.current) onOpenChange(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onOpenChange]);
  const confirm = async () => {
    if (sent.current) return;
    sent.current = true; setPending(true);
    try { await onConfirm(); } finally { sent.current = false; setPending(false); onOpenChange(false); }
  };
  return <Dialog open={open} onOpenChange={next => { if (!pending) onOpenChange(next); }}>
    <DialogContent title={title} description={consequence}
      onOpenAutoFocus={event => { opener.current = document.activeElement as HTMLElement | null; event.preventDefault(); cancel.current?.focus(); }}
      onCloseAutoFocus={event => {
        event.preventDefault();
        const back = opener.current;
        const target = back?.isConnected && !(back as HTMLButtonElement).disabled ? back : fallback.current?.();
        target?.focus();
      }}
      onEscapeKeyDown={event => event.preventDefault()}
      onInteractOutside={event => { if (pending) event.preventDefault(); }}>
      <div className="flex justify-end gap-2" aria-busy={pending}>
        <DialogClose asChild><Button ref={cancel} variant="outline" disabled={pending}>Cancel</Button></DialogClose>
        <Button variant="danger" disabled={pending} onClick={() => void confirm()}>{pending ? 'Working…' : action}</Button>
      </div>
    </DialogContent>
  </Dialog>;
}
