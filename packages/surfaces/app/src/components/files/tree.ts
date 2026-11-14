// The file tree's logic, kept apart from its markup so it is tested directly (test/tree.test.ts).
import type * as React from 'react';
import { KIND_LABEL, kindOf } from './kind-label.ts';

export interface TreeFile {
  key: string;
  /** Folders, then the name, joined with "/". */
  path: string;
  modified?: string;
  size?: number;
  /** Said after the name: the class, a version. */
  meta?: React.ReactNode;
}

export interface TreeAction {
  key: string;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  onSelect?: () => void;
  /** Why it is unavailable; shown in place of acting. */
  disabled?: string;
  separatorBefore?: boolean;
}

export type SortKey = 'name' | 'modified' | 'size' | 'kind';
export interface TreeSort {
  key: SortKey;
  descending: boolean;
}

export interface FolderNode {
  type: 'folder';
  key: string;
  name: string;
  path: string;
  children: Node[];
}
export interface FileNode {
  type: 'file';
  key: string;
  name: string;
  file: TreeFile;
}
export type Node = FolderNode | FileNode;

export interface Row {
  node: Node;
  level: number;
  posinset: number;
  setsize: number;
  parent: string | null;
  /** In a filtered list, the folder that holds it. */
  within?: string;
}

/** Case and accents set aside, so "cafe" finds "Café". */
export const folded = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export function buildTree(files: TreeFile[]): Node[] {
  const root: Node[] = [];
  for (const file of files) {
    const segments = file.path.split('/').filter(Boolean);
    let level = root;
    for (let at = 0; at < segments.length - 1; at++) {
      const path = segments.slice(0, at + 1).join('/');
      const key = `dir:${path}`;
      let folder = level.find((n): n is FolderNode => n.type === 'folder' && n.key === key);
      if (!folder) {
        folder = { type: 'folder', key, name: segments[at], path, children: [] };
        level.push(folder);
      }
      level = folder.children;
    }
    level.push({ type: 'file', key: `file:${file.key}`, name: segments.at(-1) ?? file.path, file });
  }
  return root;
}

export function comparer(sort: TreeSort) {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const value = (n: Node): string | number | null => {
    if (n.type !== 'file') return null;
    if (sort.key === 'kind') return KIND_LABEL[kindOf(n.name)];
    if (sort.key === 'modified') return n.file.modified ? Date.parse(n.file.modified) : null;
    if (sort.key === 'size') return n.file.size ?? null;
    return null;
  };
  return (a: Node, b: Node): number => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    const [l, r] = [value(a), value(b)];
    let order = 0;
    if (l !== null && r !== null) order = typeof l === 'number' && typeof r === 'number' ? l - r : collator.compare(String(l), String(r));
    else if (l !== null || r !== null) order = l === null ? 1 : -1;
    if (order !== 0) return sort.descending ? -order : order;
    const byName = collator.compare(a.name, b.name);
    return sort.key === 'name' && sort.descending ? -byName : byName;
  };
}

export function sortDeep(nodes: Node[], compare: (a: Node, b: Node) => number): Node[] {
  return nodes.map((n) => (n.type === 'folder' ? { ...n, children: sortDeep(n.children, compare) } : n)).sort(compare);
}


/** The rows a person sees: a filtered flat list of matches, or the tree with its open folders. */
export function visibleRows(files: TreeFile[], tree: Node[], expanded: ReadonlySet<string>, query: string, compare: (a: Node, b: Node) => number): Row[] {
  if (query.trim()) {
    const wanted = folded(query.trim());
    const found = files
      .filter((f) => folded(f.path.split('/').at(-1) ?? '').includes(wanted))
      .map<Node>((f) => ({ type: 'file', key: `file:${f.key}`, name: f.path.split('/').at(-1) ?? f.path, file: f }))
      .sort(compare);
    return found.map((node, i) => ({ node, level: 1, posinset: i + 1, setsize: found.length, parent: null, within: node.type === 'file' ? node.file.path.split('/').slice(0, -1).join('/') : '' }));
  }
  const out: Row[] = [];
  const walk = (nodes: Node[], level: number, parent: string | null) =>
    nodes.forEach((node, i) => {
      out.push({ node, level, posinset: i + 1, setsize: nodes.length, parent });
      if (node.type === 'folder' && expanded.has(node.key)) walk(node.children, level + 1, node.key);
    });
  walk(tree, 1, null);
  return out;
}

export type KeyAction = { focus: number } | { toggle: string; open: boolean } | { activate: true } | { menu: true } | null;

/** The ARIA tree pattern: what a key does on row `index`. */
export function keyAction(rows: Row[], index: number, key: string, shift: boolean, expanded: ReadonlySet<string>): KeyAction {
  const row = rows[index];
  if (!row) return null;
  const { node } = row;
  switch (key) {
    case 'ArrowDown':
      return { focus: Math.min(rows.length - 1, index + 1) };
    case 'ArrowUp':
      return { focus: Math.max(0, index - 1) };
    case 'Home':
      return { focus: 0 };
    case 'End':
      return { focus: rows.length - 1 };
    case 'ArrowRight':
      if (node.type !== 'folder') return null;
      return expanded.has(node.key) ? { focus: Math.min(rows.length - 1, index + 1) } : { toggle: node.key, open: true };
    case 'ArrowLeft':
      if (node.type === 'folder' && expanded.has(node.key)) return { toggle: node.key, open: false };
      return row.parent !== null ? { focus: rows.findIndex((r) => r.node.key === row.parent) } : null;
    case 'Enter':
    case ' ':
      return { activate: true };
    case 'ContextMenu':
      return node.type === 'file' ? { menu: true } : null;
    case 'F10':
      return shift && node.type === 'file' ? { menu: true } : null;
    default:
      return null;
  }
}
