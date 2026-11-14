import type { TurnAdmissionOptions } from './turn-admission.ts';
import { unknownChecked } from './unknown-checks.ts';
// Goals that run until they are met. The goal text is the completion criterion. After each turn of
// work on the chat, once its children are done, a judge turn on the same route checks the work
// against the goal and answers on its first line: MET with the evidence, NOT MET with what is
// missing, or BLOCKED with the decision the person must make. Not met starts the next turn of work,
// told what is missing, until the person's turn budget is spent; blocked waits for them; met closes
// the run with its evidence. A person's Stop pauses the run, and an UNKNOWN write blocks it. A turn
// a kill cut short is carried on by the host once work resumes; if it did not finish, the run is
// interrupted (never "stopped by you") until the person resumes it. Opening a home starts no turn
// of a run: it goes on once the host resumes work, as the board's workers do.
//
// Every turn here goes through the host's one admission under the home lock, keyed by the run, so
// a retry finds the turn it made. The judge's words are an assessment: its turn is read-only where
// the engine can be held to that, it widens nothing, accepts nothing held, and is never remembered.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ApiEvent, Args, GoalRun, Id, Receipt, RefusalReason, Result, Turn, TurnSelection, TurnSettings } from '../api.ts';
import { asShown } from '../selection/pin.ts';
import { readJson, writeJson } from '../stub/fsx.ts';
import type { MaterialStore } from '../stub/material.ts';
import { checkGoalRubric, rubricText } from './goal-rubric.ts';
import { assertHomeWriteAdmission } from './home-lock.ts';
import type { StoredThread } from './thread-journal.ts';
import { carryTextSources, taintedReads, unbound } from './withdrawal.ts';

export const MAX_BUDGET = 50;
const VERDICT = /^\s*(MET|NOT MET|BLOCKED)\b\s*:?\s*(.*)$/i;
/** How a goal run's turns go on a chat none of whose turns says. */
export const GOAL_DEFAULT_SETTINGS: TurnSettings = { permission: 'full', model: 'stub', effort: 3, runsOn: 'this-computer', mode: 'chat' };

export interface GoalRunDeps {
  home: string;
  threads: Map<string, StoredThread>;
  /** Where the sources behind the words a run writes are judged against withdrawal. */
  material: Pick<MaterialStore, 'load'>;
  closing(): boolean;
  /** Settles once the host holds its home and its core is up; nothing is admitted before (proactivity.ts says why). */
  ready?: Promise<unknown>;
  /** The host's one admission of a turn; called inside the home lock. `launch` starts it, outside. */
  admit(args: Args<'turns.send'>, how?: TurnAdmissionOptions): Promise<{ result: Result<'turns.send'>; launch?: () => void }>;
  /** The chat's chosen task as a turn with these settings would continue it now (selection/pin.ts), or why it cannot. */
  selectionFor?(thread: StoredThread, settings: TurnSettings): { selection?: TurnSelection } | { refused: string };
  childrenRunning(thread: StoredThread): boolean;
  emit(e: ApiEvent): void;
}

const refused = <T>(reason: RefusalReason, detail: string): Receipt<T> => ({ ok: false, reason, detail, outcome: 'REFUSED' });
const now = () => new Date().toISOString();

/** The judge's verdict from its answer's first words; a check that says none of them is blocked. */
export function verdictOf(answer: string): { verdict: 'met' | 'not-met' | 'blocked'; detail: string } {
  const first = answer.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const m = VERDICT.exec(first);
  if (!m) return { verdict: 'blocked', detail: 'The goal check gave no verdict. Look at it and decide.' };
  const kind = m[1].toUpperCase();
  return { verdict: kind === 'MET' ? 'met' : kind === 'BLOCKED' ? 'blocked' : 'not-met', detail: m[2].trim() };
}

export const workText = (goal: string, missing?: string) =>
  missing ? `Continue toward the goal: ${goal}\n\nStill missing, as the last check found: ${missing}` : `Work toward the goal: ${goal}`;
export const judgeText = (goal: string) =>
  `Goal check. Judge the work in this chat against the goal, which is its completion criterion: ${goal}\n\n`
  + 'Do not change any file. Answer with one first line, exactly one of:\nMET: <the evidence>\nNOT MET: <what is missing>\nBLOCKED: <the decision the person must make>';

/** Turns the run itself starts: their words are the host's, not the person's. */
export const isRunTurnKey = (key: string | undefined) => !!key && (key.startsWith('goal-run:') || key.startsWith('goal-check:'));

export function createGoalRuns(deps: GoalRunDeps) {
  const path = join(deps.home, 'goal-runs.json');
  const runs: Record<Id, GoalRun> = readJson<Record<Id, GoalRun>>(path, {});
  const save = (id: Id) => { if (runs[id].tokenBudget !== undefined) runs[id].tokensUsed = usage(runs[id]); runs[id].updatedAt = now(); assertHomeWriteAdmission(deps.home); writeJson(path, runs); deps.emit({ topic: 'goals', id }); deps.emit({ topic: 'threads', id }); };
  const settingsOf = (t: StoredThread): TurnSettings => t.turns.findLast((x) => x.user.settings)?.user.settings ?? GOAL_DEFAULT_SETTINGS;
  const keyOf = (run: GoalRun, kind: 'run' | 'check', n: number) => `goal-${kind}:${run.threadId}:${run.startedAt}:${n}`;
  const stepping = new Set<Id>();
  const familyTurns = (id: Id) => [...deps.threads.values()].filter(t => t.summary.id === id || t.child?.parentThreadId === id).flatMap(t => t.turns);
  const tokens = (turn: Turn) => (turn.work.usage?.input ?? 0) + (turn.work.usage?.output ?? 0);
  const measuredTurns = (run: GoalRun) => [...deps.threads.values()].flatMap(thread => thread.summary.id === run.threadId
    ? thread.turns.filter((turn, i) => turn.id === run.initialTurnId || thread.clientKeys[i]?.startsWith(`goal-run:${run.threadId}:${run.startedAt}:`) || thread.clientKeys[i]?.startsWith(`goal-check:${run.threadId}:${run.startedAt}:`))
    : thread.child?.parentThreadId === run.threadId ? thread.turns : []);
  const usage = (run: GoalRun) => measuredTurns(run).reduce((sum, turn) => sum + Math.max(0, tokens(turn) - (run.usageBefore?.[turn.id] ?? 0)), 0);
  function atTokenLimit(run: GoalRun) {
    if (run.tokenBudget === undefined) return false;
    run.tokensUsed = usage(run);
    if (run.tokensUsed < run.tokenBudget) return false;
    Object.assign(run, { status: 'budget', detail: `Token budget reached: ${run.tokensUsed} of ${run.tokenBudget} tokens reported. No further turn was started.` });
    save(run.threadId);
    return true;
  }
  function stalled(run: GoalRun, thread: StoredThread, check: Turn) {
    if (run.progressCheck?.turnId === check.id) return run.progressCheck.repeats >= 3;
    const work = thread.turns.findLast(t => !t.side && !t.judge);
    const normalize = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();
    const childWork = [...deps.threads.values()].filter(t => t.child?.parentThreadId === run.threadId).flatMap(t => t.turns.filter(turn => !turn.judge));
    const changedDocument = work?.effects.some(e => e.outcome === 'DONE');
    const fingerprint = createHash('sha256').update(JSON.stringify([normalize(work?.answer?.text ?? ''), normalize(check.judge?.detail ?? ''), childWork.map(t => [t.id, normalize(t.answer?.text ?? '')])])).digest('hex');
    const repeats = !changedDocument && run.progressCheck?.fingerprint === fingerprint ? run.progressCheck.repeats + 1 : 1;
    run.progressCheck = { turnId: check.id, fingerprint, repeats };
    return repeats >= 3;
  }

  const dead = (reads: NonNullable<Turn['reads']>) => taintedReads({ reads }, (id) => deps.material.load(id)).length > 0;

  /**
   * The words a run writes into its next turn come from the goal and the last check's finding, each
   * with its sources. A goal whose source was withdrawn stops the run; a finding whose sources were
   * withdrawn, or are not all known, is left out. Decided inside the admission, under the home lock.
   */
  async function admit(run: GoalRun, thread: StoredThread, kind: 'work' | 'judge', from?: Turn) {
    const current = thread.goal?.current;
    if (!current?.text) { Object.assign(run, { status: 'paused', detail: 'The goal was cleared.' }); return save(run.threadId); }
    // A run allowed for one goal never works toward another.
    if (run.goal !== undefined && current.text !== run.goal) { Object.assign(run, { status: 'paused', detail: 'The goal changed since this run was allowed, so it is paused. Run it again to work toward the goal as it is now.' }); return save(run.threadId); }
    const n = kind === 'work' ? run.used + 1 : run.used;
    await deps.ready;
    let withdrawnGoal = false;
    const admitted = await (async () => {
      const goalReads = current.reads ?? [];
      if (dead(goalReads)) { withdrawnGoal = true; return null; }
      const finding = from?.judge?.detail && !unbound(from) && !dead(from.reads ?? []) ? from : undefined;
      const sources = [...goalReads, ...(finding?.reads ?? [])];
      return deps.admit(
        { threadId: thread.summary.id, projectId: thread.summary.projectId, text: (kind === 'work' ? workText(current.text, finding?.judge?.detail) : judgeText(current.text)) + rubricText(run.rubric) + (kind === 'judge' && run.rubric?.length ? '\nFor each rubric item, add one line PASS N: <specific evidence>, FAIL N: <what is missing>, or BLOCKED N: <decision needed>. MET requires PASS with evidence for every item.' : ''), attachments: [], settings: run.settings ?? settingsOf(thread), clientKey: keyOf(run, kind === 'work' ? 'run' : 'check', n) },
        // Work and judge alike run on the choice the run recorded when it was allowed, never one made in the chat since.
        { validate:()=>{if(dead(goalReads)){withdrawnGoal=true;return 'A source this goal came from was withdrawn.';}if(finding&&(unbound(finding)||dead(finding.reads??[])))return 'The prior finding changed during preparation.';if(thread.goal?.current!==current||run.status!=='running')return 'The goal changed or was paused during preparation.';}, selection: run.selection ? { ...structuredClone(run.selection), origin: 'goal-run' } : null, prepare: (turn) => { if (kind === 'judge') turn.judge = { verdict: null, detail: '' }; carryTextSources(turn, sources); } },
      );
    })();
    if (!admitted || withdrawnGoal) { Object.assign(run, { status: 'paused', detail: withdrawnGoal ? 'A source this goal came from was withdrawn, so the run cannot go on. Set the goal again to go on.' : 'Nothing was started.' }); return save(run.threadId); }
    if (!admitted.result.ok) { Object.assign(run, { status: 'blocked', detail: admitted.result.detail }); return save(run.threadId); }
    run.phase = kind;
    if (kind === 'work') run.used = n;
    delete run.detail;
    save(run.threadId);
    admitted.launch?.();
  }

  /** What the run does next, from where the chat stands. Waits for a running turn and for children. */
  async function step(id: Id) {
    const run = runs[id];
    const thread = deps.threads.get(id);
    if (!run || !thread || run.status !== 'running' || deps.closing() || stepping.has(id)) return;
    if (thread.summary.running) return;
    stepping.add(id);
    try {
      if (deps.childrenRunning(thread)) { if (run.phase !== 'children') { run.phase = 'children'; save(id); } return; }
      // No work/check in this run can claim completion from the chat's earlier judge.
      if (run.used === 0 && atTokenLimit(run)) return;
      const last = thread.turns.findLast((t) => !t.side);
      if (run.tokenBudget !== undefined && measuredTurns(run).some(turn => turn.status !== 'running' && !turn.work.usage && !(turn.id in (run.usageBefore ?? {})))) {
        Object.assign(run, { status: 'blocked', detail: 'The engine did not report token usage. The remaining token allowance cannot be verified, so no further turn was started.' });
        return save(id);
      }
      const resumedPast = !!last && last.id === run.past;
      if (last?.unknownOutcome && !unknownChecked(last)) { Object.assign(run, { status: 'blocked', detail: 'An outside action has an unknown outcome. Reconcile it in the source system before the goal goes on.' }); return save(id); }
      if (last?.interrupted && last.status !== 'done' && !resumedPast) {
        const unknown = last.effects.some((e) => e.outcome === 'UNKNOWN');
        Object.assign(run, { status: 'interrupted', detail: `The app stopped during this goal's ${last.judge ? 'check' : 'turn of work'}. ${unknown ? 'A write\'s outcome is UNKNOWN; it was not resent.' : 'Nothing of it was resent.'} Resume to go on.` });
        return save(id);
      }
      // A check the person resumed past is asked again.
      if (last?.judge && !(last.judge.verdict === null && resumedPast)) {
        const { verdict, detail } = last.judge;
        if (verdict === 'met') { Object.assign(run, { status: 'met', evidence: { turnId: last.id, detail } }); return save(id); }
        if (verdict === 'blocked' || verdict === null) { Object.assign(run, { status: 'blocked', detail: detail || 'The goal check did not finish.' }); return save(id); }
        if (atTokenLimit(run)) return;
        if (stalled(run, thread, last)) { Object.assign(run, { status: 'blocked', detail: 'No progress across three checks: the work and missing finding are unchanged. Revise the approach or Resume to try again.' }); return save(id); }
        if (run.used >= run.budget) { Object.assign(run, { status: 'budget', detail }); return save(id); }
        return await admit(run, thread, 'work', last);
      }
      if ((last?.stopRequested || last?.status === 'stopped') && !resumedPast) { Object.assign(run, { status: 'paused', detail: last?.stopRequested ? 'Stopped by you. Resume to go on.' : `${last?.answer?.text?.trim() || 'Its turn stopped before it finished.'} Resume to go on.` }); return save(id); }
      if (last?.effects.some((e) => e.outcome === 'UNKNOWN')) { Object.assign(run, { status: 'blocked', detail: 'A write\'s outcome is unknown. Resolve it before the goal goes on.' }); return save(id); }
      if (last && last.status !== 'done' && !resumedPast) { Object.assign(run, { status: 'blocked', detail: 'The last turn did not finish.' }); return save(id); }
      if (atTokenLimit(run)) return;
      await admit(run, thread, 'judge');
    } finally {
      stepping.delete(id);
    }
  }

  const later = (id: Id) => setTimeout(() => void step(id).catch(() => {}), 0);

  /** Before the turn is saved: a judge turn's verdict, from its answer. */
  function judged(turn: Turn) {
    if (!turn.judge) return;
    turn.judge = turn.status === 'done' ? verdictOf(turn.answer?.text ?? '') : { verdict: null, detail: 'The goal check did not finish.' };
    const run = Object.values(runs).find(run => deps.threads.get(run.threadId)?.turns.some(t => t.id === turn.id));
    if (run?.rubric?.length && turn.status === 'done') {
      run.rubricResults = checkGoalRubric(turn.answer?.text ?? '', run.rubric);
      const missing = run.rubricResults.filter(result => !result.passed);
      if (turn.judge.verdict === 'met' && missing.length) turn.judge = { verdict: 'not-met', detail: `Rubric evidence is missing or failing: ${missing.map(result => result.criterion).join('; ')}` };
    }
  }

  /** After a turn ends: its chat's run, and a parent's run waiting on its children, go on. */
  function ended(thread: StoredThread) {
    if (runs[thread.summary.id]) later(thread.summary.id);
    const parent = thread.child?.parentThreadId;
    if (parent && runs[parent]) later(parent);
  }

  /** Once the host resumes work: each run that was going when the last process ended goes on. */
  function resume() {
    for (const id of Object.keys(runs)) if (runs[id].status === 'running') later(id);
  }

  const view = (id: Id) => (runs[id] ? structuredClone({ ...runs[id], ...(runs[id].tokenBudget !== undefined && ['running', 'paused'].includes(runs[id].status) ? { tokensUsed: usage(runs[id]) } : {}) }) : undefined);

  type Names = 'goals.run' | 'goals.pause' | 'goals.resume' | 'goals.runs';
  const handlers: { [M in Names]: (a: Args<M>) => Promise<Result<M>> | Result<M> } = {
    'goals.run': async ({ threadId, budget, tokenBudget, rubric, settings, goal, continues }) => {
      const thread = deps.threads.get(threadId);
      if (!thread) return refused('NOT_FOUND', `No thread ${threadId}.`);
      if (thread.child) return refused('NOT_AVAILABLE', 'A child works for its parent\'s goal; run the goal on the parent.');
      if (!thread.goal?.current) return refused('INVALID', 'Set a goal first; it is what the check judges the work against.');
      if (!Number.isInteger(budget) || budget < 1 || budget > MAX_BUDGET) return refused('INVALID', `A budget is 1 to ${MAX_BUDGET} turns.`);
      if (tokenBudget !== undefined && (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1)) return refused('INVALID', 'A token budget must be a positive safe integer.');
      if (rubric !== undefined && (!Array.isArray(rubric) || rubric.length > 20 || rubric.some(item => typeof item !== 'string' || !item.trim() || item.length > 1000 || /[\r\n]/.test(item)))) return refused('INVALID', 'A rubric has at most 20 nonempty single-line criteria, each at most 1000 characters.');
      if (runs[threadId]?.status === 'running') return refused('NOT_AVAILABLE', 'Pause the current goal run before replacing it.');
      if (goal !== undefined && thread.goal.current.text !== goal) return refused('NOT_AVAILABLE', 'The chat\'s goal changed since you were shown it, so the run was not started. Ask again.');
      // A goal started from a selected task records that choice for all its turns, with a model its settings name kept.
      // The settings and model it starts with are pinned too, so a later turn's in the chat cannot move them.
      const started = settings ?? settingsOf(thread);
      const chosen = deps.selectionFor?.(thread, started) ?? {};
      if ('refused' in chosen) return refused('NOT_AVAILABLE', chosen.refused);
      if (!asShown(chosen.selection, continues)) return refused('NOT_AVAILABLE', 'The route this chat\'s task runs on changed since you were shown it, so the run was not started. Ask again.');
      // A turn already running is the run's first turn of work.
      runs[threadId] = { threadId, status: 'running', budget, used: thread.summary.running ? 1 : 0, phase: 'work', settings: started, ...(goal !== undefined ? { goal } : {}), ...(chosen.selection ? { selection: chosen.selection } : {}), startedAt: now(), updatedAt: now() };
      if (tokenBudget !== undefined) Object.assign(runs[threadId], { tokenBudget, tokensUsed: 0, usageBefore: Object.fromEntries(familyTurns(threadId).filter(turn => turn.status !== 'running').map(turn => [turn.id, tokens(turn)])) });
      if (thread.summary.running) runs[threadId].initialTurnId = thread.turns.findLast(turn => turn.status === 'running')?.id;
      if (rubric?.length) runs[threadId].rubric = rubric.map(item => item.trim());
      save(threadId);
      // An idle chat starts with a turn of work toward the goal; a running one is checked when it ends.
      if (thread.summary.running || (tokenBudget !== undefined && usage(runs[threadId]) >= tokenBudget)) await step(threadId);
      else await admit(runs[threadId], thread, 'work');
      return { ok: true, value: view(threadId)! };
    },
    'goals.pause': ({ threadId }) => {
      const run = runs[threadId];
      if (!run || run.status !== 'running') return refused('NOT_AVAILABLE', 'No goal is running in that chat.');
      Object.assign(run, { status: 'paused', detail: 'Paused by you. The turn in hand finishes; nothing new starts.' });
      save(threadId);
      return { ok: true, value: view(threadId)! };
    },
    'goals.resume': async ({ threadId }) => {
      const run = runs[threadId];
      if (!run || (run.status !== 'paused' && run.status !== 'blocked' && run.status !== 'budget' && run.status !== 'interrupted')) return refused('NOT_AVAILABLE', 'No goal is paused or waiting in that chat.');
      if (run.tokenBudget !== undefined && usage(run) >= run.tokenBudget) return refused('NOT_AVAILABLE', 'The token budget is spent. Start a new run with an explicit budget to continue.');
      delete run.progressCheck;
      if (run.status === 'budget') run.budget = Math.min(MAX_BUDGET, run.used + Math.max(1, run.budget - (run.used - 1)));
      Object.assign(run, { status: 'running' });
      delete run.detail;
      const last = deps.threads.get(threadId)?.turns.findLast((t) => !t.side);
      // Past a turn that has ended only: a Stop of the turn still in hand pauses the run again.
      if (last && last.status !== 'running') run.past = last.id;
      save(threadId);
      await step(threadId);
      return { ok: true, value: view(threadId)! };
    },
    'goals.runs': () => Object.keys(runs).map(id => view(id)!),
  };

  return { handlers, judged, ended, resume, view, isRunTurnKey };
}
