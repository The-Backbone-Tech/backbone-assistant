import { SharedConversation } from './SharedConversation';
import { UnknownOutcome } from './UnknownOutcome';
import { FileAccessHint } from './MacFileAccess';
// The thread: a turn timeline with collapsed history, one calm work block per turn and inline file
// links. The owning thread renders its details into the shared conversation bar; progress and
// unresolved outcomes stay beside the work, without a permanent summary row.
import { MessageScroller, useMessageScroller } from '@shadcn/react/message-scroller';
import type { FileLink, MaterialEntry, ProjectFile, Thread as ThreadData, Turn, TurnSteer } from '@backbone-next/platform';
import { ArrowDown, ChevronDown, ChevronRight, CircleAlert, Diff, GitBranch, Loader2, MoreHorizontal, Target } from 'lucide-react';
import * as React from 'react';
import { createPortal } from 'react-dom';
import { call, clientKey } from '../lib/api';
import { useApp, useLive } from '../lib/state';
import { cn, duration } from '../lib/utils';
import { workEvidence, type EvidenceLink } from '../lib/work-evidence';
import { ForkRoleNotice } from './ForkRoleNotice';
import { PendingRewind, RewindButton, RewindHistory } from './Rewind';
import { Answer } from './Answer';
import { CompactionHistory } from './CompactionHistory';
import { TurnSelectionCard } from './TaskSelection';
import { useConversationBar } from './ConversationTabs';
import { Composer, EFFORTS, PERMISSIONS } from './Composer';
import { QueuedMessages, ThreadWork, ThreadWorkDialog, type ThreadWorkAsk } from './ThreadWork';
import { ScheduleCards, ScheduleDialog } from './Scheduled';
import { TurnMemoryCard } from './Memory';
import { FileIcon } from './files/kind';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu';

const VISIBLE_TURNS = 3;

export function Thread({id}:{id:string}){
  const {remote}=useApp();return remote?<SharedConversation id={id} />:<LocalThread id={id} />;
}
function LocalThread({ id }: { id: string }) {
  const { openTab, setPrefs } = useApp();
  const { target, hasTabs, closeView } = useConversationBar();
  const [recoveryReload, setRecoveryReload] = React.useState(0);
  const [recoveryBusy, setRecoveryBusy] = React.useState(false);
  const recoveryInFlight = React.useRef(false);
  const recoveryThread = React.useRef({ id, epoch: 0 });
  if (recoveryThread.current.id !== id) recoveryThread.current = { id, epoch: recoveryThread.current.epoch + 1 };
  const [recoveryResult, setRecoveryResult] = React.useState<{ detail: string; cleared: boolean; files: FileLink[] }>();
  const [recoveryError, setRecoveryError] = React.useState<string>();
  React.useEffect(() => { recoveryInFlight.current = false; setRecoveryBusy(false); setRecoveryResult(undefined); setRecoveryError(undefined); }, [id]);
  const thread = useLive(async () => {
    const r = await call('threads.get', { id });
    return r.ok ? r.value : null;
  }, [id, recoveryReload], null as ThreadData | null);
  const [showAll, setShowAll] = React.useState(false);
  const [historyTarget, setHistoryTarget] = React.useState<{ id: string }>();
  const [followOutput, setFollowOutput] = React.useState(true);
  const [ask, setAsk] = React.useState<ThreadWorkAsk>();
  const [scheduling, setScheduling] = React.useState(false);
  const [problem, setProblem] = React.useState<string>();
  const [restarting, setRestarting] = React.useState(false);
  const restartTarget = React.useRef<string | undefined>(undefined);
  React.useEffect(() => { restartTarget.current = undefined; setRestarting(false); setProblem(undefined); }, [id]);
  // The workspace's documents, once per thread and tagged with their project: an answer's local links open only these.
  const projectId = thread?.summary.projectId;
  const workspace = useLive(async () => (projectId ? { projectId, files: await call('files.list', { projectId }) } : undefined), [projectId], undefined as { projectId: string; files: ProjectFile[] } | undefined);
  React.useEffect(() => {
    if (thread?.summary.unread && !thread.summary.running) void call('threads.update', { id, patch: { unread: false } });
  }, [id, thread?.summary.unread, thread?.summary.running]);

  if (!thread) return <div className="flex-1" />;
  const openOriginalHistory = (turnId: string) => { setFollowOutput(false); setShowAll(true); setHistoryTarget({ id: turnId }); };
  const clearGoal = async () => {
    const r = await call('goals.clear', { threadId: id, baseVersion: thread.goal?.version ?? 0 });
    setProblem(r.ok ? undefined : r.detail);
  };
  const restart = async () => {
    if (restarting || !thread.turns.length) return;
    const epoch = recoveryThread.current.epoch;
    const turnId = restartTarget.current ?? thread.turns.at(-1)!.id;
    restartTarget.current = turnId;
    setRestarting(true); setProblem(undefined);
    try {
      const result = await call('threads.restart', { threadId: id, turnId });
      if (recoveryThread.current.epoch !== epoch) return;
      if (result.ok) restartTarget.current = undefined;
      else { restartTarget.current = undefined; setProblem(result.detail); }
    } catch {
      if (recoveryThread.current.epoch === epoch) setProblem('Restart could not be confirmed. Reload the conversation to inspect its progress; trying again uses the same turn.');
    } finally { if (recoveryThread.current.epoch === epoch) setRestarting(false); }
  };
  const hidden = showAll ? 0 : Math.max(0, thread.turns.length - VISIBLE_TURNS);
  const s = thread.summary;
  const recoveryHold = s.recoveryHold;
  const recoveryTurn = thread.turns.find((turn) => turn.id === recoveryHold?.turnId);
  const reloadRecovery = () => setRecoveryReload((n) => n + 1);
  const keepRecovery = async () => {
    if (recoveryInFlight.current || !recoveryHold || s.running || !['inspection', 'awaiting-decision'].includes(recoveryHold.kind) || !recoveryTurn?.recovery) return;
    const epoch = recoveryThread.current.epoch;
    recoveryInFlight.current = true; setRecoveryBusy(true); setRecoveryError(undefined); setRecoveryResult(undefined);
    try {
      const r = await call('turns.keepRecovery', { threadId: id, turnId: recoveryHold.turnId, revision: recoveryTurn.recovery.revision });
      if (recoveryThread.current.epoch !== epoch) return;
      if (r.ok) setRecoveryResult(r.value); else setRecoveryError(r.detail);
    } catch { if (recoveryThread.current.epoch === epoch) setRecoveryError('The action could not be confirmed. Reload this conversation before trying again.'); }
    finally { if (recoveryThread.current.epoch === epoch) { recoveryInFlight.current = false; setRecoveryBusy(false); reloadRecovery(); } }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-conversation">
      <h1 className="sr-only" data-testid="thread-title">{s.title}</h1>
      {target && createPortal(
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size={hasTabs ? 'icon-sm' : 'sm'} className={cn(!hasTabs && 'min-w-0 max-w-full justify-start font-normal')} aria-label="Chat details" title={`${s.title} · ${thread.card.project}`}>
              {hasTabs ? <MoreHorizontal /> : <><span className="truncate">{s.title}</span><ChevronDown className="shrink-0 text-muted" /></>}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align={hasTabs ? 'end' : 'start'} data-testid="summary-card">
            <DropdownMenuLabel className="max-w-72 whitespace-normal">{thread.card.project}</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => openTab('changes')}>
              Changes <span className="ml-auto text-xs"><span className="text-committed">+{thread.card.changes.added}</span> <span className="text-danger">−{thread.card.changes.removed}</span> in {thread.card.changes.files} {thread.card.changes.files === 1 ? 'file' : 'files'}</span>
            </DropdownMenuItem>
            {thread.card.sources.length > 0 && <>
              <DropdownMenuLabel>Attached files</DropdownMenuLabel>
              {thread.card.sources.map((file) => <DropdownMenuItem key={file.materialId} onSelect={() => openTab('file', file.materialId)}><FileIcon name={file.name} /><span className="max-w-52 truncate">{file.name}</span><span className="ml-auto text-xs text-muted">v{file.version}</span></DropdownMenuItem>)}
            </>}
            {(thread.card.subagents.active > 0 || thread.card.subagents.done > 0) && <DropdownMenuLabel>{thread.card.subagents.active} working · {thread.card.subagents.done} completed</DropdownMenuLabel>}
            <DropdownMenuSeparator />
            {!thread.child && <>
              <DropdownMenuItem onSelect={() => setAsk('goal')}>{thread.goal?.current ? 'Change goal…' : 'Set goal…'}</DropdownMenuItem>
              {thread.goal?.current && <DropdownMenuItem onSelect={() => void clearGoal()}>Clear goal</DropdownMenuItem>}
              <DropdownMenuItem onSelect={() => setScheduling(true)}>Schedule…</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void call('skills.draft', { threadId: id }).then((r) => setProblem(r.ok ? undefined : r.detail))}>Make a skill from this chat</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setAsk('worker')}>Start a worker…</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setAsk('reviewer')}>Ask for a review…</DropdownMenuItem>
              <DropdownMenuSeparator />
            </>}
            <DropdownMenuItem onSelect={() => void call('threads.update', { id, patch: { pinned: !s.pinned } })}>{s.pinned ? 'Unpin' : 'Pin'}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openTab('side-chat')}>New side chat</DropdownMenuItem>
            <DropdownMenuItem disabled={restarting || thread.turns.length === 0} onSelect={() => void restart()}>{restarting ? 'Restarting conversation…' : 'Restart conversation'}</DropdownMenuItem>
            <DropdownMenuItem onSelect={closeView}>Close chat view</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void call('threads.update', { id, patch: { archived: true } })}>Archive</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>, target)}

      <ThreadWorkDialog thread={thread} ask={ask} onClose={() => setAsk(undefined)} />
      <RewindHistory records={thread.rewinds} />
      <PendingRewind threadId={id} record={thread.rewindPending} />
      <ScheduleDialog thread={thread.summary} goal={thread.goal?.current?.text} open={scheduling} onClose={() => setScheduling(false)} />
      {recoveryHold && <div role="status" data-testid="recovery-hold" className="border-b border-border px-4 py-3 text-sm text-muted">
        <p className="font-medium text-fg">This conversation is waiting for recovery.</p>
        <p>{recoveryHold.kind === 'recovering' ? 'Saved work is being reconciled.' : recoveryHold.kind === 'awaiting-decision' ? 'Saved work is waiting for your decision. Nothing was resent.' : 'Saved recovery data needs inspection. Nothing was resent. This conversation cannot be deleted while it is held.'} The saved bytes are kept. Other conversations still work. Your unsent message stays here.</p>
        {recoveryHold.kind === 'inspection' && <button type="button" className="mt-1 underline" onClick={() => setPrefs((p) => ({ ...p, view: 'now', selectedThreadId: undefined }))}>Open Now to inspect saved work</button>}
        {!s.running && (recoveryHold.kind === 'inspection' || recoveryHold.kind === 'awaiting-decision') && recoveryTurn?.recovery && <div className="mt-2 space-y-1" data-testid="keep-recovery">
          <p>{recoveryTurn.recovery.detail}</p>
          <p>This cancels unsent work in this conversation, including work that would otherwise continue automatically when recovery resumes, and keeps the recovery data as copies for inspection. It never resumes or sends that work.</p>
          <Button size="sm" variant="outline" disabled={recoveryBusy} onClick={() => void keepRecovery()}>{recoveryBusy ? 'Keeping recovery data…' : 'Keep recovery data'}</Button>
        </div>}
        {recoveryError && <p role="alert" className="mt-2">{recoveryError} <button type="button" className="underline" onClick={reloadRecovery}>Reload conversation</button></p>}
      </div>}
      {recoveryResult && <div role="status" data-testid="keep-recovery-result" className="border-b border-border px-4 py-2 text-sm">
        <p>{recoveryResult.detail}</p>
        <p>{recoveryResult.cleared ? 'That recovery was cleared. Check the conversation status before sending.' : 'This attempt did not clear recovery. An unknown outcome or held action may still need attention.'}</p>
        {recoveryResult.files.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{recoveryResult.files.map((file) => <FileChip key={`${file.materialId}:${file.version}`} link={file} />)}</div>}
      </div>}
      <MessageScroller.Provider key={id} autoScroll={followOutput} defaultScrollPosition="last-anchor">
        <MessageScroller.Root className="relative flex min-h-0 flex-1 flex-col">
          <MessageScroller.Viewport role="region" aria-label="Conversation" preserveScrollOnPrepend={!historyTarget} onPointerDown={() => setFollowOutput(false)} onFocusCapture={() => setFollowOutput(false)} className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
            <div className="mx-auto flex max-w-3xl flex-col gap-1 px-4 pt-4 text-ui empty:hidden"><ScheduleCards threadId={id} /></div>
            <ThreadWork thread={thread} problem={problem} setProblem={setProblem} onChangeGoal={thread.child ? undefined : () => setAsk('goal')} onClearGoal={thread.child ? undefined : () => void clearGoal()} />
            <MessageScroller.Content role="list" aria-live="off" className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6" aria-label="Transcript">
              {hidden > 0 && (
                <MessageScroller.Item role="listitem" messageId="history">
                  <button type="button" className="mx-auto block rounded-full border border-border px-3 py-1 text-xs text-muted hover:bg-hover" onClick={() => setShowAll(true)}>
                    {hidden} previous {hidden === 1 ? 'message' : 'messages'}
                  </button>
                </MessageScroller.Item>
              )}
              {thread.turns.slice(hidden).map((t) => (
                <MessageScroller.Item key={t.id} role="listitem" messageId={t.id} scrollAnchor className="min-w-0 shrink-0">
                  <TurnView roleLimited={thread.child?.agentRole?.tools !== undefined} turn={t} threadId={id} projectId={s.projectId} workspace={workspace} openOriginalHistory={openOriginalHistory} />
                </MessageScroller.Item>
              ))}
            </MessageScroller.Content>
          </MessageScroller.Viewport>
          <OriginalHistoryLocation target={historyTarget} />
          <LatestButton paused={!followOutput} onResume={() => { setHistoryTarget(undefined); setFollowOutput(true); }} />
        </MessageScroller.Root>
      </MessageScroller.Provider>
      <div className="mx-auto w-full max-w-3xl shrink-0 px-3 pb-3 md:px-4 md:pb-4">
        <QueuedMessages thread={thread} />
        <Composer taskMemoryOff={thread.turns.at(-1)?.user.settings?.memory === 'off'} recoveryHeld={!!recoveryHold} previousSelection={thread.turns.findLast((t) => t.selection && t.selection.origin !== 'goal-run')?.selection} projectId={s.projectId} threadId={id} running={s.running} steering={thread.steering} stopping={!!thread.turns.at(-1)?.stopRequested} autoFocus />
      </div>
    </div>
  );
}

/** An explicit history jump replaces prepend preservation. Let the content observer finish its
 * expansion first, then give the selected anchor to the maintained scroller on the next frame. */
function OriginalHistoryLocation({ target }: { target?: { id: string } }) {
  const { scrollToMessage } = useMessageScroller();
  React.useEffect(() => {
    if (!target) return;
    const frame = requestAnimationFrame(() => scrollToMessage(target.id, { align: 'start', behavior: 'auto' }));
    return () => cancelAnimationFrame(frame);
  }, [target, scrollToMessage]);
  return null;
}

/** The native scroller handles wheel/keyboard intent. Pointer selection and focused controls also
 * pause our following; while paused, keep an explicit resume action even before output grows. */
function LatestButton({ paused, onResume }: { paused: boolean; onResume: () => void }) {
  const { scrollToEnd } = useMessageScroller();
  const className = 'absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-bg shadow-sm data-[active=false]:hidden';
  const content = <><ArrowDown aria-hidden /> Jump to latest</>;
  if (paused) return <Button variant="outline" size="sm" aria-label="Jump to latest" className={className} onClick={() => { scrollToEnd({ behavior: 'auto' }); onResume(); }}>{content}</Button>;
  return <MessageScroller.Button direction="end" behavior="auto" aria-label="Jump to latest" render={<Button variant="outline" size="sm" />} className={className}>{content}</MessageScroller.Button>;
}

/** A file the turn touched: opens beside the conversation. An output also offers what its version changed. */
export function FileChip({ link, changes = false }: { link: FileLink; changes?: boolean }) {
  const { openTab } = useApp();
  const chip = (
    <button type="button" className={cn('inline-flex max-w-full items-center gap-1.5 border border-border bg-surface px-2 py-0.5 text-xs text-fg hover:bg-hover', changes ? 'rounded-l-md' : 'rounded-md')} title={`Open ${link.name} v${link.version} beside the conversation`} onClick={() => openTab('file', link.materialId, link.version)}>
      <FileIcon name={link.name} className="size-3.5" />
      <span className="truncate">{link.name}</span>
      <span className="text-muted">v{link.version}</span>
    </button>
  );
  if (!changes) return chip;
  return (
    <span className="inline-flex max-w-full items-stretch" data-testid="output-chip">
      {chip}
      <button type="button" aria-label={`Changes in ${link.name} v${link.version}`} title={`What v${link.version} changed`} className="inline-flex items-center rounded-r-md border border-l-0 border-border bg-surface px-1.5 text-muted hover:bg-hover hover:text-fg" onClick={() => openTab('diff', link.materialId, link.version)}>
        <Diff className="size-3.5" aria-hidden />
      </button>
    </span>
  );
}

const STEER = { sending: 'Sending to the running turn…', delivered: 'Reached the turn', 'not-delivered': 'Did not reach the turn. It waits as a message.', unknown: 'Not confirmed' } as const;
/** A peer's words are never queued: one that did not arrive is said so, and that is all. */
const PEER = { ...STEER, 'not-delivered': 'Did not reach the turn. It is not sent again.' } as const;

/** Words added to a running turn, with no more claimed than the engine confirmed. */
function SteerRow({ steer, turn, threadId }: { steer: TurnSteer; turn: Turn; threadId: string }) {
  const [problem, setProblem] = React.useState<string>();
  const [queued, setQueued] = React.useState(false);
  const key = React.useRef(clientKey());
  const queue = async () => {
    const r = await call('queue.add', { threadId, text: steer.text, attachments: [], settings: turn.user.settings!, clientKey: key.current });
    setQueued(r.ok);
    setProblem(r.ok ? undefined : r.detail);
  };
  // A peer card's message (message_card) is not the person's: shown as such, and never sent on as theirs.
  if (steer.peer) return (
    <div className="flex max-w-[85%] flex-col gap-1" data-testid="turn-peer-message">
      <p className="text-xs text-muted">From another card on this board · {PEER[steer.state]}</p>
      <p className="rounded-md border border-border px-3 py-2 text-sm whitespace-pre-wrap">{steer.text}</p>
    </div>
  );
  return (
    <div className="ml-auto flex max-w-[85%] flex-col items-end gap-1" data-testid="turn-steer">
      <p className="rounded-2xl bg-sunken px-4 py-2 text-sm whitespace-pre-wrap">{steer.text}</p>
      <p className="flex items-center gap-2 text-xs text-muted">
        {steer.state === 'delivered' ? STEER.delivered : <Badge tone={steer.state === 'sending' ? 'pending' : 'draft'}>{STEER[steer.state]}</Badge>}
        {steer.state === 'unknown' && steer.detail && <span>{steer.detail}</span>}
        {steer.state === 'unknown' && turn.user.settings && !queued && <Button variant="ghost" size="sm" onClick={() => void queue()}>Send as a message</Button>}
      </p>
      {problem && <p role="alert" className="text-xs text-danger">{problem}</p>}
    </div>
  );
}

const VERDICT = { met: { label: 'Met', tone: 'committed' }, 'not-met': { label: 'Not met', tone: 'draft' }, blocked: { label: 'Blocked', tone: 'danger' } } as const;

/** A goal check, in place of a turn: the judge's verdict and its words. An assessment, not an instruction. */
function GoalCheck({ turn }: { turn: Turn }) {
  const v = turn.judge?.verdict ? VERDICT[turn.judge.verdict] : null;
  return (
    <div className="flex flex-col" data-testid="turn">
      <div className="flex items-start gap-2 rounded-lg border border-border px-3 py-2 text-sm" data-testid="goal-check">
        <Target className="mt-0.5 size-3.5 shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="text-muted">Goal check · </span>
          {turn.status === 'running' ? <span className="text-muted"><Loader2 className="inline size-3 animate-spin" aria-hidden /> Checking the work…</span>
            : v ? <><Badge tone={v.tone}>{v.label}</Badge> {turn.judge!.detail}</> : <span className="text-muted">{turn.judge?.detail || 'No verdict.'}</span>}
        </span>
      </div>
    </div>
  );
}

function TurnView({ turn, threadId, projectId, workspace, roleLimited, openOriginalHistory }: { roleLimited?: boolean; turn: Turn; threadId: string; projectId: string; workspace?: { projectId: string; files: ProjectFile[] }; openOriginalHistory: (turnId: string) => void }) {
  // While a turn runs, its steps (the engine's commentary among them) show as they happen, as Codex,
  // Claude and Cursor show them; once it ends they fold, unless the person opened or closed them.
  const [chosen, setOpen] = React.useState<boolean | null>(null);
  const { selectThread } = useApp();
  // What this turn wrote, read or was given: a link to one of these opens the version the turn recorded.
  const touched = React.useMemo(() => [
    ...(turn.answer?.files ?? []),
    ...(turn.reads ?? []).map((r) => ({ materialId: r.id, name: r.name, version: r.version })),
    ...turn.user.attachments,
  ], [turn]);
  if (turn.judge) return <><UnknownOutcome turn={turn} threadId={threadId} /><GoalCheck turn={turn} /></>;
  const running = turn.status === 'running';
  const settings = turn.user.settings;
  const steps = turn.work.steps.length;
  const open = chosen ?? running;
  const latest = running ? turn.work.steps.at(-1)?.label : undefined;
  const branch = () => void call('threads.fork', { id: threadId, clientKey: clientKey(), turnId: turn.id }).then((r) => { if (r.ok) selectThread(r.value.id); });
  return (
    <div className="group flex min-w-0 flex-col gap-3" data-testid="turn" id={`turn-${turn.id}`}>
      <div className="ml-auto max-w-[85%] rounded-2xl bg-sunken px-4 py-2.5 text-[15px] leading-6">
        <p className="whitespace-pre-wrap">{turn.user.text}</p>
        {turn.user.attachments.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {turn.user.attachments.map((a) => (
              <FileChip key={a.materialId} link={a} />
            ))}
          </div>
        )}
      </div>
      {turn.selection && <TurnSelectionCard threadId={threadId} turnId={turn.id} files={(turn.answer?.files ?? []).map((f) => f.name)} status={turn.status} selection={turn.selection} />}
      {turn.steers?.map((steer) => <SteerRow key={steer.id} steer={steer} turn={turn} threadId={threadId} />)}
      <CompactionHistory records={turn.work.compactions} openOriginalHistory={openOriginalHistory} />
      <div>
        <button type="button" className="flex items-center gap-1.5 rounded-md py-0.5 text-ui text-muted hover:text-fg" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="work-block">
          {running ? <Loader2 className="size-3.5 animate-spin" /> : open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          {running ? 'Working…' : `Worked for ${duration(turn.work.startedAt, turn.work.endedAt)} · ${steps} ${steps === 1 ? 'step' : 'steps'}`}
          {latest && !open && <span className="max-w-[40ch] truncate text-muted" data-testid="work-latest">· {latest}</span>}
          {turn.status === 'stopped' && <Badge tone="danger">Stopped</Badge>}
        </button>
        {open && (
          <div className="mt-1.5 ml-[7px] border-l border-border pl-4 text-xs">
            <ol className="space-y-1">
              {turn.work.steps.map((s, i) => (
                <li key={i} className="break-words text-fg" data-kind={s.kind}>
                  {s.label}
                </li>
              ))}
              {steps === 0 && <li className="text-muted">No steps recorded.</li>}
            </ol>
            <RecordedEvidence turn={turn} projectId={projectId} />
            <p className="mt-2 font-mono text-caption text-muted">
              {turn.work.harness}
              {settings && ` · ${PERMISSIONS.find((p) => p.id === settings.permission)?.label} · ${EFFORTS[settings.effort - 1]} effort · ${settings.runsOn === 'this-computer' ? 'This computer' : 'Cloud'}${settings.mode === 'plan' ? ' · Plan mode' : ''}`}
            </p>
          </div>
        )}
      </div>
      <UnknownOutcome turn={turn} threadId={threadId} />
      <FileAccessHint turn={turn} />
      {turn.effects.map((e) => (
        <div key={e.key + e.outcome} className={cn('flex items-start gap-2 rounded-lg border px-3 py-2 text-sm', e.outcome === 'DONE' ? 'border-border' : 'border-draft bg-draft-bg text-draft')} data-testid={`effect-${e.outcome}`}>
          {e.outcome !== 'DONE' && <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />}
          <span>
            <Badge tone={e.outcome === 'DONE' ? 'committed' : e.outcome === 'UNKNOWN' ? 'draft' : 'danger'}>{e.outcome === 'DONE' ? 'Written' : e.outcome === 'UNKNOWN' ? 'Unknown outcome' : e.outcome}</Badge> {e.target}
            {e.detail && <span className="block text-xs">{e.detail}</span>}
          </span>
        </div>
      ))}
      {turn.answer && <>
        <div className="text-[15px] leading-6" data-testid={turn.merge ? 'turn-merge' : 'answer'}>
          <div className="reading">
            <Answer streaming={running} text={turn.answer.text} projectId={projectId} workspace={workspace} touched={touched} />
          </div>
          {turn.withheld && <p className="mt-1 text-xs text-muted" data-testid="turn-withheld">A source of this answer was withdrawn while it worked, so this answer is not carried into later turns.</p>}
          {/* While the work details are open, the recorded evidence lists these files with their version state, so they are not repeated here. */}
          {!open && turn.answer.files.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {turn.answer.files.map((f) => (
                <FileChip key={f.materialId} link={f} changes />
              ))}
            </div>
          )}
        </div>
      </>}
      {turn.memory && <TurnMemoryCard memory={turn.memory} />}
      {!running && (
        <div className="flex flex-col items-end gap-1">
          <div className="flex justify-end opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <Button variant="ghost" size="sm" className="text-muted" onClick={branch}><GitBranch /> Branch from here</Button>
            <RewindButton threadId={threadId} turnId={turn.id} />
          </div>
          {roleLimited && <ForkRoleNotice />}
        </div>
      )}
    </div>
  );
}

/** Existing version records, loaded only when the person expands a turn. No generated summary is stored. */
function RecordedEvidence({ turn, projectId }: { turn: Turn; projectId: string }) {
  const { tick } = useApp();
  const [catalog, setCatalog] = React.useState<{ tick: number; projectId: string; entries: MaterialEntry[] | null }>();
  React.useEffect(() => {
    let active = true;
    void call('material.list', { projectId, includeHidden: true }).then(
      (entries) => { if (active) setCatalog({ tick, projectId, entries }); },
      () => { if (active) setCatalog({ tick, projectId, entries: null }); },
    );
    return () => { active = false; };
  }, [tick, projectId]);
  // An event invalidates the old catalog immediately, including while its replacement is in flight.
  const checked = catalog?.tick === tick && catalog.projectId === projectId;
  const entries = checked ? catalog.entries : undefined;
  const evidence = workEvidence(turn, entries ?? undefined);
  const rows = (items: EvidenceLink[]) => items.map((item, i) => (
    <li key={`${item.file.materialId}:${item.file.version}:${i}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1" data-state={item.state}>
      {item.canOpen ? <FileChip link={item.file} changes={item.role === 'output'} /> : <span>{item.file.name} v{item.file.version}</span>}
      <span className="text-muted">{item.role === 'attached' && 'Attached; reading not recorded. '}{item.note}</span>
    </li>
  ));
  return (
    <section className="mt-3 space-y-2" aria-label="Recorded work evidence" data-testid="work-evidence">
      {!checked && <p role="status">Checking current document versions…</p>}
      {checked && entries === null && <p role="alert">Current document state could not be checked. Recorded versions are shown without a freshness claim.</p>}
      {evidence.incomplete && <p className="text-draft">The source record is incomplete; other context may have been used.</p>}
      {turn.withheld && <p className="text-draft">A source was withdrawn. This answer is withheld from later work.</p>}
      {evidence.sources.length > 0 && <div><h3 className="font-medium">Recorded sources</h3><ul>{rows(evidence.sources)}</ul></div>}
      {evidence.available.length > 0 && <details><summary className="cursor-pointer text-muted">Also available to this turn ({evidence.available.length})</summary><ul>{rows(evidence.available)}</ul></details>}
      {evidence.outputs.length > 0 && <div><h3 className="font-medium">Recorded output versions</h3><ul>{rows(evidence.outputs)}</ul></div>}
    </section>
  );
}
