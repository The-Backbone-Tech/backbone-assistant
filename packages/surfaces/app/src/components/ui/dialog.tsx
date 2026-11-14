import { Dialog as D } from 'radix-ui';
import * as React from 'react';
import { cn } from '../../lib/utils';

export const Dialog = D.Root;
export const DialogClose = D.Close;

/** `bare` keeps the title for assistive technology only and lets the content draw its own frame. */
export function DialogContent({ className, title, description, bare, children, onOpenAutoFocus, onCloseAutoFocus, ...props }: React.ComponentProps<typeof D.Content> & { title: string; description?: string; bare?: boolean }) {
  // Dialogs here open from state, so Radix has no trigger to return to; the opener gets focus back.
  const opener = React.useRef<HTMLElement>(null);
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-black/40" />
      <D.Content
        className={cn('fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface text-fg shadow-xl', !bare && 'p-5', className)}
        onOpenAutoFocus={(e) => { opener.current = document.activeElement as HTMLElement; onOpenAutoFocus?.(e); }}
        onCloseAutoFocus={(e) => { onCloseAutoFocus?.(e); if (!e.defaultPrevented && opener.current?.isConnected) { e.preventDefault(); opener.current.focus(); } }}
        {...props}
      >
        <D.Title className={bare ? 'sr-only' : 'text-base font-semibold'}>{title}</D.Title>
        {description ? <D.Description className={bare ? 'sr-only' : 'mt-1 text-sm text-muted'}>{description}</D.Description> : <D.Description className="sr-only">{title}</D.Description>}
        {bare ? children : <div className="mt-4">{children}</div>}
      </D.Content>
    </D.Portal>
  );
}
