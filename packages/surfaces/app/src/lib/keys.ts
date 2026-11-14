// Pane shortcuts (R-UX-KEYS-01; thread-app contract): shared where Codex and Claude agree, Codex's otherwise.
import type { TabKind } from './state';

export interface Shortcut {
  kind: Exclude<TabKind, 'file' | 'launcher'>;
  label: string;
  keys: { mac: string; other: string };
  match(e: KeyboardEvent, mac: boolean): boolean;
}

export const SHORTCUTS: Shortcut[] = [
  { kind: 'changes', label: 'Changes', keys: { mac: '⌃⇧G', other: 'Ctrl+Shift+G' }, match: (e) => e.ctrlKey && e.shiftKey && !e.metaKey && e.code === 'KeyG' },
  { kind: 'terminal', label: 'Terminal', keys: { mac: '⌃`', other: 'Ctrl+`' }, match: (e) => e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === 'Backquote' },
  { kind: 'files', label: 'Files', keys: { mac: '⌘P', other: 'Ctrl+P' }, match: (e, mac) => (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey) && !e.shiftKey && !e.altKey && e.code === 'KeyP' },
  { kind: 'side-chat', label: 'Side chat', keys: { mac: '⌥⌘S', other: 'Ctrl+Alt+S' }, match: (e, mac) => e.altKey && (mac ? e.metaKey : e.ctrlKey) && e.code === 'KeyS' },
];

export const shortcutFor = (kind: string, mac: boolean) => {
  const s = SHORTCUTS.find((x) => x.kind === kind);
  return s ? (mac ? s.keys.mac : s.keys.other) : undefined;
};
