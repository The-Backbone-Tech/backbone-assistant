// Changes: scopes from last turn through branch, a base selector, a filtered file list and the diff.
import { CHANGE_SCOPES, type Args, type ChangeScope, type Changes, type Receipt } from '@backbone-next/platform';
import * as React from 'react';
import { call } from '../../lib/api';
import { highlight } from '../../lib/highlight';
import { useApp, useLive } from '../../lib/state';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Input, Select } from '../ui/input';

const LABELS: Record<ChangeScope, string> = { 'last-turn': 'Last turn', uncommitted: 'Uncommitted', unstaged: 'Unstaged', staged: 'Staged', committed: 'Committed', branch: 'Branch' };

export function ChangesTab({ projectId, threadId }: { projectId: string; threadId?: string }) {
  const { projects } = useApp();
  const isRepo = projects.find((p) => p.id === projectId)?.kind === 'git';
  const [scope, setScope] = React.useState<ChangeScope>('last-turn');
  const [base, setBase] = React.useState<string>();
  const [filter, setFilter] = React.useState('');
  const { result: r, loading, failed, retry } = useChanges({ projectId, threadId, scope, base });
  const files = r?.ok ? r.value.files.filter((f) => f.path.toLowerCase().includes(filter.toLowerCase())) : [];

  return (
    <div className="flex h-full flex-col" data-testid="changes-tab">
      <div className="flex flex-wrap items-center gap-1 border-b border-border p-2" role="radiogroup" aria-label="Diff scope">
        {CHANGE_SCOPES.map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={scope === s}
            disabled={s !== 'last-turn' && !isRepo}
            title={s !== 'last-turn' && !isRepo ? 'This project is a folder, not a repository' : undefined}
            className={cn('rounded-md px-2 py-1 text-xs disabled:opacity-40', scope === s ? 'bg-fg text-bg' : 'hover:bg-hover')}
            onClick={() => setScope(s)}
          >
            {LABELS[s]}
          </button>
        ))}
        {r?.ok && (
          <label className="ml-auto flex items-center gap-1 text-xs text-muted">
            Base
            <Select size="sm" value={r.value.base} onChange={(e) => setBase(e.target.value)} disabled={r.value.bases.length < 2}>
              {r.value.bases.map((b) => (
                <option key={b}>{b}</option>
              ))}
            </Select>
          </label>
        )}
      </div>
      <div className="border-b border-border p-2">
        <Input aria-label="Filter files" placeholder="Filter files" value={filter} onChange={(e) => setFilter(e.target.value)} size="sm" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && <p role="status" className="p-4 text-sm text-muted">Loading changes…</p>}
        {failed && <p role="alert" className="p-4 text-sm text-muted">Changes could not be loaded. <button className="underline" onClick={retry}>Try again</button></p>}
        {r && !r.ok && <p className="p-4 text-sm text-muted">{r.detail}</p>}
        {r?.ok && files.length === 0 && <p className="p-4 text-sm text-muted">No changes in this scope.</p>}
        {files.map((f) => (
          <section key={f.path} className="border-b border-border">
            <h3 className="sticky top-0 flex items-center gap-2 bg-surface px-3 py-1.5 font-mono text-xs">
              {f.path}
              <span className="text-committed">+{f.added}</span>
              <span className="text-danger">−{f.removed}</span>
            </h3>
            <Patch text={f.patch} />
          </section>
        ))}
      </div>
    </div>
  );
}

/** What one version of a document changed: the result first, then the lines, with the version one click away. */
export function VersionChanges({ projectId, materialId, version, name }: { projectId: string; materialId: string; version: number; name?: string }) {
  const { openTab } = useApp();
  const { result: r, loading, failed, retry } = useChanges({ projectId, scope: 'last-turn', version: { materialId, version } });
  const f = r?.ok ? r.value.files[0] : undefined;
  const against = r?.ok ? (r.value.base === 'empty' ? 'a new document' : `against ${r.value.base}`) : '';
  return (
    <div className="flex h-full flex-col" data-testid="version-changes">
      <div className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <p className="min-w-0 flex-1 truncate">
          <span className="font-medium">{name ?? 'Document'} v{version}</span>
          {f && <> <span className="text-committed">+{f.added}</span> <span className="text-danger">−{f.removed}</span></>}
          {against && <span className="text-muted"> · {against}</span>}
        </p>
        <Button variant="outline" size="sm" onClick={() => openTab('file', materialId, version)}>Open v{version}</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && <p role="status" className="p-4 text-sm text-muted">Loading changes…</p>}
        {failed && <p role="alert" className="p-4 text-sm text-muted">Changes could not be loaded. <button className="underline" onClick={retry}>Try again</button></p>}
        {r && !r.ok && <p className="p-4 text-sm text-muted">{r.detail}</p>}
        {r?.ok && !f && <p className="p-4 text-sm text-muted">This version has no text lines to compare.</p>}
        {f && <Patch text={f.patch} />}
      </div>
    </div>
  );
}

function Patch({ text }: { text: string }) {
  const [rendered, setRendered] = React.useState<{ text: string; html: string }>();
  const html = rendered?.text === text ? rendered.html : undefined;
  React.useEffect(() => {
    let live = true;
    void highlight(text, 'diff').then((html) => { if (live) setRendered({ text, html }); });
    return () => { live = false; };
  }, [text]);
  return html ? (
    <div className="overflow-x-auto px-3 py-2 font-mono text-xs leading-5 [&_pre]:!bg-transparent" dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <pre className="overflow-x-auto px-3 py-2 font-mono text-xs leading-5">{text}</pre>
  );
}


/** A cached receipt may refresh in place, but never under a different query's labels. */
function useChanges(args: Args<'changes.get'>) {
  const [attempt, setAttempt] = React.useState(0);
  const key = JSON.stringify([args, attempt]);
  const snapshot = useLive(async () => {
    try { return { key, result: await call('changes.get', args), failed: false }; }
    catch { return { key, result: null, failed: true }; }
  }, [key], null as { key: string; result: Receipt<Changes> | null; failed: boolean } | null);
  const current = snapshot?.key === key ? snapshot : null;
  return { result: current?.result, loading: !current, failed: current?.failed, retry: () => setAttempt((n) => n + 1) };
}
