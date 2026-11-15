// One declaration of an item's actions, offered by its menu button and by right-click, so the two never differ.
// An area declares `MenuEntry[]` once, then renders them with `ItemMenuButton` (the "more" button's menu) and
// `ItemContextMenu` (the right-click menu, also opened by the Menu key and Shift+F10 on the focused item).
import * as React from 'react';
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuRadioGroup, ContextMenuRadioItem, ContextMenuSeparator,
  ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger,
} from './context-menu';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from './dropdown-menu';

export type MenuEntry =
  | { kind: 'item'; id: string; label: React.ReactNode; icon?: React.ReactNode; danger?: boolean; disabled?: boolean; onSelect(): void }
  | { kind: 'separator'; id: string }
  /** A choice of one value, shown as a submenu. */
  | { kind: 'choice'; id: string; label: React.ReactNode; value: string; onValueChange(value: string): void; options: { value: string; label: React.ReactNode }[] }
  /** A submenu of further entries, with an optional note above them. */
  | { kind: 'sub'; id: string; label: React.ReactNode; note?: React.ReactNode; entries: MenuEntry[] };

const dropdownKit = { Item: DropdownMenuItem, Label: DropdownMenuLabel, RadioGroup: DropdownMenuRadioGroup, RadioItem: DropdownMenuRadioItem, Separator: DropdownMenuSeparator, Sub: DropdownMenuSub, SubContent: DropdownMenuSubContent, SubTrigger: DropdownMenuSubTrigger };
const contextKit = { Item: ContextMenuItem, Label: ContextMenuLabel, RadioGroup: ContextMenuRadioGroup, RadioItem: ContextMenuRadioItem, Separator: ContextMenuSeparator, Sub: ContextMenuSub, SubContent: ContextMenuSubContent, SubTrigger: ContextMenuSubTrigger };

function Entries({ kit: K, entries }: { kit: typeof dropdownKit | typeof contextKit; entries: MenuEntry[] }) {
  return (
    <>
      {entries.map((e) => {
        if (e.kind === 'separator') return <K.Separator key={e.id} />;
        if (e.kind === 'item') return <K.Item key={e.id} className={e.danger ? 'text-danger' : undefined} disabled={e.disabled} onSelect={e.onSelect}>{e.icon}{e.icon ? ' ' : ''}{e.label}</K.Item>;
        if (e.kind === 'choice') {
          return (
            <K.Sub key={e.id}>
              <K.SubTrigger>{e.label}</K.SubTrigger>
              <K.SubContent>
                <K.RadioGroup value={e.value} onValueChange={e.onValueChange}>
                  {e.options.map((o) => <K.RadioItem key={o.value} value={o.value}>{o.label}</K.RadioItem>)}
                </K.RadioGroup>
              </K.SubContent>
            </K.Sub>
          );
        }
        return (
          <K.Sub key={e.id}>
            <K.SubTrigger>{e.label}</K.SubTrigger>
            <K.SubContent>
              {e.note && <K.Label>{e.note}</K.Label>}
              <Entries kit={K} entries={e.entries} />
            </K.SubContent>
          </K.Sub>
        );
      })}
    </>
  );
}

/** The "more" button's menu. `trigger` is the icon button (it needs an accessible name). */
export function ItemMenuButton({ entries, trigger, align = 'end', focusTarget }: { entries: MenuEntry[]; trigger: React.ReactElement; align?: 'start' | 'center' | 'end'; focusTarget?: () => HTMLElement | null }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} onCloseAutoFocus={focusTarget ? (event) => {
        // A row may replace itself with an input. Focus it after the menu releases its focus trap.
        if (focusTarget()) { event.preventDefault(); setTimeout(() => focusTarget()?.focus()); }
      } : undefined}><Entries kit={dropdownKit} entries={entries} /></DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The right-click menu over `children` (one element that takes a ref). It opens at the pointer, from the Menu key
 * and Shift+F10, closes on Escape and returns focus to `focusTarget` (a selector inside the element, looked
 * up after the menu has closed, so an item that swapped itself for a field can be named too). A text field inside keeps the system's menu if it stops the event.
 */
export const ItemContextMenu = React.forwardRef<HTMLElement, { entries: MenuEntry[]; children: React.ReactElement; disabled?: boolean; focusTarget?: string; }>(
  function ItemContextMenu({ entries, children, disabled, focusTarget }, forwarded) {
    const own = React.useRef<HTMLElement | null>(null);
    const element = (node: HTMLElement | null) => { own.current = node; if (typeof forwarded === 'function') forwarded(node); else if (forwarded) forwarded.current = node; };
    // The Menu key and Shift+F10 open the menu at the focused item on every system, as a right-click there would.
    const openFromKey = (e: React.KeyboardEvent) => {
      if (disabled || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return;
      e.preventDefault();
      const box = (e.target as HTMLElement).getBoundingClientRect();
      (e.target as HTMLElement).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 16, clientY: box.bottom - 4 }));
    };
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild disabled={disabled}>{React.cloneElement(children as React.ReactElement<{ ref?: React.Ref<HTMLElement>; onKeyDown?: React.KeyboardEventHandler }>, { ref: element, onKeyDown: openFromKey })}</ContextMenuTrigger>
        {!disabled && (
          <ContextMenuContent onCloseAutoFocus={(e) => { e.preventDefault(); setTimeout(() => own.current?.querySelector<HTMLElement>(focusTarget ?? '[data-menu-focus]')?.focus()); }}>
            <Entries kit={contextKit} entries={entries} />
          </ContextMenuContent>
        )}
      </ContextMenu>
    );
  },
);

/** A menu with no item of its own, like the empty part of a list: the same panel, from the same entries. */
export function AreaContextMenu({ entries, children }: { entries: MenuEntry[]; children: React.ReactElement }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent><Entries kit={contextKit} entries={entries} /></ContextMenuContent>
    </ContextMenu>
  );
}
