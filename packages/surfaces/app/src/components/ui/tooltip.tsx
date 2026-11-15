import { Tooltip as T } from 'radix-ui';
import type * as React from 'react';
import { isMac } from '../../lib/api';
import { CONTROL_SHORTCUTS } from '../../lib/keys';
import { cn } from '../../lib/utils';

/**
 * Help for an icon-only control: its accessible name, and its shortcut when it has one. It opens after a short
 * delay on hover and at once on keyboard focus, in the popover's own styling.
 */
export function Tip({ label, shortcut, children }: { label: string; shortcut?: string; children: React.ReactElement }) {
  const keys = shortcut ?? (CONTROL_SHORTCUTS[label] ? CONTROL_SHORTCUTS[label][isMac() ? 'mac' : 'other'] : undefined);
  shortcut = keys;
  // Help never takes a click meant for a control it happens to cover (a tab row's Close pane, say).
  return (
    <T.Provider delayDuration={500} skipDelayDuration={200}>
      <T.Root>
        {/* Keyboard focus opens it at once; focus set by the app (a dialog opening on its close button) does not.
            A text field counts as keyboard-focused to the browser however it got focus, so its help would open by
            itself over whatever is beside it: a text field shows its help on hover only. */}
        <T.Trigger asChild onFocus={(e) => { if (!e.currentTarget.matches(':focus-visible') || e.currentTarget.matches('input, textarea')) e.preventDefault(); }}>{children}</T.Trigger>
        <T.Portal>
          <T.Content
            sideOffset={6}
            collisionPadding={8}
            data-tip className={cn('pointer-events-none z-50 flex items-center gap-2 rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg shadow-lg')}
          >
            {label}
            {shortcut && <kbd className="font-sans tracking-wider text-muted">{shortcut}</kbd>}
          </T.Content>
        </T.Portal>
      </T.Root>
    </T.Provider>
  );
}
