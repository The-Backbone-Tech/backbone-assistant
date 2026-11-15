// Pane shortcuts (R-UX-KEYS-01; thread-app contract): shared where Codex and Claude agree, Codex's otherwise.
import type { TabKind } from './state';

export interface Shortcut {
  kind: Exclude<TabKind, 'file' | 'launcher'>;
  label: string;
  keys: { mac: string; other: string };
  match(e: KeyboardEvent, mac: boolean): boolean;
}

export const SHORTCUTS: Shortcut[] = [
  { kind: 'browser', label: 'Browser', keys: { mac: '⌘⇧B', other: 'Ctrl+Shift+B' }, match: (e, mac) => (mac ? e.metaKey : e.ctrlKey) && e.shiftKey && !e.altKey && e.code === 'KeyB' },
  { kind: 'changes', label: 'Changes', keys: { mac: '⌃⇧G', other: 'Ctrl+Shift+G' }, match: (e) => e.ctrlKey && e.shiftKey && !e.metaKey && e.code === 'KeyG' },
  { kind: 'terminal', label: 'Terminal', keys: { mac: '⌃`', other: 'Ctrl+`' }, match: (e) => e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === 'Backquote' },
  { kind: 'files', label: 'Files', keys: { mac: '⌘P', other: 'Ctrl+P' }, match: (e, mac) => (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey) && !e.shiftKey && !e.altKey && e.code === 'KeyP' },
  { kind: 'side-chat', label: 'Side chat', keys: { mac: '⌥⌘S', other: 'Ctrl+Alt+S' }, match: (e, mac) => e.altKey && (mac ? e.metaKey : e.ctrlKey) && e.code === 'KeyS' },
];

export const shortcutFor = (kind: string, mac: boolean) => {
  const s = SHORTCUTS.find((x) => x.kind === kind);
  return s ? (mac ? s.keys.mac : s.keys.other) : undefined;
};

/**
 * Shortcuts of controls that are not pane tools, by the control's accessible name. The help on an icon-only
 * control (`Tip`) reads its shortcut here, so a key shown is a key registered. Add a control's entry when its
 * shortcut is added; the handler itself stays with the control's owner.
 */
export const CONTROL_SHORTCUTS: Record<string, { mac: string; other: string }> = {
  'New conversation': { mac: '⇧⌘O', other: 'Ctrl+Shift+O' },
  'New chat': { mac: '⇧⌘O', other: 'Ctrl+Shift+O' },
  ...Object.fromEntries(SHORTCUTS.map((s) => [`Open ${s.label}`, s.keys])),
};
