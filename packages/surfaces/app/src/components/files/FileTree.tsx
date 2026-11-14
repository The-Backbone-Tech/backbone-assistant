// A file tree in the manner of VS Code's explorer, with the old Backbone FileExplorer's behaviour as
// its specification: folders come only from path segments; folders first, then the chosen order;
// a filter turns the tree into a flat list of matches that says which folder each is in; keyboard
// as the ARIA tree pattern (arrows, Home, End, Right and Left into and out of folders, Enter to
// open, Shift+F10 or the menu key for a file's ⋯ menu), with one row in the Tab order.
import { ChevronRight, Folder, FolderOpen, MoreHorizontal } from 'lucide-react';
import * as React from 'react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { FileIcon } from './kind';
import { buildTree, comparer, keyAction, type Row, sortDeep, type TreeAction, type TreeFile, type TreeSort, visibleRows } from './tree';

export type { SortKey, TreeAction, TreeFile, TreeSort } from './tree';

export function FileTree({ label, files, query, sort, onOpen, actions, rowTestId, selectedKey, emptyText = 'No files.' }: {
  label: string;
  files: TreeFile[];
  query: string;
  sort: TreeSort;
  onOpen: (file: TreeFile) => void;
  actions?: (file: TreeFile) => TreeAction[];
  rowTestId?: string;
  selectedKey?: string;
  emptyText?: string;
}) {
  const compare = React.useMemo(() => comparer(sort), [sort]);
  const tree = React.useMemo(() => sortDeep(buildTree(files), compare), [files, compare]);
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set());
  const [activeKey, setActiveKey] = React.useState<string | null>(null);
  const [menuKey, setMenuKey] = React.useState<string | null>(null);
  const refs = React.useRef(new Map<string, HTMLDivElement>());
  const filtering = query.trim() !== '';

  const rows = React.useMemo<Row[]>(() => visibleRows(files, tree, expanded, query, compare), [files, tree, expanded, query, compare]);

  const active = rows.some((r) => r.node.key === activeKey) ? activeKey : (rows[0]?.node.key ?? null);

  function focusRow(index: number) {
    const row = rows[Math.max(0, Math.min(rows.length - 1, index))];
    if (!row) return;
    setActiveKey(row.node.key);
    refs.current.get(row.node.key)?.focus();
  }
  const toggle = (key: string, open?: boolean) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (open ?? !next.has(key)) next.add(key);
      else next.delete(key);
      return next;
    });
  function activate(row: Row) {
    setActiveKey(row.node.key);
    if (row.node.type === 'file') onOpen(row.node.file);
    else toggle(row.node.key);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>, index: number) {
    if (e.target !== e.currentTarget) return;
    const action = keyAction(rows, index, e.key, e.shiftKey, expanded);
    if (!action) return;
    e.preventDefault();
    if ('focus' in action) focusRow(action.focus);
    else if ('toggle' in action) toggle(action.toggle, action.open);
    else if ('activate' in action) activate(rows[index]);
    else setMenuKey(rows[index].node.key);
  }

  if (rows.length === 0) return <p className="px-3 py-6 text-center text-sm text-muted">{filtering ? `No file matches “${query.trim()}”.` : emptyText}</p>;

  return (
    <div role="tree" aria-label={label} className="flex flex-col py-1">
      {rows.map((row, index) => {
        const { node } = row;
        const open = node.type === 'folder' && expanded.has(node.key);
        const nameId = `${label.replace(/\W/g, '')}-${index}`;
        const list = node.type === 'file' ? (actions?.(node.file) ?? []) : [];
        return (
          <div
            key={node.key}
            ref={(el) => {
              if (el) refs.current.set(node.key, el);
              else refs.current.delete(node.key);
            }}
            role="treeitem"
            aria-level={row.level}
            aria-setsize={row.setsize}
            aria-posinset={row.posinset}
            aria-expanded={node.type === 'folder' ? open : undefined}
            aria-selected={node.type === 'file' && selectedKey !== undefined ? node.file.key === selectedKey : undefined}
            aria-labelledby={nameId}
            tabIndex={active === node.key ? 0 : -1}
            data-testid={node.type === 'file' ? rowTestId : undefined}
            className={cn(
              'group mx-1 flex h-7 min-w-0 cursor-pointer items-center gap-1.5 rounded-md pr-1 text-sm outline-offset-[-2px] hover:bg-hover',
              node.type === 'file' && selectedKey === node.file.key && 'bg-accent-soft hover:bg-accent-soft',
            )}
            style={{ paddingLeft: 4 + (row.level - 1) * 14 }}
            onClick={() => activate(row)}
            onFocus={() => setActiveKey(node.key)}
            onKeyDown={(e) => onKeyDown(e, index)}
          >
            {node.type === 'folder' ? <ChevronRight aria-hidden className={cn('size-3.5 shrink-0 text-muted transition-transform', open && 'rotate-90')} /> : <span aria-hidden className="w-3.5 shrink-0" />}
            {node.type === 'folder' ? (
              open ? <FolderOpen aria-hidden className="size-4 shrink-0 text-muted" /> : <Folder aria-hidden className="size-4 shrink-0 text-muted" />
            ) : (
              <FileIcon name={node.name} />
            )}
            <span id={nameId} className="min-w-0 flex-1 truncate" title={node.type === 'file' ? node.file.path : node.path}>
              {node.name}
            </span>
            {row.within && <span className="max-w-[40%] shrink truncate text-xs text-muted">in {row.within}</span>}
            {node.type === 'file' && node.file.meta}
            {list.length > 0 && <RowMenu name={node.name} list={list} open={menuKey === node.key} tabbable={active === node.key} onOpenChange={(o) => setMenuKey(o ? node.key : null)} />}
          </div>
        );
      })}
    </div>
  );
}

function RowMenu({ name, list, open, tabbable, onOpenChange }: { name: string; list: TreeAction[]; open: boolean; tabbable: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          tabIndex={tabbable ? 0 : -1}
          aria-label={`More actions for ${name}`}
          className="reveal size-6 shrink-0 text-muted"
          onClick={(e) => e.stopPropagation()}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      {/* Portalled, but React still bubbles its events to the row: choosing must not also open the file. */}
      <DropdownMenuContent align="end" className="min-w-44" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        {list.map((a) => (
          <React.Fragment key={a.key}>
            {a.separatorBefore && <DropdownMenuSeparator />}
            <DropdownMenuItem
              aria-disabled={a.disabled ? true : undefined}
              className="aria-disabled:text-muted"
              onSelect={(e) => {
                if (a.disabled) return e.preventDefault();
                a.onSelect?.();
              }}
            >
              {a.icon && <a.icon />}
              {a.label}
              {a.disabled && <span className="ml-auto pl-3 text-xs text-muted">{a.disabled}</span>}
            </DropdownMenuItem>
          </React.Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
