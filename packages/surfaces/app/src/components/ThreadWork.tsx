// What a thread is for and who is working under it: the person's goal, an agent's proposed change
// to it, and depth-one children with what each handed back. Nothing here decides for the person:
// a proposal changes the goal only when accepted, and a child's unresolved outcome stays visible.
import type { ChildDocument, ChildView, QueuedMessage, Thread as ThreadData } from '@backbone-next/platform';
import { CircleAlert, Clock, CornerLeftUp, Loader2, Target, X } from 'lucide-react';
import * as React from 'react';
import { call, clientKey } from '../lib/api';
import { useApp, useLive } from '../lib/state';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Dialog, DialogContent } from './ui/dialog';

export type ThreadWorkAsk = 'goal' | 'worker' | 'reviewer';

const HANDOVER = { done: 'Finished', stopped: 'Stopped', refused: 'Refused', unknown: 'Unknown outcome' } as const;
const NOT_ENFORCED = { permission: 'permission', 'token-budget': 'token budget' } as const;
const ROLE = { worker: 'Worker', reviewer: 'Reviewer' } as const;
const ASK = {
  goal: { title: 'Goal', label: 'Goal', action: 'Save goal' },
  worker: { title: 'Start a worker', label: 'What should it do?', action: 'Start' },
  reviewer: { title: 'Ask for a review', label: 'What should it check?', action: 'Start' },
} as const;

export function ThreadWork({ thread, problem, setProblem, onChangeGoal, onClearGoal }: { thread: ThreadData; problem?: string; setProblem: (p?: string) => void; onChangeGoal?: () => void; onClearGoal?: () => void }) {
  const { selectThread } = useApp();
  const id = thread.summary.id;
  const goal = thread.goal;
  const proposals = goal?.proposals.filter((p) => p.state === 'open') ?? [];
  const decide = async (proposalId: string, verdict: 'accept' | 'decline') => {
    const r = await call('goals.decide', { threadId: id, proposalId, verdict, baseVersion: goal?.version ?? 0 });
    setProblem(r.ok ? undefined : r.detail);
  };
  const shown = goal?.current || proposals.length > 0 || thread.child || thread.forkedFrom || (thread.children?.length ?? 0) > 0 || problem;
  if (!shown) return null;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-1 px-4 pt-4 text-ui">
      {problem && <p role="alert" className="text-danger">{problem}</p>}
      {thread.child && <ParentLink testId="child-of" label="Part of" id={thread.child.parentThreadId} />}
      {thread.forkedFrom && <ParentLink testId="forked-from" label="Forked from" id={thread.forkedFrom.threadId} />}
      {goal?.current && (
        <section aria-label="Goal" className="flex items-start gap-2 rounded-lg border border-border bg-surface px-3 py-2" data-testid="thread-goal">
          <Target className="mt-0.5 size-3.5 shrink-0 text-muted" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block text-caption text-muted">Goal</span><span className="whitespace-pre-wrap">{goal.current.text}</span>
            {!thread.child && <GoalRunControls thread={thread} setProblem={setProblem} />}
          </span>
          {onChangeGoal && <Button variant="ghost" size="sm" onClick={onChangeGoal}>Change goal</Button>}
          {onClearGoal && <Button variant="ghost" size="sm" onClick={onClearGoal}>Clear goal</Button>}
        </section>
      )}
      {proposals.map((p) => (
        <div key={p.id} className="flex min-w-0 items-center gap-2" data-testid="goal-proposal">
          <CircleAlert className="size-3.5 shrink-0 text-draft" aria-hidden />
          <span className="min-w-0 flex-1"><span className="text-muted">Proposed goal:</span> {p.text}</span>
          <Button variant="outline" size="sm" onClick={() => void decide(p.id, 'accept')}>Accept</Button>
          <Button variant="ghost" size="sm" onClick={() => void decide(p.id, 'decline')}>Decline</Button>
        </div>
      ))}
      {thread.children?.map((c) => <ChildRow key={c.threadId} child={c} parentId={id} parentRunning={thread.summary.running} open={() => selectThread(c.threadId)} setProblem={setProblem} />)}
    </div>
  );
}

/** Run the goal until a check finds it met, within a turn budget; pause and resume; what the last check said. */
function GoalRunControls({ thread, setProblem }: { thread: ThreadData; setProblem: (p?: string) => void }) {
  const run = thread.goalRun;
  const threadId = thread.summary.id;
  const [budget, setBudget] = React.useState('5');
  const [tokenBudget, setTokenBudget] = React.useState('');
  const [rubric, setRubric] = React.useState('');
  React.useEffect(() => { setBudget('5'); setTokenBudget(''); setRubric(thread.goalRun?.rubric?.join('\n') ?? ''); }, [threadId]);
  const tokenSpent = run?.tokenBudget !== undefined && (run.tokensUsed ?? 0) >= run.tokenBudget;
  const said = (r: { ok: true } | { ok: false; detail: string }) => setProblem(r.ok ? undefined : r.detail);
  const turns = run ? `turn ${run.used} of ${run.budget}` : '';
  const line = !run ? null
    : run.status === 'running' ? (run.phase === 'children' ? `Waiting for its workers · ${turns}` : run.phase === 'judge' ? `Checking the work · ${turns}` : `Working toward it · ${turns}`)
    : run.status === 'met' ? `Met: ${run.evidence?.detail ?? ''}`
    : run.status === 'blocked' ? `Waiting for you: ${run.detail ?? ''}`
    : run.status === 'budget' ? `${tokenSpent ? 'Token budget reached' : `Out of turns (${turns})`}: ${run.detail ?? ''}`
    : run.status === 'interrupted' ? `Interrupted: ${run.detail ?? ''}`
    : `Paused: ${run.detail ?? ''}`;
  return (
    <span className="mt-1 flex flex-wrap items-center gap-2 text-xs" data-testid="goal-run">
      {line && <span className={run?.status === 'met' ? 'text-committed' : run?.status === 'running' ? 'text-muted' : 'text-draft'}>{run?.status === 'running' && <Loader2 className="mr-1 inline size-3 animate-spin" aria-hidden />}{line}</span>}
      {run?.status === 'running' && <Button variant="outline" size="sm" onClick={() => void call('goals.pause', { threadId }).then(said)}>Pause</Button>}
      {run?.tokenBudget !== undefined && <span className="text-muted" data-testid="goal-token-usage">{run.tokensUsed ?? 0} of {run.tokenBudget} tokens · checked between turns</span>}
      {run?.rubric?.map((criterion, i) => <span key={i} className="basis-full text-muted" data-testid="goal-rubric-result">{run.rubricResults?.[i]?.passed ? 'Pass' : 'Not yet passed'}: {criterion}{run.rubricResults?.[i]?.evidence && ` · ${run.rubricResults[i].evidence}`}</span>)}
      {run && run.status !== 'running' && run.status !== 'met' && !tokenSpent && <Button variant="outline" size="sm" onClick={() => void call('goals.resume', { threadId }).then(said)}>Resume</Button>}
      {(!run || run.status !== 'running') && <>
        <label className="flex items-center gap-1 text-muted">up to<input aria-label="Turn budget" type="number" min={1} max={50} value={budget} onChange={(e) => setBudget(e.target.value)} className="w-12 rounded border border-border bg-transparent px-1" />turns</label>
        <label className="flex items-center gap-1 text-muted">Token budget (optional)<input aria-label="Token budget" type="number" min={1} value={tokenBudget} onChange={(e) => setTokenBudget(e.target.value)} className="w-24 rounded border border-border bg-transparent px-1" /></label>
        <span className="text-muted">Usage is reported between turns; a turn in flight can exceed the limit.</span>
        <label className="flex basis-full flex-col gap-1 text-muted">Completion rubric (optional, one criterion per line)<textarea aria-label="Completion rubric" rows={2} value={rubric} onChange={(e) => setRubric(e.target.value)} className="w-full rounded border border-border bg-transparent px-1" /></label>
        <Button variant="outline" size="sm" onClick={() => void call('goals.run', { threadId, budget: Number(budget), ...(tokenBudget ? { tokenBudget: Number(tokenBudget) } : {}), ...(rubric.trim() ? { rubric: rubric.split('\n').map(item => item.trim()).filter(Boolean) } : {}) }).then(said)}>Run until met</Button>
      </>}
    </span>
  );
}

function ParentLink({ testId, label, id }: { testId: string; label: string; id: string }) {
  const { selectThread } = useApp();
  const parent = useLive(async () => {
    const r = await call('threads.get', { id });
    return r.ok ? r.value.summary.title : null;
  }, [id], null as string | null);
  return (
    <p className="flex items-center gap-1 text-muted" data-testid={testId}>
      {label}
      <button type="button" className="inline-flex min-w-0 items-center gap-1 rounded-md px-1 text-fg hover:bg-hover" onClick={() => selectThread(id)}>
        <CornerLeftUp className="size-3.5 shrink-0" aria-hidden /><span className="truncate">{parent ?? 'the parent chat'}</span>
      </button>
    </p>
  );
}

/** One document a worker made. The button says what will happen, because the two cases differ. */
function DocumentRow({ doc, child, parentId, parentRunning, setProblem }: { doc: ChildDocument; child: ChildView; parentId: string; parentRunning: boolean; setProblem: (p?: string) => void }) {
  const [busy, setBusy] = React.useState(false);
  const key = React.useRef(clientKey());
  React.useEffect(() => { key.current = clientKey(); }, [doc.current, doc.state]);
  const bring = async () => {
    setBusy(true);
    try {
      const r = await call('children.merge', { parentThreadId: parentId, childThreadId: child.threadId, materialId: doc.materialId, version: doc.version, baseVersion: doc.current, clientKey: key.current });
      setProblem(r.ok ? undefined : r.detail);
    } catch { setProblem('That could not be confirmed. Check the chat before trying again.'); }
    finally { setBusy(false); }
  };
  const canTake = doc.state === 'ready' || doc.state === 'stale';
  return (
    <div className="ml-[22px] flex min-w-0 flex-wrap items-center gap-2 text-xs" data-testid="child-document">
      <span className="min-w-0 truncate">{doc.name} <span className="text-muted">v{doc.version}</span></span>
      {doc.state === 'merged' && <span className="text-muted">Brought back</span>}
      {canTake && <Button variant="outline" size="sm" disabled={busy || parentRunning} title={parentRunning ? 'Wait for the turn here to finish.' : undefined} onClick={() => void bring()}>{doc.state === 'stale' ? 'Keep beside yours' : 'Bring back'}</Button>}
      {doc.detail && <span className={doc.state === 'blocked' ? 'basis-full text-draft' : 'basis-full text-muted'}>{doc.detail}</span>}
    </div>
  );
}

function ChildRow({ child, parentId, parentRunning, open, setProblem }: { child: ChildView; parentId: string; parentRunning: boolean; open: () => void; setProblem: (p?: string) => void }) {
  const h = child.handover;
  const unknown = child.unknown > 0 || h?.status === 'unknown';
  return (
    <div className="min-w-0" data-testid="child-row">
      <button type="button" className="flex w-full min-w-0 items-center gap-2 rounded-md py-0.5 text-left hover:bg-hover" onClick={open}>
        {child.running ? <Loader2 className="size-3.5 shrink-0 animate-spin text-muted" aria-hidden /> : <span className="size-3.5 shrink-0" />}
        <span className="min-w-0 flex-1 truncate">{child.title}</span>
        <span className="shrink-0 text-xs text-muted">{ROLE[child.role]}</span>
        {child.model && <span className="max-w-[10rem] shrink-0 truncate text-xs text-muted" data-testid="child-model" title={child.model.passedOver.length ? `Fell back at start: ${child.model.passedOver.map((p) => p.detail).join(' ')}` : undefined}>{child.model.ran}{child.model.passedOver.length > 0 && ' (fallback)'}</span>}
        {unknown ? <Badge tone="danger">Unknown outcome</Badge> : h && h.status !== 'done' ? <Badge tone="danger">{HANDOVER[h.status]}</Badge> : h && <span className="shrink-0 text-xs text-muted">{HANDOVER.done}</span>}
      </button>
      {h?.withheld ? <p className="ml-[22px] text-xs text-muted">Its report is withheld because a source was withdrawn.</p> : h?.text && <p className="ml-[22px] line-clamp-2 text-xs text-muted">{h.text}</p>}
      {child.documents?.map((doc) => <DocumentRow key={doc.materialId} doc={doc} child={child} parentId={parentId} parentRunning={parentRunning} setProblem={setProblem} />)}
      {(child.notEnforced?.length ?? 0) > 0 && <p className="ml-[22px] text-xs text-muted" data-testid="child-not-enforced" title={child.notEnforced!.map((n) => n.detail).join(' ')}>Not enforced: {child.notEnforced!.map((n) => NOT_ENFORCED[n.axis]).join(', ')}</p>}
    </div>
  );
}

function QueuedRow({ message, threadId }: { message: QueuedMessage; threadId: string }) {
  const [editing, setEditing] = React.useState<string>();
  const [problem, setProblem] = React.useState<string>();
  const save = async () => {
    const r = await call('queue.edit', { threadId, id: message.id, text: editing ?? '', baseVersion: message.version });
    if (r.ok) setEditing(undefined);
    // A refused edit stays in the box: those words are the person's, and they can copy them.
    setProblem(r.ok ? undefined : r.detail);
  };
  const remove = async () => {
    const r = await call('queue.remove', { threadId, id: message.id, baseVersion: message.version });
    setProblem(r.ok ? undefined : r.detail);
  };
  return (
    <li className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm" data-testid="queued-message">
      {editing === undefined ? (
        <div className="flex min-w-0 items-center gap-2">
          <Clock className="size-3.5 shrink-0 text-muted" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{message.text}</span>
          {message.attachments.length > 0 && <span className="shrink-0 text-xs text-muted">{message.attachments.length} {message.attachments.length === 1 ? 'file' : 'files'}</span>}
          <Button variant="ghost" size="sm" onClick={() => setEditing(message.text)}>Edit</Button>
          <Button variant="ghost" size="icon-sm" aria-label="Remove" onClick={() => void remove()}><X /></Button>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <textarea aria-label="Queued message" rows={2} autoFocus value={editing} onChange={(e) => setEditing(e.target.value)} className="w-full resize-none rounded-md border border-border bg-transparent px-2 py-1 text-sm" />
          <div className="flex justify-end gap-1">
            <Button variant="ghost" size="sm" onClick={() => { setEditing(undefined); setProblem(undefined); }}>Cancel</Button>
            <Button size="sm" disabled={!editing.trim()} onClick={() => void save()}>Save</Button>
          </div>
        </div>
      )}
      {message.fromSteer && <p className="text-xs text-muted">This did not reach the turn, so it waits as a message.</p>}
      {problem && <p role="alert" className="text-xs text-danger">{problem}</p>}
    </li>
  );
}

/** Messages waiting for the turn, oldest first, and what they wait for if it is the person. */
export function QueuedMessages({ thread }: { thread: ThreadData }) {
  const [problem, setProblem] = React.useState<string>();
  if (!thread.queue?.length) return null;
  const threadId = thread.summary.id;
  const head = thread.queue[0];
  const sendNow = async () => {
    const r = await call('queue.send', { threadId, id: head.id, baseVersion: head.version });
    setProblem(r.ok ? undefined : r.detail);
  };
  return (
    <div className="flex flex-col gap-1 pb-2">
      <ul className="flex flex-col gap-1" aria-label="Waiting to send">
        {thread.queue.map((m) => <QueuedRow key={m.id} message={m} threadId={threadId} />)}
      </ul>
      {thread.queueHeld && (
        <div className="flex items-center gap-2 px-1 text-xs text-muted" data-testid="queue-held">
          <span className="min-w-0 flex-1">{thread.queueHeld}</span>
          <Button variant="outline" size="sm" disabled={thread.summary.running} onClick={() => void sendNow()}>Send now</Button>
        </div>
      )}
      {problem && <p role="alert" className="px-1 text-xs text-danger">{problem}</p>}
    </div>
  );
}

export function ThreadWorkDialog({ thread, ask, onClose }: { thread: ThreadData; ask?: ThreadWorkAsk; onClose: () => void }) {
  const [text, setText] = React.useState('');
  const [problem, setProblem] = React.useState<string>();
  const [busy, setBusy] = React.useState(false);
  const clientKey = React.useRef(crypto.randomUUID());
  React.useEffect(() => {
    setText(ask === 'goal' ? thread.goal?.current?.text ?? '' : '');
    setProblem(undefined);
    clientKey.current = crypto.randomUUID();
  }, [ask]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!ask) return null;
  const words = ASK[ask];
  // Said here, before anything is typed, rather than as a refusal afterwards.
  const unavailable = ask === 'reviewer' ? thread.reviewer?.detail : undefined;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const threadId = thread.summary.id;
      const r = ask === 'goal'
        ? await call('goals.set', { threadId, text, baseVersion: thread.goal?.version ?? 0 })
        : await call('children.start', { parentThreadId: threadId, text, role: ask, clientKey: clientKey.current, reviews: ask === 'reviewer' ? threadId : undefined });
      if (r.ok) onClose();
      else setProblem(r.detail);
    } catch {
      setProblem('That could not be confirmed. Check the chat before trying again.');
    } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent title={words.title}>
        {unavailable ? <p className="text-sm text-muted" data-testid="reviewer-unavailable">{unavailable}</p> : <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
          <textarea aria-label={words.label} placeholder={words.label} rows={3} autoFocus value={text} onChange={(e) => setText(e.target.value)} className="w-full resize-none rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm" />
          {problem && <p role="alert" className="text-sm text-danger">{problem}</p>}
          <div className="flex justify-end"><Button type="submit" disabled={busy || !text.trim()}>{words.action}</Button></div>
        </form>}
      </DialogContent>
    </Dialog>
  );
}
