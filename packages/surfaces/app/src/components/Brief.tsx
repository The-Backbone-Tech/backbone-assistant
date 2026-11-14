// Mail triage: the job's one page. Connect the sample mailbox (reads only), sign the capability
// (main shows it with its hash and asks for Touch ID or the device password), and read the brief:
// what was done and what is proposed, each with its recovery class, what needs you and why. Drafts
// open in the viewer; each proposal is accepted or discarded with one click. This page never signs
// and never applies a change: it asks main to start signing, and it answers proposals.
import type { BriefItem, TriageView } from '@backbone-next/platform';
import { RECOVERY_WORDS } from '@backbone-next/platform';
import { CircleAlert, FileText, Loader2, ShieldCheck } from 'lucide-react';
import * as React from 'react';
import { call, onEvent, signCapability } from '../lib/api';
import { useApp } from '../lib/state';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

const TONE: Record<BriefItem['outcome'], 'neutral' | 'draft' | 'pending' | 'committed' | 'danger'> = {
  DONE: 'committed',
  PROPOSED: 'draft',
  ACCEPTED: 'pending',
  PENDING: 'pending',
  DISCARDED: 'neutral',
  CANCELLED: 'neutral',
  REFUSED: 'neutral',
  FAILED: 'danger',
  UNKNOWN: 'danger',
};
const OUTCOME_WORDS: Record<BriefItem['outcome'], string> = {
  DONE: 'Done',
  PROPOSED: 'Proposed',
  ACCEPTED: 'Accepted, waiting',
  PENDING: 'In progress',
  DISCARDED: 'Discarded',
  CANCELLED: 'Cancelled',
  REFUSED: 'Refused',
  FAILED: 'Failed',
  UNKNOWN: 'Unknown outcome',
};

export function Brief() {
  const { openTab, setPrefs } = useApp();
  const [view, setView] = React.useState<TriageView>();
  const [busy, setBusy] = React.useState<string>();
  const [error, setError] = React.useState<string>();
  const load = React.useCallback(() => void call('triage.get', {}).then(setView), []);
  React.useEffect(() => {
    load();
    return onEvent((e) => (e.topic === 'triage' || e.topic === 'material') && load());
  }, [load]);

  async function act(name: string, run: () => Promise<{ ok: boolean; detail?: string }>) {
    setBusy(name);
    setError(undefined);
    try {
      const r = await run();
      if (!r.ok) setError(r.detail);
    } finally {
      setBusy(undefined);
      load();
    }
  }

  /** A draft is working material of the job's project: the viewer opens it there. */
  function openDraft(materialId: string) {
    if (view?.projectId) setPrefs((p) => ({ ...p, selectedProjectId: view.projectId ?? p.selectedProjectId }));
    openTab('file', materialId);
  }

  if (!view) return <div className="flex-1" />;
  const b = view.brief;
  const cap = view.capability;
  const active = cap?.state === 'active';
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="brief">
      <header className="flex h-12 shrink-0 items-center gap-2 px-3 md:px-4">
        <h1 className="sr-only">Mail triage</h1>
        {view.running && (
          <Badge tone="pending" data-testid="triage-running">
            <Loader2 className="animate-spin" /> Working
          </Badge>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {view.running ? (
            <Button variant="outline" size="sm" onClick={() => void act('stop', () => call('triage.stop', {}))}>
              Stop
            </Button>
          ) : (
            view.connection && (
              <Button variant="outline" size="sm" disabled={!!busy} onClick={() => void act('run', () => call('triage.run', {}))}>
                Run now
              </Button>
            )
          )}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-10 md:px-4">
        <div className="mx-auto max-w-3xl space-y-6 pt-2">
          <section aria-label="Mailbox and capability" className="rounded-lg border border-border p-3 text-sm" data-testid="triage-status">
            {!view.connection ? (
              <div className="space-y-2">
                <p>Connect a mailbox. Until you permit what the journey may do, it only reads.</p>
                <Button size="sm" disabled={!!busy || !view.available} onClick={() => void act('connect', () => call('triage.connect', {}))}>
                  Connect the sample mailbox
                </Button>
                {!view.available && <p className="text-xs text-muted">The job needs the app's engine and a model; set one up in Settings.</p>}
              </div>
            ) : (
              <div className="space-y-2">
                <p className="break-words">
                  {view.connection.label} · <span className="text-muted">{view.connection.readOnly ? 'reads only, until you give permission' : 'permitted'}</span>
                </p>
                {cap && (
                  <p className="flex flex-wrap items-center gap-2 text-xs text-muted" data-testid="capability">
                    <Badge tone={active ? 'committed' : 'neutral'}>
                      <ShieldCheck /> Capability v{cap.version} · {cap.state}
                    </Badge>
                    <span className="break-all font-mono">sha256:{cap.hash.slice(0, 16)}…</span>
                    {cap.reason && <span>{cap.reason}</span>}
                  </p>
                )}
                {cap?.effectiveSummary && (
                  <details open className="text-xs text-muted" data-testid="effective-limits">
                    <summary>Current limits (narrowed)</summary>
                    <ul className="mt-1 space-y-1">{cap.effectiveSummary.map((line) => <li key={line}>{line}</li>)}</ul>
                  </details>
                )}
                {view.offer && (
                  <div className="space-y-1">
                    <p className="text-xs text-muted">{view.offer.again ? 'Suspended: give permission again to let the journey act.' : view.offer.widening.length ? `A new version widens: ${view.offer.widening.join(', ')}.` : 'Give permission once: read mail, draft replies; label and move as proposals.'}</p>
                    <Button size="sm" disabled={!!busy} onClick={() => void act('sign', () => signCapability())}>
                      Give permission…
                    </Button>
                  </div>
                )}
                <p className="text-xs text-muted">Writes to the mailbox are {view.writes === 'gated' ? 'off: accepted changes wait, unapplied, until the door is accepted' : 'on'}.</p>
                <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => void act('disconnect', () => call('triage.disconnect', {}))}>
                  Disconnect
                </Button>
              </div>
            )}
            {error && (
              <p className="mt-2 flex items-start gap-1.5 text-xs text-danger" role="alert">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0" /> {error}
              </p>
            )}
          </section>

          {b.stopped && (
            <p className="text-sm text-muted" data-testid="brief-stopped">
              The last run stopped early: {b.stopped}
            </p>
          )}

          {b.counts.requests > 0 && (
            <p className="text-sm" data-testid="brief-counts">
              {b.counts.requests} requests · {b.counts.drafted} drafted · {b.counts.proposed} proposed · {b.counts.needsYou} need you
              {b.counts.unknown > 0 && ` · ${b.counts.unknown} unknown`}
            </p>
          )}

          {b.needsYou.length > 0 && (
            <section aria-label="Needs you" className="space-y-2">
              <h2 className="text-xs font-medium uppercase tracking-wide text-muted">Needs you</h2>
              <ul className="space-y-1.5">
                {b.needsYou.map((n) => (
                  <li key={n.message.id} className="rounded-md bg-sunken px-3 py-2 text-sm" data-testid={`needs-${n.message.id}`}>
                    <p className="truncate font-medium">{n.message.subject}</p>
                    <p className="truncate text-xs text-muted">{n.message.from}</p>
                    <p className="mt-1 text-xs">{n.reason}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {b.done.length > 0 && (
            <Items title="Done" items={b.done} render={(d) =>
              d.materialId ? (
                <Button variant="ghost" size="sm" aria-label={`Open the draft for ${d.message.subject}`} onClick={() => openDraft(d.materialId!)}>
                  <FileText /> Open draft
                </Button>
              ) : null
            } />
          )}

          {b.proposed.length > 0 && (
            <Items title="Proposed" items={b.proposed} render={(p) =>
              p.decidable ? (
                <span className="flex gap-1">
                  <Button size="sm" disabled={!!busy} onClick={() => void act(p.effect, () => call('triage.decide', { effect: p.effect, verdict: 'accept' }))}>
                    Accept
                  </Button>
                  <Button variant="outline" size="sm" disabled={!!busy} onClick={() => void act(p.effect, () => call('triage.decide', { effect: p.effect, verdict: 'discard' }))}>
                    Discard
                  </Button>
                </span>
              ) : p.undoable ? (
                <Button variant="outline" size="sm" disabled={!!busy} onClick={() => void act(p.effect, () => call('triage.undo', { effect: p.effect }))}>
                  Undo
                </Button>
              ) : null
            } />
          )}

          {b.requests.length > 0 && (
            <section aria-label="Requests" className="space-y-2">
              <h2 className="text-xs font-medium uppercase tracking-wide text-muted">Requests</h2>
              <ul className="divide-y divide-border text-sm">
                {b.requests.map((r) => (
                  <li key={r.id} className="flex min-w-0 flex-wrap items-baseline gap-x-2 py-1.5" data-testid={`request-${r.id}`}>
                    <span className="min-w-0 flex-1 truncate">{r.subject}</span>
                    <span className="text-xs text-muted">{r.category ?? '—'}</span>
                    <span className="text-xs text-muted">{r.urgency ?? '—'}</span>
                    {r.suspicious && <Badge tone="danger">suspicious</Badge>}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function Items({ title, items, render }: { title: string; items: BriefItem[]; render: (i: BriefItem) => React.ReactNode }) {
  return (
    <section aria-label={title} className="space-y-2">
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted">{title}</h2>
      <ul className="space-y-1.5">
        {items.map((i) => (
          <li key={i.effect} className="rounded-md border border-border px-3 py-2 text-sm" data-testid={`${i.kind}-${i.message.id}`}>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-medium">{i.summary}</span>
              <Badge tone={TONE[i.outcome]}>{OUTCOME_WORDS[i.outcome]}</Badge>
            </div>
            <p className="truncate text-xs text-muted">
              {i.message.subject} · {i.message.from}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
              {i.recovery && <span>Recovery: {RECOVERY_WORDS[i.recovery]}{i.undo ? ` (${i.undo})` : ''}</span>}
              {i.detail && <span>{i.detail}</span>}
              <span className="ml-auto">{render(i)}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
