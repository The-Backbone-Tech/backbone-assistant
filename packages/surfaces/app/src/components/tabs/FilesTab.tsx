// Files: the project's files as a tree, classed original / working / accepted (R-FILES-OS-01), with
// Review beside it. Intermediates are hidden, never deleted: they sit under a collapsed
// Archived. The lists refresh on every api event, so no restart is needed (R-FILES-REFRESH-01).
import type { MaterialEntry, ProjectFile } from '@backbone-next/platform';
import { ArrowDownUp, ChevronRight, Copy, Diff, Download, FolderOpen, Search } from 'lucide-react';
import * as React from 'react';
import { fileClassLabel, reviewFiles } from '../../lib/file-classes';
import { call, isMac } from '../../lib/api';
import { downloadMaterial } from '../../lib/download';
import { shortcutFor } from '../../lib/keys';
import { useApp, useLive } from '../../lib/state';
import { cn, focusSoon } from '../../lib/utils';
import { FileTree, type SortKey, type TreeAction, type TreeFile, type TreeSort } from '../files/FileTree';
import { Button } from '../ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';

export const CLASS_LABEL = { original: fileClassLabel('original'), working: fileClassLabel('working'), accepted: fileClassLabel('accepted'), unregistered: fileClassLabel('unregistered') };
const CLASS_TONE: Record<ProjectFile['class'], string> = { original: 'text-muted', working: 'text-draft', accepted: 'text-committed', unregistered: 'text-muted' };
const SORTS: [SortKey, string][] = [['name', 'Name'], ['modified', 'Modified'], ['size', 'Size'], ['kind', 'Kind']];

function ClassMark({ c }: { c: ProjectFile['class'] }) {
  return <span title={CLASS_LABEL[c]} className={cn('shrink-0 text-caption font-medium', CLASS_TONE[c])}>{c === 'unregistered' ? 'Unregistered' : CLASS_LABEL[c]}</span>;
}

export function FilesTab({ projectId, compact = false, active = true }: { projectId: string; compact?: boolean; active?: boolean }) {
  const { openTab, prefs } = useApp();
  const files = useLive(() => call('files.list', { projectId }), [projectId], [] as ProjectFile[]);
  const [retry, setRetry] = React.useState(0);
  const metadata = useLive(async () => {
    try { return { entries: await call('material.list', { projectId, includeHidden: true }), failed: false }; }
    catch { return { entries: [] as MaterialEntry[], failed: true }; }
  }, [projectId, retry], { entries: [] as MaterialEntry[], failed: false });
  const material = metadata.entries;
  const [query, setQuery] = React.useState('');
  const [sort, setSort] = React.useState<TreeSort>({ key: 'name', descending: false });
  const [said, setSaid] = React.useState('');
  const [view, setView] = React.useState('files');
  const input = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => { if (active) return focusSoon(() => input.current); }, [active]);

  const byId = new Map(material.map((m) => [m.id, m]));
  const facts = (id?: string) => {
    const m = id ? byId.get(id) : undefined;
    const v = m?.versions.find((x) => x.n === m.current);
    return { modified: v?.at, size: v?.bytes };
  };
  const tree: TreeFile[] = files.map((f) => ({ key: f.materialId ?? f.path, path: f.path, ...facts(f.materialId), meta: <ClassMark c={f.class} /> }));
  const archived: TreeFile[] = material.filter((m) => m.hidden).map((m) => ({ key: m.id, path: m.name, ...facts(m.id), meta: <span className="shrink-0 text-caption text-muted">{m.held ? 'Held · ' : m.withdrawals?.at(-1) && !m.withdrawals.at(-1)!.restoredAt ? 'Withdrawn · ' : ''}v{m.current}</span> }));
  const review = reviewFiles(files);
  const open = (f: TreeFile) => byId.has(f.key) && openTab('file', f.key);
  const activeFile = prefs.pane.tabs.find((t) => t.id === prefs.pane.active && t.kind === 'file');
  const selectedKey = activeFile?.kind === 'file' ? activeFile.materialId : undefined;

  const actions = (f: TreeFile): TreeAction[] => !byId.has(f.key) ? [] : [
    { key: 'open', label: 'Open', icon: FolderOpen, onSelect: () => open(f) },
    { key: 'download', label: 'Download', icon: Download, onSelect: () => void downloadMaterial(f.key).then((e) => setSaid(e ?? `${f.path} downloaded.`)) },
    { key: 'copy', label: 'Copy path', icon: Copy, onSelect: () => void navigator.clipboard?.writeText(f.path).then(() => setSaid('Path copied.'), () => setSaid('Could not copy.')) },
  ];

  return (
    <Tabs value={compact ? 'files' : view} onValueChange={setView} className="flex h-full flex-col" data-testid="files-tab">
      <TabsList hidden={compact} aria-label="Files views" className={cn('border-b border-border px-2 py-1.5', compact && 'hidden')}>
        <TabsTrigger value="files">Files</TabsTrigger>
        <TabsTrigger value="review">
          Review {review.length > 0 && <span className="rounded-full bg-draft-bg px-1.5 text-caption text-draft">{review.length}</span>}
        </TabsTrigger>
      </TabsList>

      {metadata.failed && <p role="alert" className="px-3 py-2 text-xs text-danger">
        Document details could not be checked; version information is unavailable.
        <Button variant="ghost" size="sm" onClick={() => setRetry((n) => n + 1)}>Retry document details</Button>
      </p>}

      <TabsContent value="files" className="flex flex-col data-[state=inactive]:hidden">
        <div className="flex items-center gap-1 px-2 py-2">
          <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-bg px-2 focus-within:border-strong-border focus-within:outline-2 focus-within:outline-ring">
            <Search className="size-3.5 shrink-0 text-muted" aria-hidden />
            <input
              ref={input}
              type="search"
              aria-label="Filter files"
              placeholder="Filter files…"
              data-testid="files-filter"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted"
            />
          </label>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Sort files" title="Sort files">
                <ArrowDownUp />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Sort by</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={sort.key} onValueChange={(v) => setSort({ key: v as SortKey, descending: v === 'modified' || v === 'size' })}>
                {SORTS.map(([k, l]) => (
                  <DropdownMenuRadioItem key={k} value={k}>
                    {l}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuRadioGroup value={sort.descending ? 'down' : 'up'} onValueChange={(v) => setSort((s) => ({ ...s, descending: v === 'down' }))}>
                <DropdownMenuRadioItem value="up">Ascending</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="down">Descending</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {files.some(file => file.class === 'unregistered') && <p data-testid="unregistered-files-help" className="px-2 py-2 text-xs text-muted">{fileClassLabel('unregistered')}</p>}
          <FileTree label="Project files" files={tree} query={query} sort={sort} onOpen={open} actions={actions} rowTestId="file-row" selectedKey={selectedKey} emptyText="No files yet. Attach some in the composer." />
          {archived.length > 0 && <Archived files={archived} sort={sort} onOpen={open} />}
        </div>
        <p role="status" className="border-t border-border px-3 py-2 text-xs text-muted">
          {said || 'Intermediate versions are hidden, not deleted.'}
        </p>
      </TabsContent>


      <TabsContent value="review" className="flex flex-col data-[state=inactive]:hidden">
        <p className="px-3 pt-3 text-xs text-muted">Written by the agent and not yet saved by you. Saving a file makes it yours.</p>
        <ul className="p-1">
          {review.length === 0 && <li className="px-2 py-6 text-center text-sm text-muted">Nothing waits for your review.</li>}
          {review.map((f) => (
            <li key={f.path}>
              <button type="button" className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-hover" onClick={() => f.materialId && openTab('file', f.materialId)}>
                <span className="min-w-0 flex-1 truncate">{f.path}</span>
                <ClassMark c={f.class} />
              </button>
            </li>
          ))}
        </ul>
        <div className="px-3">
          <Button variant="outline" size="sm" onClick={() => openTab('changes')}>
            <Diff /> Open Changes <span className="text-muted">{shortcutFor('changes', isMac())}</span>
          </Button>
        </div>
      </TabsContent>
    </Tabs>
  );
}

function Archived({ files, sort, onOpen }: { files: TreeFile[]; sort: TreeSort; onOpen: (f: TreeFile) => void }) {
  const [open, setOpen] = React.useState(false);
  return (
    <section aria-label="Archived" className="mt-2 border-t border-border pt-1">
      <button type="button" aria-expanded={open} className="mx-1 flex h-7 w-[calc(100%-0.5rem)] items-center gap-1.5 rounded-md px-1 text-sm text-muted hover:bg-hover" onClick={() => setOpen(!open)}>
        <ChevronRight aria-hidden className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        Archived <span className="text-xs">{files.length}</span>
      </button>
      {open && <FileTree label="Archived files" files={files} query="" sort={sort} onOpen={onOpen} />}
    </section>
  );
}
