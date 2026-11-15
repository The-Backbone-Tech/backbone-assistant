// A file: CodeMirror for editing working copies, Streamdown or Shiki for reading, and a read-only
// view of originals. An unsaved edit is a server draft (R-BASE-03); Save makes a new version owned
// by the person (R-BASE-02). Draft, saving and saved look different (R-UX-DRAFT-01), and an
// interrupted Save says which version is current.
import type { MaterialEntry } from '@backbone-next/platform';
import { BookOpen, CircleAlert, Download, Maximize2, Minimize2, MoreHorizontal, Pencil } from 'lucide-react';
import * as React from 'react';
import { WITHDRAWAL_WORDS } from '@backbone-next/platform';
import { Dialog, DialogContent } from '../ui/dialog';
import { call, canExport, exportDocument, type ExportFormat } from '../../lib/api';
import { acceptDraftRead, flushDraft, hasUnconfirmedDraft, hasUncertainDraft, retryUncertainDraft, keepReviewedDraft, persistDraft, readDraft, reviewSavedDraft, useReviewedDraft, trackDraftOperation } from '../../lib/drafts';
import { downloadMaterial } from '../../lib/download';
import { useApp } from '../../lib/state';
import { cn } from '../../lib/utils';
import { Editor } from '../files/Editor';
import { DraftConflictCopies } from '../DraftConflictCopies';
import { FileIcon, isText, kindOf } from '../files/kind';
import { Reader } from '../files/Reader';
import { DocumentPreview } from '../files/DocumentPreview';
import { previewKind, previewKindLabel } from '../files/preview-boundary';
import { Button } from '../ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu';

type State = 'saved' | 'draft' | 'saving';
const EXPORTS: [ExportFormat, string][] = [['pdf', 'PDF'], ['slides', 'PDF slides'], ['html', 'HTML'], ['md', 'Markdown']];
const CsvEditor = React.lazy(() => import('../files/CsvEditor'));

/** `extra` is the pane's own control for this view (Browse files), shown at the end of the document's header. */
export function FileTab({ materialId, version, active, onSaved, extra }: { materialId: string; version?: number; active?: boolean; onSaved?(): void; extra?: React.ReactNode }) {
  const { tick, openTab, prefs, projects } = useApp();
  const viewerOnly=projects.find(project=>project.id===prefs.selectedProjectId)?.access==='viewer';
  const [entry, setEntry] = React.useState<MaterialEntry>();
  const [text, setText] = React.useState<string>();
  const [base64, setBase64] = React.useState<string>();
  const [edit, setEdit] = React.useState<string>();
  const [state, setState] = React.useState<State>('saved');
  const [error, setError] = React.useState<string>();
  const [reviewedDraft, setReviewedDraft] = React.useState<{key: string; revision: number; text: string; meta?: Record<string, string | number>}>();
  const [reviewingDraft, setReviewingDraft] = React.useState(false);
  const [confirmSavedDraft, setConfirmSavedDraft] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string>();
  const [loadAttempt, setLoadAttempt] = React.useState(0);
  const [staleDraft, setStaleDraft] = React.useState<number>();
  const [mode, setMode] = React.useState<'read' | 'edit'>('read');
  const [csvMode, setCsvMode] = React.useState<'table' | 'text'>('text');
  const [csvSeparator, setCsvSeparator] = React.useState<{material: string; version: number; delimiter: string}>();
  const [full, setFull] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  // A live editor owns newer text; asynchronous draft hydration cannot replace it.
  const localEdit = React.useRef(false);
  const editGeneration = React.useRef(0);
  const latestEdit = React.useRef<string | undefined>(undefined);
  const editBase = React.useRef<number | undefined>(undefined);
  const saving = React.useRef(false);
  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const saveAction = React.useRef<HTMLButtonElement>(null);
  const documentOptions = React.useRef<HTMLButtonElement>(null);
  const draftKey = `edit:${materialId}`;
  const dirty = edit !== undefined && edit !== text;

  // A result link carries its exact version; an ordinary workspace tab follows current.
  React.useEffect(() => {
    let live = true;
    void (async () => {
      const r = await call('material.read', { id: materialId, version });
      if (!live) return;
      if (!r.ok) { if (!localEdit.current) setEntry(undefined); setLoadError(r.detail); return; }
      if (localEdit.current) return;
      setLoadError(undefined);
      setEntry(r.value.entry);
      if ('recovery' in r.value.entry && r.value.entry.recovery) { setText(r.value.text); setBase64(r.value.base64); setEdit(undefined); setMode('read'); setStaleDraft(undefined); return; }
      setText(r.value.text);
      setBase64(r.value.base64);
      if (version !== undefined && version !== r.value.entry.current) {
        setEdit(undefined); setState('saved'); setMode('read'); return;
      }
      if (localEdit.current || state === 'saving') return;
      const d = await readDraft(draftKey);
      if (!live || localEdit.current) return;
      if (hasUnconfirmedDraft(draftKey)) setError('The edit could not be confirmed as a draft. Your local text is kept; review the saved value.');
      const base = Number(d?.meta?.baseVersion);
      if (!d || !Number.isInteger(base) || base === r.value.entry.current) acceptDraftRead(draftKey, d?.revision ?? 0);
      // Empty text with a base revision is an actual edit; the cleared sentinel has no base.
      if (d && Number.isInteger(base) && base === r.value.entry.current) {
        editBase.current = base;
        latestEdit.current = d.text;
        setStaleDraft(undefined);
        setEdit(d.text);
        setState('draft');
        setMode('edit');
      } else if (d && Number.isInteger(base)) {
        setStaleDraft(base);
        setEdit(undefined);
      } else if (state === 'saved') {
        setEdit(undefined);
        editBase.current = undefined;
      }
    })().catch(() => { if (live && !localEdit.current) { setEntry(undefined); setLoadError('This document version could not be read.'); } });
    return () => {
      live = false;
    };
  // Tabs stay mounted, so a tab reads again on becoming active: another tab of this file may hold newer typing.
  }, [materialId, version, draftKey, tick, state, active, loadAttempt]);

  React.useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setFull(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full]);

  function persist(value: string, baseVersion: number, generation = editGeneration.current) {
    void persistDraft(draftKey, value, { baseVersion }).catch((error: unknown) => {
      if (editGeneration.current === generation) setError(`The edit could not be saved as a draft: ${String(error)}`);
    });
  }

  function save() {
    return trackDraftOperation(async () => {
      if (!entry || ('recovery' in entry && entry.recovery) || edit === undefined || saving.current || entry.class === 'original' || (version !== undefined && version !== entry.current)) return;
      saving.current = true;
      const pressedButton = saveAction.current;
      const restoreFocus = document.activeElement === pressedButton;
      const snapshot = edit;
      const generation = editGeneration.current;
      setState('saving');
      setError(undefined);
      try {
        const r = await call('material.save', { id: materialId, text: snapshot, baseVersion: editBase.current ?? entry.current });
        // A departed editor no longer owns the current view or another mount's draft. The
        // saved version is durable; keep any later draft for explicit restoration if needed.
        if (!mounted.current) return;
        if (!r.ok) { setState('draft'); return setError(r.detail); }
        setEntry(r.value);
        setCsvSeparator(previous => previous?.material === materialId && previous.version === entry.current ? { ...previous, version: r.value.current } : undefined);
        setText(snapshot);
        editBase.current = r.value.current;
        if (editGeneration.current === generation) {
          setEdit(undefined);
          latestEdit.current = undefined;
          localEdit.current = false;
          setState('saved');
          // The shared writer orders this clear after an already-dispatched autosave.
          void persistDraft(draftKey, '').catch((error: unknown) => {
            if (editGeneration.current === generation) setError(`The saved file is safe, but its draft could not be cleared: ${String(error)}`);
          });
        } else {
          // Only our own successful save advances this draft's base. A newer person's/source
          // version still fails the platform's existing material.save compare-and-swap.
          setState('draft');
          persist(latestEdit.current ?? '', r.value.current);
        }
        onSaved?.();
        if (restoreFocus) requestAnimationFrame(() => {
          if (document.activeElement === document.body || document.activeElement === pressedButton) documentOptions.current?.focus();
        });
      } catch (error) {
        setError(`The save could not finish: ${String(error)}`);
        setState('draft');
      } finally {
        saving.current = false;
      }
    });
  }

  /** Drops the unsaved edit and its server draft; the saved version is untouched. */
  function discard() {
    return trackDraftOperation(async () => {
      if (saving.current) return;
      ++editGeneration.current;
      setEdit(undefined);
      latestEdit.current = undefined;
      editBase.current = undefined;
      localEdit.current = false;
      setStaleDraft(undefined);
      setState('saved');
      try { await persistDraft(draftKey, ''); } catch (error) { setError(`The draft could not be discarded: ${String(error)}`); }
    });
  }

  function restore() {
    return trackDraftOperation(async () => {
      const generation = editGeneration.current;
      const draft = await readDraft(draftKey);
      const base = Number(draft?.meta?.baseVersion);
      if (!entry || !draft || !Number.isInteger(base) || generation !== editGeneration.current) return;
      acceptDraftRead(draftKey, draft.revision);
      ++editGeneration.current;
      localEdit.current = true;
      latestEdit.current = draft.text;
      // Restore is the person's existing explicit rebase onto the displayed saved version. Save
      // still compares that version, and the earlier saved revisions remain available.
      editBase.current = entry.current;
      setEdit(draft.text);
      setStaleDraft(undefined);
      setState('draft');
      setMode('edit');
      persist(draft.text, entry.current);
    });
  }

  if (!entry) return <div className="space-y-3 p-4 text-sm text-muted"><p role={loadError ? 'alert' : 'status'}>{loadError ?? 'Loading…'}</p>{loadError && <Button variant="outline" size="sm" onClick={() => { setLoadError(undefined); setLoadAttempt(n => n + 1); }}>Retry document</Button>}</div>;
  const displayVersion = version ?? entry.current;
  const historical = displayVersion !== entry.current;
  const current = entry.versions.find((v) => v.n === displayVersion);
  const original = entry.class === 'original';
  const recovery = 'recovery' in entry && !!entry.recovery;
  const shown: State = state === 'saving' ? 'saving' : dirty ? 'draft' : 'saved';
  const preview = previewKind(entry.name);
  const textual = (!preview || /\.csv$/i.test(entry.name)) && base64 === undefined && isText(entry.name, entry.mediaType);
  const editing = !viewerOnly && !recovery && !original && !historical && textual && mode === 'edit';
  const csvEditing = editing && /\.csv$/i.test(entry.name);
  const changeText = (value: string) => {
    ++editGeneration.current;
    localEdit.current = true;
    latestEdit.current = value;
    editBase.current ??= entry.current;
    setEdit(value);
    if (!saving.current) setState('draft');
    persist(value, editBase.current);
  };
  const draftVisible = !preview || editing;
  const lastWithdrawal = entry.withdrawals?.at(-1);
  const withdrawn = !!lastWithdrawal && !lastWithdrawal.restoredAt;
  const lifecycle = async (state: 'withdrawn' | 'current') => {
    setConfirming(false);
    try {
      const r = await call('material.lifecycle', { id: materialId, version: entry.current, state, lifecycle: entry.lifecycle ?? 0 });
      if (r.ok) { setEntry(r.value); setError(undefined); } else setError(r.detail);
    } catch {
      setError('That could not be confirmed. Reopen this document to see its state before trying again.');
    }
  };
  // Export is a read of the version shown in this project: main checks it, asks where, renders and writes.
  const projectId = prefs.selectedProjectId;
  const exportable = canExport() && !!projectId && textual && kindOf(entry.name) === 'markdown' && !entry.held && !withdrawn;
  const exportAs = async (format: ExportFormat) => {
    try {
      if (!projectId) return;
      const r = await exportDocument(projectId, materialId, displayVersion, format);
      setError(r.ok ? undefined : r.detail);
    } catch {
      setError('The export could not finish.');
    }
  };

  const actions = (
    <span className="flex shrink-0 items-center gap-1">
      {/* Announced as it changes; not a status region, since the document's own loading and preview states are. */}
      <span aria-live="polite" className="sr-only">{recovery ? 'Recovery copy · read only' : original ? 'Original · read only' : historical ? `Historical version ${displayVersion} · read only` : !draftVisible || shown === 'saved' ? 'Saved' : shown === 'saving' ? 'Saving…' : 'Unsaved edit'}</span>
      {textual && (
        <Button variant="ghost" size="icon-sm" tip aria-label={editing ? 'Read' : 'Edit'} disabled={viewerOnly || recovery || original || historical} title={viewerOnly ? 'Viewer access' : recovery ? 'Recovery copy · read only' : original ? 'Original · read only' : historical ? 'Historical version · read only' : editing ? 'Preview document' : 'Edit document'} onClick={() => setMode(editing ? 'read' : 'edit')}>
          {editing ? <BookOpen /> : <Pencil />}
        </Button>
      )}
      {draftVisible && !recovery && !original && !historical && (dirty || state === 'saving') && (
        <>
          <span data-testid="edit-state" className="sr-only">{state === 'saving' ? 'Saving…' : 'Unsaved edit'}</span>
          <span aria-hidden className="size-1.5 rounded-full bg-draft" title={state === 'saving' ? 'Saving…' : 'Unsaved edit'} />
          <Button ref={saveAction} size="sm" disabled={!dirty || state === 'saving'} onClick={() => void save()}>
            {state === 'saving' ? 'Saving…' : 'Save'}
          </Button>
        </>
      )}
      <Button variant="ghost" size="icon-sm" tip aria-label={full ? 'Exit full screen' : 'Full screen'} title={full ? 'Exit full screen' : 'Full screen'} onClick={() => setFull(!full)}>
        {full ? <Minimize2 /> : <Maximize2 />}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button ref={documentOptions} variant="ghost" size="icon-sm" tip aria-label="Document options" title="Document options"><MoreHorizontal /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent data-workspace align="end" className="w-64">
          <DropdownMenuLabel className="break-words">{entry.name}</DropdownMenuLabel>
          <div className="px-2 py-1 text-xs text-muted" data-testid="file-version">
            v{displayVersion} · {entry.restored ? 'restored version' : original ? 'original source' : current?.by === 'person' ? 'saved by you' : 'written by the agent'}
          </div>
          <div className="px-2 py-1 text-xs text-muted">
            {recovery ? 'Recovery copy · inspection only' : historical ? 'Historical version · read only' : original ? 'Original · read-only, bytes kept untouched' : entry.class === 'accepted' ? 'Saved current document' : 'Working copy'}
          </div>
          <div className={cn('px-2 py-1 text-xs', draftVisible && (dirty || state === 'saving') ? 'text-draft' : 'text-muted')} data-testid="document-state">
            {recovery || original || historical ? 'Read-only' : draftVisible && shown === 'saving' ? 'Saving…' : draftVisible && dirty ? 'Unsaved edit' : 'Saved'}
          </div>
          <div className="px-2 py-1 text-xs text-muted">{entry.mediaType}</div>
          <DropdownMenuSeparator />
          {draftVisible && !original && !historical && dirty && state !== 'saving' && <DropdownMenuItem onSelect={() => void discard()}>Discard unsaved edit</DropdownMenuItem>}
          <DropdownMenuItem onSelect={() => void downloadMaterial(materialId, displayVersion).then(setError)}>Download</DropdownMenuItem>
          {exportable && EXPORTS.map(([format, label]) => <DropdownMenuItem key={format} onSelect={() => void exportAs(format)}>Export as {label}…</DropdownMenuItem>)}
          {original && !withdrawn && <DropdownMenuItem onSelect={() => setConfirming(true)}>Withdraw from later work…</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );

  return (
    <div className={cn('flex h-full flex-col bg-surface', full && 'fixed inset-0 z-50')} data-testid="file-tab">
      {/* The document's own header: what it is and what can be done with it. The pane's top bar holds only tabs. */}
      <div data-document-header {...(full ? { 'data-workspace-toolbar': true } : {})} className={cn('flex shrink-0 items-center gap-2 border-b border-border bg-surface px-2', full ? 'file-toolbar-inline app-window-bar h-[42px]' : 'h-9')}>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {full ? <><FileIcon name={entry.name} /><span className="min-w-0 truncate text-ui font-medium">{entry.name}</span></> : (
            <span aria-hidden data-testid="document-header-version" className="min-w-0 truncate text-xs text-muted">v{displayVersion}{recovery ? ' · recovery copy, read only' : original ? ' · original, read only' : historical ? ' · historical, read only' : ''}</span>
          )}
        </div>
        {actions}
        {!full && extra}
      </div>
      {!recovery && <DraftConflictCopies draftKey={draftKey} />}
      {recovery && <p role="status" data-testid="recovery-copy-notice" className="border-b border-border px-3 py-2 text-xs text-muted">This saved piece was not imported and is not an authorised output. You can inspect or retire it; later work cannot use it.</p>}
      {withdrawn && <div role="status" data-testid="withdrawn-banner" className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs text-muted">
        <span className="min-w-0"><strong className="font-medium text-fg">Withdrawn.</strong> {WITHDRAWAL_WORDS}</span>
        <Button variant="outline" size="sm" className="ml-auto shrink-0" onClick={() => void lifecycle('current')}>Restore</Button>
      </div>}
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent title={`Withdraw ${entry.name}?`} description={WITHDRAWAL_WORDS}>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button variant="outline" onClick={() => void lifecycle('withdrawn')}>Withdraw</Button>
          </div>
        </DialogContent>
      </Dialog>
      {historical && <p role="status" data-testid="historical-version" className="border-b border-border px-3 py-2 text-xs text-muted">
        Viewing v{displayVersion}, read only. The current document is v{entry.current}.{' '}
        <Button variant="ghost" size="sm" onClick={() => openTab('file', materialId)}>Open current version</Button>
      </p>}
      {entry.interruptedSave && (
        <p role="status" className="flex items-center gap-2 border-b border-draft bg-draft-bg px-3 py-2 text-xs text-draft" data-testid="interrupted-save">
          <CircleAlert className="size-4" /> The Save of v{entry.interruptedSave.version} did not finish. v{entry.current} is the current version.
        </p>
      )}
      {!recovery && staleDraft !== undefined && (
        <p role="status" className="border-b border-draft bg-draft-bg px-3 py-2 text-xs text-draft">
          You have an unsaved edit that started from v{staleDraft}; the file is now v{entry.current}.{' '}
          <button type="button" className="underline" onClick={() => void restore()}>
            Restore my edit
          </button>
        </p>
      )}
      {(error || loadError) && <div className="px-3 py-2 text-xs text-danger">
        <p role="alert">{error ?? loadError}</p>
        {hasUncertainDraft(draftKey) && <button type="button" className="underline mr-2" disabled={reviewingDraft} onClick={() => {
          setReviewingDraft(true);
          void retryUncertainDraft(draftKey).then(() => flushDraft(draftKey)).then(() => { if (mounted.current) setError(undefined); })
            .catch((e:unknown) => { if (mounted.current) setError(`The draft could not be saved: ${String(e)}`); })
            .finally(() => { if (mounted.current) setReviewingDraft(false); });
        }}>Retry saving draft</button>}
        {hasUnconfirmedDraft(draftKey) && <button type="button" className="underline" disabled={reviewingDraft} onClick={() => {
          setReviewingDraft(true);
          void reviewSavedDraft(draftKey).then(saved => { if (mounted.current) setReviewedDraft({key:draftKey, revision:saved?.revision ?? 0, text:saved?.text ?? '', meta:saved?.meta}); })
            .catch((e: unknown) => { if (mounted.current) setError(`The saved draft could not be read: ${String(e)}`); })
            .finally(() => { if (mounted.current) setReviewingDraft(false); });
        }}>Review saved draft</button>}
        {reviewedDraft?.key === draftKey && <div className="mt-2 text-fg">
          <p>Saved draft:</p><pre className="whitespace-pre-wrap break-words">{reviewedDraft.text || '(empty)'}</pre>
          {reviewedDraft.meta && Object.keys(reviewedDraft.meta).length > 0 && <><p>Saved draft details:</p><pre className="whitespace-pre-wrap break-words">{JSON.stringify(reviewedDraft.meta, null, 2)}</pre></>}
          <p>Your current edit stays here. Keeping it replaces the saved draft only if it has not changed again.</p>
          <button type="button" className="underline" disabled={reviewingDraft || latestEdit.current === undefined || editBase.current === undefined} onClick={() => {
            const current = latestEdit.current, base = editBase.current;
            if (current === undefined || base === undefined) return;
            setReviewingDraft(true);
            void keepReviewedDraft(draftKey, reviewedDraft.revision, current, {baseVersion:base}).then(() => {
              if (mounted.current) { setReviewedDraft(undefined); setError(undefined); }
            }).catch((e: unknown) => { if (mounted.current) { setReviewedDraft(undefined); setError(`The draft could not be saved: ${String(e)}`); } })
              .finally(() => { if (mounted.current) setReviewingDraft(false); });
          }}>Keep my draft</button>{' '}
          {!confirmSavedDraft ? <button type="button" className="underline" disabled={reviewingDraft} onClick={() => setConfirmSavedDraft(true)}>Use saved draft</button> : <div>
            <p>This replaces your local edit with the saved draft.</p>
            <button type="button" className="underline mr-2" onClick={() => setConfirmSavedDraft(false)}>Cancel</button>
            <button type="button" className="underline" disabled={reviewingDraft} onClick={() => {
              setReviewingDraft(true);
              void useReviewedDraft(draftKey, reviewedDraft.revision).then(saved => {
                if (!mounted.current) return;
                const base = Number(saved.meta?.baseVersion); ++editGeneration.current; localEdit.current = false;
                if (Number.isInteger(base) && base === entry.current) { editBase.current = base; latestEdit.current = saved.text; setEdit(saved.text); setState('draft'); setMode('edit'); setStaleDraft(undefined); }
                else if (Number.isInteger(base)) { editBase.current = undefined; latestEdit.current = undefined; setEdit(undefined); setStaleDraft(base); setState('saved'); setMode('read'); }
                else { editBase.current = undefined; latestEdit.current = undefined; setEdit(undefined); setStaleDraft(undefined); setState('saved'); setMode('read'); }
                setReviewedDraft(undefined); setConfirmSavedDraft(false); setError(undefined);
              }).catch((e: unknown) => { if (mounted.current) { setReviewedDraft(undefined); setConfirmSavedDraft(false); setError(`The saved draft could not be confirmed: ${String(e)}`); } })
                .finally(() => { if (mounted.current) setReviewingDraft(false); });
            }}>Replace my local draft</button>
          </div>}
        </div>}
      </div>}
      <div className="min-h-0 flex-1 overflow-auto bg-bg">
        {!editing && (preview || !textual) ? (
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 text-xs text-muted">
              <FileIcon name={entry.name} />
              <span className="min-w-0 flex-1 truncate" title={entry.name}>{entry.name}</span>
              <span className="max-w-40 truncate" title={entry.mediaType}>{preview ? previewKindLabel(preview) : entry.mediaType} · {((current?.bytes ?? 0) / 1024).toFixed(1)} KB</span>
              <Button variant="outline" size="sm" onClick={() => void downloadMaterial(materialId, displayVersion).then(setError).catch(() => setError('The download could not finish. Try Download again.'))}><Download /> Download</Button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <DocumentPreview key={`${materialId}:${displayVersion}`} cacheKey={`${materialId}:${displayVersion}`} name={entry.name} base64={base64} text={text} bytes={current?.bytes ?? 0} />
            </div>
          </div>
        ) : editing ? (
          <div className="flex h-full min-h-0 flex-col">
          {csvEditing && <div className="flex shrink-0 gap-1 border-b border-border px-3 py-1" role="group" aria-label="CSV editing view">
            <Button variant={csvMode === 'table' ? 'subtle' : 'ghost'} size="sm" aria-pressed={csvMode === 'table'} onClick={() => setCsvMode('table')}>Table</Button>
            <Button variant={csvMode === 'text' ? 'subtle' : 'ghost'} size="sm" aria-pressed={csvMode === 'text'} onClick={() => setCsvMode('text')}>Text</Button>
          </div>}
          <div className="min-h-0 flex-1">
          {csvEditing && csvMode === 'table' ? <React.Suspense fallback={<p role="status" className="p-4 text-sm text-muted">Opening table…</p>}>
            <CsvEditor name={entry.name} value={edit ?? text ?? ''} separator={csvSeparator?.material === materialId && csvSeparator.version === entry.current ? csvSeparator.delimiter : undefined} onSeparator={delimiter => setCsvSeparator(delimiter ? {material: materialId, version: entry.current, delimiter} : undefined)} onChange={changeText} onSave={() => void save()} onText={() => setCsvMode('text')} />
          </React.Suspense> : <Editor
            label={`Edit ${entry.name}`}
            lang={kindOf(entry.name) === 'markdown' ? 'markdown' : 'text'}
            value={edit ?? text ?? ''}
            onSave={() => void save()}
            onChange={value => { setCsvSeparator(undefined); changeText(value); }}
          />}
          </div>
          </div>
        ) : (
          <Reader name={entry.name} text={edit ?? text ?? ''} />
        )}
      </div>
    </div>
  );
}
