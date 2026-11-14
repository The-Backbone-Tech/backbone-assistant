// Side chat: read-only by construction; an effect is refused by name (R-UX-SIDECHAT-01).
import type { ProjectFile, Thread } from '@backbone-next/platform';
import { ArrowUp, Lock } from 'lucide-react';
import * as React from 'react';
import { call, clientKey } from '../../lib/api';
import { useApp, useLive } from '../../lib/state';
import { acceptDraftRead, flushDraft, hasUnconfirmedDraft, hasUncertainDraft, retryUncertainDraft, keepReviewedDraft, persistDraft, persistDraftNow, readDraft, reviewSavedDraft, useReviewedDraft } from '../../lib/drafts';
import { Answer } from '../Answer';
import { DraftConflictCopies } from '../DraftConflictCopies';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

// A tab can unmount while its transport is pending; another instance must observe the same in-flight question.
const pendingQuestions = new Set<string>();
const pendingListeners = new Set<() => void>();
// A Stop belongs to its exact side turn even if the tab is closed or another chat is selected.
const pendingStops = new Set<string>();
let stopRevision = 0;
const stopKey = (threadId: string, turnId: string) => JSON.stringify([threadId, turnId]);
function markStopping(key: string, pending: boolean) {
  if (pending) pendingStops.add(key); else pendingStops.delete(key);
  stopRevision++;
  for (const listener of pendingListeners) listener();
}
const subscribePending = (listener: () => void) => { pendingListeners.add(listener); return () => { pendingListeners.delete(listener); }; };
function markPending(threadId: string, pending: boolean) {
  if (pending) pendingQuestions.add(threadId); else pendingQuestions.delete(threadId);
  for (const listener of pendingListeners) listener();
}

export function SideChatTab({ threadId }: { threadId: string }) {
  const thread = useLive(async () => {
    const r = await call('threads.get', { id: threadId });
    return r.ok ? r.value : null;
  }, [threadId], null as Thread | null);
  // A thread still on screen from before a switch is not shown: its answers are another thread's.
  const current = thread?.summary.id === threadId ? thread : null;
  const projectId = current?.summary.projectId;
  const workspace = useLive(async () => (projectId ? { projectId, files: await call('files.list', { projectId }) } : undefined), [projectId], undefined as { projectId: string; files: ProjectFile[] } | undefined);
  const { showSentNotice } = useApp();
  const key = `side-chat:${threadId}`;
  const requestKey = `side-chat-request:${threadId}`;
  const owner = React.useRef({ threadId, epoch: 0 });
  if (owner.current.threadId !== threadId) owner.current = { threadId, epoch: owner.current.epoch + 1 };
  const epoch = owner.current.epoch;
  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const owns = () => mounted.current && owner.current.epoch === epoch;
  const edits = React.useRef(0);
  const [draft, setDraft] = React.useState<{ epoch: number; text: string }>();
  const [error, setError] = React.useState<{ epoch: number; detail: string }>();
  const [reviewedDraft, setReviewedDraft] = React.useState<{epoch: number; key: string; revision: number; text: string; meta?: Record<string, string | number>}>();
  const [reviewingDraft, setReviewingDraft] = React.useState(false);
  const [confirmSavedDraft, setConfirmSavedDraft] = React.useState(false);
  const [loadAttempt, retryLoad] = React.useReducer((n: number) => n + 1, 0);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [request, setRequest] = React.useState<{ epoch: number; text: string; clientKey: string }>();
  React.useSyncExternalStore(subscribePending, () => stopRevision, () => 0);

  const ready = draft?.epoch === epoch;
  const text = ready ? draft.text : '';
  const busy = React.useSyncExternalStore(subscribePending, () => pendingQuestions.has(threadId), () => false);
  const running = current?.sideTurns.some((turn) => turn.status === 'running' || turn.sideRecoveryPending) ?? false;
  React.useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => { if (live) setLoadFailed(true); }, 10000);
    ++edits.current;
    setDraft(undefined); setRequest(undefined); setError(undefined); setReviewedDraft(undefined); setConfirmSavedDraft(false); setLoadFailed(false);
    void Promise.all([readDraft(key), readDraft(requestKey)]).then(([value, saved]) => {
      if (live) {
        window.clearTimeout(timer);
        acceptDraftRead(key, value?.revision ?? 0);
        acceptDraftRead(requestKey, saved?.revision ?? 0);
        setDraft({ epoch, text: value?.text ?? '' });
        if (hasUnconfirmedDraft(key) || hasUnconfirmedDraft(requestKey)) setError({epoch, detail:'A side-chat draft could not be confirmed. Your local text is kept; review the saved value.'});
        if (saved?.text && typeof saved.meta?.clientKey === 'string') setRequest({ epoch, text: saved.text, clientKey: saved.meta.clientKey });
      }
    }).catch(() => { if (live) { window.clearTimeout(timer); setLoadFailed(true); } });
    return () => { live = false; window.clearTimeout(timer); };
  }, [key, loadAttempt]);
  // A request may settle in an unmounted instance while this tab is reopened.
  React.useEffect(() => {
    if (busy || !ready) return;
    let live = true;
    void readDraft(requestKey).then((saved) => {
      if (!live) return;
      acceptDraftRead(requestKey, saved?.revision ?? 0);
      setRequest(saved?.text && typeof saved.meta?.clientKey === 'string' ? { epoch, text: saved.text, clientKey: saved.meta.clientKey } : undefined);
    }).catch(() => { if (live) setLoadFailed(true); });
    return () => { live = false; };
  }, [busy, requestKey, epoch, ready, loadAttempt]);

  function report(detail: string) {
    if (owns()) setError({ epoch, detail });
    else showSentNotice(threadId, detail, 'side-chat', true);
  }

  function update(text: string) {
    const edit = ++edits.current;
    setDraft({ epoch, text }); setError(undefined);
    void persistDraft(key, text).catch(() => {
      if (owns() && edit === edits.current) setError({ epoch, detail: 'The side-chat draft could not be saved.' });
    });
  }

  async function ask(e: React.FormEvent, retry = false) {
    e.preventDefault();
    if (!ready || pendingQuestions.has(threadId) || (retry ? !request : !text.trim() || !!request || running)) return;
    const snapshot = retry ? request! : { epoch, text, clientKey: clientKey() };
    const submitted = edits.current;
    markPending(threadId, true); setError(undefined);
    try {
      try {
        await persistDraftNow(key, text);
        await persistDraftNow(requestKey, snapshot.text, { clientKey: snapshot.clientKey });
        if (owns()) setRequest(snapshot);
      }
      catch { report('The question was not sent because its draft could not be saved.'); return; }
      const r = await call('sidechat.ask', { threadId, text: snapshot.text, clientKey: snapshot.clientKey });
      if (!r.ok) {
        if (r.outcome !== 'UNKNOWN') {
          await persistDraftNow(requestKey, '');
          if (owns()) setRequest(undefined);
        }
        report(r.detail); return;
      }
      if (r.value.sideRecoveryPending) {
        report('The question was recorded, but its outcome is unknown while the side run is reconciled. Your draft and retry identity were kept.');
        return;
      }
      await persistDraftNow(requestKey, '');
      if (owns()) setRequest(undefined);
      if (owns() && submitted === edits.current && text === snapshot.text) {
        ++edits.current;
        setDraft({ epoch, text: '' });
        void persistDraft(key, '').catch(() => {
          report('The question was recorded, but its saved draft could not be cleared. Check the side chat before asking it again.');
        });
      } else if (!owns()) {
        showSentNotice(threadId, 'An earlier side question was recorded. Its saved text was kept after you changed views; open that chat before asking it again.', 'side-chat');
      }
    } catch {
      report('The question could not be confirmed. Retry the original question with the same identity, or check this side chat.');
    } finally {
      markPending(threadId, false);
    }
  }

  function reportStop(detail: string) {
    if (owns()) setError({ epoch, detail });
    else showSentNotice(threadId, `A Stop in an earlier side chat: ${detail}`, 'side-chat', true);
  }

  async function stop(turnId: string) {
    const key = stopKey(threadId, turnId);
    if (pendingStops.has(key)) return;
    markStopping(key, true);
    try { const r = await call('sidechat.stop', { threadId, turnId }); if (!r.ok) reportStop(r.detail); }
    catch { reportStop('The stop could not be confirmed. Check the side question before trying again.'); }
    finally { markStopping(key, false); }
  }

  return (
    <div className="flex h-full flex-col" data-testid="side-chat-tab">
      <p className="flex items-center gap-1.5 border-b border-border px-3 py-2 text-xs text-muted">
        <Lock className="size-3.5" /> Side questions use read-only tools.
      </p>
      <ol className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3 text-sm">
        {current?.sideTurns.map((t) => (
          <li key={t.id} className="space-y-2">
            <p className="ml-auto w-fit max-w-[85%] rounded-xl bg-sunken px-3 py-2">{t.user.text}</p>
            {t.sideRun?.scope === 'read-only' && <Badge>Read-only</Badge>}
            {t.sideRecoveryPending ? (
              <div className="reading" role="status">
                <p>Unknown outcome. Any partial answer is unconfirmed; it was not sent again.</p>
                {t.status === 'running' && <button type="button" className="underline" disabled={pendingStops.has(stopKey(threadId, t.id))} onClick={() => void stop(t.id)}>Stop side question</button>}
                <Answer text={t.answer?.text ?? ''} projectId={current.summary.projectId} workspace={workspace} touched={t.answer?.files} />
              </div>
            ) : t.status === 'refused' && t.refusal ? (
              <div role="status" className="rounded-lg border border-danger px-3 py-2" data-testid="side-chat-refusal">
                <Badge tone="danger">{t.refusal.reason === 'SIDE_CHAT_READ_ONLY' ? 'Action not performed' : 'Refused'} · {t.refusal.reason}</Badge>
                <p className="mt-1 whitespace-pre-wrap">{t.refusal.detail}</p>
              </div>
            ) : (
              <div className="reading">
                {t.status === 'running' && <p role="status">Working on this side question… <button type="button" className="underline" disabled={pendingStops.has(stopKey(threadId, t.id))} onClick={() => void stop(t.id)}>Stop side question</button></p>}
                {t.status === 'stopped' && <p role="status">This side question stopped or could not finish.</p>}
                <Answer text={t.answer?.text ?? ''} projectId={current.summary.projectId} workspace={workspace} touched={t.answer?.files} />
              </div>
            )}
          </li>
        ))}
      </ol>
      <DraftConflictCopies draftKey={key} />
      <DraftConflictCopies draftKey={requestKey} />
      {!ready && <p role="status" className="px-3 py-2 text-xs text-muted">{loadFailed ? <>The side-chat draft could not be loaded yet. <button className="underline" onClick={() => retryLoad()}>Try loading again</button></> : 'Loading draft…'}</p>}
      {error?.epoch === epoch && <div className="px-3 py-2 text-xs text-danger">
        <p role="alert">{error.detail}</p>
        {[key, requestKey].filter(hasUncertainDraft).map(retryKey => <button key={retryKey} type="button" className="mr-2 underline" disabled={reviewingDraft} onClick={() => {
          setReviewingDraft(true);
          void retryUncertainDraft(retryKey).then(() => flushDraft(retryKey)).then(() => reviewSavedDraft(retryKey)).then(saved => {
            if (!owns()) return;
            if (retryKey === requestKey) setRequest(saved?.text && typeof saved.meta?.clientKey === 'string' ? {epoch, text:saved.text, clientKey:saved.meta.clientKey} : undefined);
            setError(undefined);
          }).catch((e:unknown) => { if (owns()) setError({epoch, detail:`The draft could not be saved: ${String(e)}`}); })
            .finally(() => { if (owns()) setReviewingDraft(false); });
        }}>{retryKey === key ? 'Retry saving draft' : 'Retry saving request'}</button>)}
        {[key, requestKey].filter(hasUnconfirmedDraft).map(reviewKey => <button key={reviewKey} type="button" className="mr-2 underline" disabled={reviewingDraft} onClick={() => {
          setReviewingDraft(true);
          void reviewSavedDraft(reviewKey).then(saved => { if (owns()) setReviewedDraft({epoch, key:reviewKey, revision:saved?.revision ?? 0, text:saved?.text ?? '', meta:saved?.meta}); })
            .catch((e: unknown) => { if (owns()) setError({epoch, detail:`The saved draft could not be read: ${String(e)}`}); })
            .finally(() => { if (owns()) setReviewingDraft(false); });
        }}>{reviewKey === key ? 'Review saved draft' : 'Review saved request'}</button>)}
        {reviewedDraft?.epoch === epoch && <div className="mt-2 text-fg">
          <p>Saved {reviewedDraft.key === key ? 'draft' : 'request'}:</p><pre className="whitespace-pre-wrap break-words">{reviewedDraft.text || '(empty)'}</pre>
          {reviewedDraft.meta && Object.keys(reviewedDraft.meta).length > 0 && <><p>Saved details:</p><pre className="whitespace-pre-wrap break-words">{JSON.stringify(reviewedDraft.meta, null, 2)}</pre></>}
          {reviewedDraft.key === key ? <><p>Your current question stays here. Keeping it replaces the saved draft only if it has not changed again.</p>
            <button type="button" className="underline" disabled={reviewingDraft} onClick={() => {
              setReviewingDraft(true);
              void keepReviewedDraft(key, reviewedDraft.revision, text).then(() => { if (owns()) { setReviewedDraft(undefined); setError(undefined); } })
                .catch((e: unknown) => { if (owns()) { setReviewedDraft(undefined); setError({epoch, detail:`The draft could not be saved: ${String(e)}`}); } })
                .finally(() => { if (owns()) setReviewingDraft(false); });
            }}>Keep my draft</button></> : <p>This request may already have been sent. Check its conversation before deciding what to do.</p>}{' '}
          {!confirmSavedDraft ? <button type="button" className="underline" disabled={reviewingDraft} onClick={() => setConfirmSavedDraft(true)}>Use saved {reviewedDraft.key === key ? 'draft' : 'request'}</button> : <div>
            <p>This replaces the local {reviewedDraft.key === key ? 'question' : 'request record'}. An earlier request may already have been sent; this does not cancel or resolve it.</p>
            <button type="button" className="underline mr-2" onClick={() => setConfirmSavedDraft(false)}>Cancel</button>
            <button type="button" className="underline" disabled={reviewingDraft} onClick={() => {
              setReviewingDraft(true);
              void useReviewedDraft(reviewedDraft.key, reviewedDraft.revision).then(saved => {
                if (!owns()) return;
                if (reviewedDraft.key === key) { ++edits.current; setDraft({epoch, text:saved.text}); }
                else setRequest(saved.text && typeof saved.meta?.clientKey === 'string' ? {epoch, text:saved.text, clientKey:saved.meta.clientKey} : undefined);
                setReviewedDraft(undefined); setConfirmSavedDraft(false); setError(undefined);
              }).catch((e: unknown) => { if (owns()) { setReviewedDraft(undefined); setConfirmSavedDraft(false); setError({epoch, detail:`The saved value could not be confirmed: ${String(e)}`}); } })
                .finally(() => { if (owns()) setReviewingDraft(false); });
            }}>Replace my local {reviewedDraft.key === key ? 'draft' : 'request'}</button>
          </div>}
        </div>}
      </div>}
      {request?.epoch === epoch && <div className="px-3 py-2 text-xs" role="status">The original question is awaiting confirmation: {request.text} <button type="button" className="underline" disabled={busy} onClick={(e) => void ask(e, true)}>Retry original question</button></div>}
      <form onSubmit={(e) => void ask(e)} className="flex items-center gap-2 border-t border-border p-2">
        <Input aria-label="Ask the side chat" placeholder="Ask without changing anything" disabled={!ready} value={text} onChange={(e) => update(e.target.value)} className="flex-1" />
        <Button size="icon-sm" aria-label="Ask" disabled={!ready || busy || running || !!request || !text.trim()}>
          <ArrowUp />
        </Button>
      </form>
    </div>
  );
}
