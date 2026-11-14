// The file tree's behaviour, from the old FileExplorer's specification: folders from path segments,
// folders first, accent-blind filtering into a flat list, and the ARIA tree keyboard.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTree, comparer, keyAction, sortDeep, type TreeFile, visibleRows } from '../src/components/files/tree.ts';

const files: TreeFile[] = [
  { key: 'b', path: 'notes/brief.md', modified: '2026-10-02T00:00:00Z', size: 30 },
  { key: 'c', path: 'notes/Café plan.md', modified: '2026-10-03T00:00:00Z', size: 10 },
  { key: 'd', path: 'data.xlsx', modified: '2026-10-01T00:00:00Z', size: 500 },
  { key: 'a', path: 'notes/archive/old.txt', modified: '2026-09-01T00:00:00Z', size: 5 },
  { key: 'z', path: 'zeta.md', size: 1 },
];
const byName = comparer({ key: 'name', descending: false });
const tree = sortDeep(buildTree(files), byName);
const names = (rows: ReturnType<typeof visibleRows>) => rows.map((r) => `${'  '.repeat(r.level - 1)}${r.node.name}`);

test('folders come from path segments and sort first; files follow by name', () => {
  assert.deepEqual(names(visibleRows(files, tree, new Set(), '', byName)), ['notes', 'data.xlsx', 'zeta.md']);
  const open = new Set(['dir:notes', 'dir:notes/archive']);
  assert.deepEqual(names(visibleRows(files, tree, open, '', byName)), ['notes', '  archive', '    old.txt', '  brief.md', '  Café plan.md', 'data.xlsx', 'zeta.md']);
});

test('sorting by size or modified keeps folders first and puts unknown values last', () => {
  const bySize = comparer({ key: 'size', descending: true });
  assert.deepEqual(names(visibleRows(files, sortDeep(buildTree(files), bySize), new Set(), '', bySize)), ['notes', 'data.xlsx', 'zeta.md']);
  const byModified = comparer({ key: 'modified', descending: false });
  const top = sortDeep(buildTree(files), byModified).map((n) => n.name);
  assert.deepEqual(top, ['notes', 'data.xlsx', 'zeta.md']);
});

test('a filter is a flat list of matches, case and accents set aside, saying which folder holds each', () => {
  const rows = visibleRows(files, tree, new Set(), 'cafe', byName);
  assert.deepEqual(rows.map((r) => [r.node.name, r.within]), [['Café plan.md', 'notes']]);
  assert.equal(visibleRows(files, tree, new Set(), 'nothing', byName).length, 0);
});

test('keyboard follows the ARIA tree pattern', () => {
  const open = new Set(['dir:notes']);
  const rows = visibleRows(files, tree, open, '', byName);
  // notes, archive, brief.md, Café plan.md, data.xlsx, zeta.md
  assert.deepEqual(keyAction(rows, 0, 'ArrowDown', false, open), { focus: 1 });
  assert.deepEqual(keyAction(rows, 0, 'ArrowUp', false, open), { focus: 0 });
  assert.deepEqual(keyAction(rows, 3, 'End', false, open), { focus: rows.length - 1 });
  assert.deepEqual(keyAction(rows, 3, 'Home', false, open), { focus: 0 });
  assert.deepEqual(keyAction(rows, 1, 'ArrowRight', false, open), { toggle: 'dir:notes/archive', open: true });
  assert.deepEqual(keyAction(rows, 0, 'ArrowRight', false, open), { focus: 1 }, 'an open folder: Right moves to its first child');
  assert.deepEqual(keyAction(rows, 0, 'ArrowLeft', false, open), { toggle: 'dir:notes', open: false });
  assert.deepEqual(keyAction(rows, 2, 'ArrowLeft', false, open), { focus: 0 }, 'a file: Left moves to its folder');
  assert.equal(keyAction(rows, 4, 'ArrowLeft', false, open), null, 'a top-level file has no parent');
  assert.deepEqual(keyAction(rows, 2, 'Enter', false, open), { activate: true });
  assert.deepEqual(keyAction(rows, 2, 'F10', true, open), { menu: true });
  assert.equal(keyAction(rows, 2, 'F10', false, open), null);
  assert.equal(keyAction(rows, 0, 'ContextMenu', false, open), null, 'folders have no menu');
});
