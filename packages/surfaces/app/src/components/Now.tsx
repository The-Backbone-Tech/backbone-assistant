// Now: where the selected project's work stands, on its own page. It reads the work each time and
// stores nothing, so it cannot go stale.
import { WITHDRAWAL_WORDS, type MaterialEntry, type WorkNow } from '@backbone-next/platform';
import { CircleAlert, Loader2 } from 'lucide-react';
import * as React from 'react';
import { call, onEvent } from '../lib/api';
import { useApp } from '../lib/state';
import { Button } from './ui/button';

const RECENT = 3;
const row = 'flex w-full min-w-0 items-baseline gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover';
const label = 'px-2 text-xs font-medium text-muted';
const WRITER = { person: 'saved by you', agent: 'written by the agent' } as const;

function Progress({ threadId, title, line }: WorkNow['progress'][number]) {
  const { selectThread } = useApp();
  return (
    <button type="button" className={row} data-testid="now-progress" onClick={() => selectThread(threadId)}>
      <span className="min-w-0"><strong className="font-medium">{title}</strong> <span className="text-muted">Assistant response: {line}</span></span>
    </button>
  );
}

function Document({ name, version, by, onOpen }: { name: string; version: number; by: keyof typeof WRITER; onOpen(): void }) {
  return (
    <button type="button" className={`${row} flex-1`} title={name} onClick={onOpen}>
      <span className="min-w-0 truncate">{name} v{version}</span>
      <span className="ml-auto shrink-0 text-xs text-muted">{WRITER[by]}</span>
    </button>
  );
}

/**
 * What matters now in the project, worked out from its threads and documents each time. Unfinished
 * work comes first. Temporary output can be retired, kept or brought back; nothing is deleted, and
 * the action names the version shown, so a later edit refuses it.
 */
function Current({ projectId, projectName, onOpen }: { projectId: string; projectName: string; onOpen: (materialId: string) => void }) {
  const { selectThread, threads } = useApp();
  const [now, setNow] = React.useState<WorkNow>();
  const [problem, setProblem] = React.useState<string>();
  const [resolvingRead, setResolvingRead] = React.useState<string | null>(null);
  const [unread, setUnread] = React.useState(false);
  const [materials, setMaterials] = React.useState<MaterialEntry[] | null>(null);
  const loadGeneration = React.useRef(0);
  const load = React.useCallback(() => {
    const generation = ++loadGeneration.current;
    setMaterials(null);
    void Promise.allSettled([call('work.now', { projectId }), call('material.list', { projectId, includeHidden: true })]).then(([work, catalog]) => {
      if (generation !== loadGeneration.current) return;
      if (work.status === 'fulfilled') { setNow(work.value); setUnread(false); } else setUnread(true);
      if (catalog.status === 'fulfilled' && Array.isArray(catalog.value)) setMaterials(catalog.value);
    });
  }, [projectId]);
  React.useEffect(() => {
    load();
    return onEvent((e) => (e.topic === 'material' || e.topic === 'threads') && load());
  }, [load]);
  const failed = unread && (
    <p role="alert" className="flex items-center gap-2 px-2 text-danger">
      Could not read this project's work. <Button variant="outline" size="sm" onClick={load}>Try again</Button>
    </p>
  );
  if (!now) return failed ? <div className="mx-auto max-w-2xl px-4 py-6 text-sm">{failed}</div> : null;
  const change = async ({ id, version, lifecycle }: { id: string; version: number; lifecycle?: number }, state: 'retired' | 'kept' | 'current') => {
    try {
      const r = await call('material.lifecycle', { id, version, state, lifecycle });
      setProblem(r.ok ? undefined : r.detail);
    } catch {
      setProblem('That could not be confirmed. Nothing is shown as changed until the page reads it again.');
    }
    load();
  };
  const open = (n: WorkNow['needsYou'][number]) => (n.threadId ? selectThread(n.threadId) : n.materialId && onOpen(n.materialId));
  const resolveRead = async (id: string, verdict: 'reconcile' | 'discard') => {
    if (resolvingRead) return;
    setResolvingRead(id);
    try {
      const result = await call('connectors.resolveRead', { id, verdict });
      setProblem(result.ok ? undefined : result.detail);
    } catch {
      setProblem('That choice could not be confirmed. The retained read stays visible until its state can be checked.');
    } finally { setResolvingRead(null); load(); }
  };
  const knownMaterial = (id: string | undefined) => !!id && !!materials?.some((m) => m.id === id);
  const recoveryCopy = (id: string | undefined) => {
    const entry = materials?.find((m) => m.id === id);
    return entry && 'recovery' in entry && !!entry.recovery;
  };
  // The work read waits behind a write that holds the data folder. The thread list does not, so work
  // that started meanwhile is shown as running at once; the work read confirms it once the write ends.
  const running = [...now.running, ...threads.filter((t) => t.projectId === projectId && t.running && !now.running.some((r) => r.threadId === t.id)).map((t) => ({ threadId: t.id, title: t.title }))];
  const unfinished = running.length + now.needsYou.length;
  return (
    <section className="mx-auto flex max-w-2xl flex-col gap-5 px-4 py-6 text-sm" data-testid="work-now">
      <header className="px-2">
        <h1 className="text-lg font-semibold">{projectName}</h1>
        <p className="text-muted">{unfinished ? `${unfinished} unfinished` : 'Nothing is unfinished.'}</p>
      </header>
      {failed}
      {now.notices?.map((notice, index) => {
        // Older API bridges sent status text directly; it remains read-only display data.
        const legacy = typeof notice === 'string';
        return <p key={legacy ? `legacy-notice:${index}` : `${notice.code}:${notice.materialId ?? ''}`} role="status" className="px-2 text-muted" data-testid="knowledge-source-notice" data-notice-code={legacy ? undefined : notice.code}>{legacy ? notice : notice.message}</p>;
      })}
      {!materials && <p role="status" className="px-2 text-muted">Document actions are unavailable while details are checked. <Button variant="outline" size="sm" onClick={load}>Retry details</Button></p>}
      {problem && <p role="alert" className="px-2 text-danger" data-testid="now-problem">{problem}</p>}
      {unfinished > 0 && (
        <div className="flex flex-col">
          {now.needsYou.length > 0 && <h2 className={label}>Needs you</h2>}
          {now.needsYou.map((n) => (
            <div key={n.observationId ? `${n.kind}:${n.observationId}` : `${n.kind}${n.threadId ?? n.materialId}${n.detail}`} className="flex min-w-0 items-center gap-1" data-testid="now-needs-you" data-observation-id={n.observationId}>
              <button type="button" className={`${row} flex-1`} onClick={() => open(n)}>
                <CircleAlert className="size-3.5 shrink-0 translate-y-0.5 text-draft" aria-hidden />
                <span className="min-w-0"><strong className="font-medium">{n.title}</strong>{n.kind === 'held' && ` v${n.version}`} <span className="text-muted">{n.detail}</span></span>
              </button>
              {n.kind === 'connector-read' && n.observationId && <div className="flex max-w-48 shrink-0 flex-wrap justify-end gap-1">
                <Button variant="outline" size="sm" disabled={!n.canReconcile || resolvingRead !== null} onClick={() => void resolveRead(n.observationId!, 'reconcile')}>Reconcile</Button>
                <Button variant="outline" size="sm" disabled={resolvingRead !== null} onClick={() => void resolveRead(n.observationId!, 'discard')}>Discard from agent use</Button>
              </div>}
              {n.kind === 'unsure' && n.materialId && knownMaterial(n.materialId) && !recoveryCopy(n.materialId) && (now.withdrawn.some((d) => d.id === n.materialId)
                ? <span className="shrink-0 text-xs text-muted">Restore it first</span>
                : <Button variant="outline" size="sm" onClick={() => void change({ id: n.materialId!, version: n.version!, lifecycle: n.lifecycle }, 'kept')}>Keep it</Button>)}
              {n.kind === 'held' && materials && (() => {
                const entry = materials.find((m) => m.id === n.materialId);
                if (!entry) return null;
                const recovery = recoveryCopy(entry.id);
                return <>
                  {recovery ? <Button variant="outline" size="sm" onClick={() => onOpen(n.materialId!)}>Inspect</Button> : <Button variant="outline" size="sm" onClick={() => void change({ id: n.materialId!, version: n.version!, lifecycle: n.lifecycle }, 'current')}>Allow in later work</Button>}
                  <Button variant="outline" size="sm" onClick={() => void change({ id: n.materialId!, version: n.version!, lifecycle: n.lifecycle }, 'retired')}>{recovery ? 'Retire' : 'Set aside'}</Button>
                </>;
              })()}
            </div>
          ))}
          {running.length > 0 && <h2 className={`${label} mt-2`}>Working</h2>}
          {running.map((r) => (
            <button type="button" key={r.threadId} className={row} onClick={() => selectThread(r.threadId)}>
              <Loader2 className="size-3.5 shrink-0 translate-y-0.5 animate-spin text-muted" aria-hidden />
              <span className="min-w-0">Working: {r.title}</span>
            </button>
          ))}
        </div>
      )}
      {now.progress.length > 0 && (
        <div className="flex flex-col" data-testid="now-recent">
          <h2 className={label}>Recent</h2>
          {now.progress.slice(0, RECENT).map((p) => <Progress key={p.threadId} {...p} />)}
          {now.progress.length > RECENT && (
            <details data-testid="now-older-progress">
              <summary className="cursor-pointer rounded-md px-2 py-1.5 text-muted hover:bg-hover">{now.progress.length - RECENT} older</summary>
              {now.progress.slice(RECENT).map((p) => <Progress key={p.threadId} {...p} />)}
            </details>
          )}
        </div>
      )}
      {now.current.length > 0 && (
        <div className="flex flex-col">
          <h2 className={label}>Documents</h2>
          {now.current.map((d) => <div key={d.id} className="flex min-w-0"><Document {...d} onOpen={() => onOpen(d.id)} /></div>)}
        </div>
      )}
      {now.temporary.length > 0 && (
        <div className="flex flex-col">
          <h2 className={label}>Temporary output</h2>
          {now.temporary.map((d) => (
            <div key={d.id} className="flex min-w-0 items-center gap-1" data-testid="now-temporary">
              <Document {...d} onOpen={() => onOpen(d.id)} />
              <Button variant="outline" size="sm" onClick={() => void change(d, 'kept')}>Keep</Button>
              <Button variant="outline" size="sm" onClick={() => void change(d, 'retired')}>Retire</Button>
            </div>
          ))}
        </div>
      )}
      {now.withdrawn.length > 0 && (
        <div className="flex flex-col">
          <h2 className={label}>Withdrawn</h2>
          <p className="px-2 pb-1 text-xs text-muted">{WITHDRAWAL_WORDS}</p>
          {now.withdrawn.map((d) => (
            <div key={d.id} className="flex min-w-0 items-center gap-1" data-testid="now-withdrawn">
              <div className="flex min-w-0 flex-1 flex-col">
                <Document {...d} onOpen={() => onOpen(d.id)} />
                {d.mayCarry.length > 0 && <p className="px-2 pb-1 text-xs text-muted">Earlier work drew on it: {d.mayCarry.join(', ')}</p>}
              </div>
              <Button variant="outline" size="sm" onClick={() => void change(d, 'current')}>Restore</Button>
            </div>
          ))}
        </div>
      )}
      {now.retired.length > 0 && (
        <details data-testid="now-retired">
          <summary className="cursor-pointer rounded-md px-2 py-1.5 text-muted hover:bg-hover">{now.retired.length} retired, every version kept</summary>
          {now.retired.map((d) => (
            <div key={d.id} className="flex min-w-0 items-center gap-2 px-2 py-1">
              <span className="min-w-0 truncate text-muted" title={d.name}>{d.name} v{d.version}</span>
              {knownMaterial(d.id) && !recoveryCopy(d.id) && <Button variant="outline" size="sm" className="ml-auto" onClick={() => void change(d, 'current')}>Bring back</Button>}
            </div>
          ))}
        </details>
      )}
    </section>
  );
}

export function Now() {
  const { prefs, projects, openTab } = useApp();
  const project = projects.find((p) => p.id === prefs.selectedProjectId);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="now">
      {project
        ? <Current key={project.id} projectId={project.id} projectName={project.name} onOpen={(id) => openTab('file', id)} />
        : <p className="px-4 py-3 text-sm text-muted">Choose a project to see where its work stands.</p>}
    </div>
  );
}
