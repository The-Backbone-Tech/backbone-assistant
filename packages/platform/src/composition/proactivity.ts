import type { TurnAdmissionOptions } from './turn-admission.ts';
// Proactivity: work the host starts on its own while the app is open. A schedule runs a chat's words,
// or works toward its goal, when its rule says; the one heartbeat runs a standing check inside active
// hours and stays quiet unless something needs the person. What needs them waits for one daily brief;
// only a security or money emergency is told at once, and each is counted.
//
// Every run is a turn admitted through the host's one admission, under the home lock, with a client
// key that follows from the run. So held writes, UNKNOWN and withdrawal hold for it unchanged, and a
// run recorded but not yet admitted when the app stopped is admitted again under the same key: it
// finds the turn it made, if it made one, and never starts a second.
import { join } from 'node:path';
import type { ApiEvent, Args, DailyBrief, DailyBriefItem, Hours, Id, Interruptions, Proactivity, Receipt, RefusalReason, Result, RunOutcome, Schedule, ScheduleRun, Turn } from '../api.ts';
import { readJson, sha256, writeJson } from '../stub/fsx.ts';
import { describeRule, nextAfter, parseWhen, withinHours, type Rule } from '../schedules/rules.ts';
import type { MaterialStore } from '../stub/material.ts';
import { assertHomeWriteAdmission } from './home-lock.ts';
import { createWakeGateRunner, gateProblem } from '../schedules/wake-gate.ts';
import type { StoredThread } from './thread-journal.ts';
import { carryTextSources, taintedReads } from './withdrawal.ts';

const MAX_RUNS = 200;
const MAX_TEXT = 4_000;
const DEFAULT_BRIEF = '08:00';
const HEARTBEAT_OK = 'HEARTBEAT_OK';
const URGENT = /URGENT-(SECURITY|MONEY):?\s*(.*)/s;
/** Missed times are counted up to this many; one run stands for all of them. */
const MAX_COUNTED = 1_000;

export interface ProactivityDeps {
  home: string;
  threads: Map<string, StoredThread>;
  now(): number;
  tickMs: number;
  /** Nothing starts on its own in a read-only home. */
  readOnly: boolean;
  /**
   * Settles once the host holds its home and its core is up. Core preparation starts before the short local reservation lock, so no tick starts before this.
   */
  ready?: Promise<unknown>;
  closing(): boolean;
  projectExists(id: Id): boolean;
  /** The host's one admission of a turn; owns its local reservation lock. `launch` starts it afterwards; `prepare` sees the new turn first. */
  admit(args: Args<'turns.send'>, how?: TurnAdmissionOptions): Promise<{ result: Result<'turns.send'>; launch?: () => void }>;
  /** Where the sources of a goal a schedule works toward are judged against withdrawal. */
  material: Pick<MaterialStore, 'load'>;
  emit(e: ApiEvent): void;
  /** Housekeeping that runs once a day on this clock (the skills curator); it reports through `note`. */
  daily?(): Promise<void>;
}

interface Stored {
  schedules: Schedule[];
  runs: ScheduleRun[];
  brief: { time: string; latest: DailyBrief | null; pending: DailyBriefItem[]; finished: number };
  interruptions: Interruptions;
  /** A create's client key, to the schedule it made. */
  keys: Record<string, Id>;
}

const refused = <T>(reason: RefusalReason, detail: string): Receipt<T> => ({ ok: false, reason, detail, outcome: 'REFUSED' });
const keyed = (seed: string) => sha256(seed).replace(/^(.{8})(.{4}).(.{3}).(.{3})(.{12}).*$/, '$1-$2-4$3-8$4-$5');
const iso = (t: number) => new Date(t).toISOString();
const pad = (n: number) => String(n).padStart(2, '0');
const localDate = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const localClock = (t: number) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const isClock = (s: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const firstLines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join(' ').slice(0, 300);
const open = (r: ScheduleRun) => r.outcome === 'starting' || r.outcome === 'running';

/** A heartbeat keeps to the clock from the start of its hours; a schedule counts from when it was made. */
function anchorOf(s: Schedule): number {
  const made = Date.parse(s.anchor ?? s.createdAt);
  if (s.kind !== 'heartbeat' || !s.hours) return made;
  const d = new Date(made);
  const [h, m] = s.hours.start.split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}
const nextOf = (s: Schedule, after: number) => { const t = nextAfter(s.rule, after, anchorOf(s), s.hours); return t === null ? null : iso(t); };

/**
 * The one way a proactive run becomes a turn: admitted under its client key inside the home lock,
 * recorded (`record`) before it starts, then started outside the lock. A key admitted before a
 * restart finds the turn it made, which may have ended already (`ended`). Triggers use it too.
 */
export async function admitProactive(deps: Pick<ProactivityDeps, 'home' | 'threads' | 'admit' | 'ready'> & Partial<Pick<ProactivityDeps,'material'>>, args: Args<'turns.send'>, record: (threadId: Id, turnId: Id) => void, sources: NonNullable<Turn['textSources']> = [], prepare?: (turn: Turn) => void): Promise<{ problem: string } | { ended: { thread: StoredThread; turn: Turn } | null }> {
  await deps.ready;
  const admitted = await deps.admit(args, sources.length || prepare ? { validate:()=>taintedReads({reads:sources},id=>deps.material?.load(id)??null).length?'A source changed during preparation.':undefined, prepare: (turn) => { if (sources.length) carryTextSources(turn, sources); prepare?.(turn); } } : {});
  if (!admitted.result.ok) return { problem: admitted.result.detail };
  const { threadId, turnId } = admitted.result.value;
  record(threadId, turnId);
  admitted.launch?.();
  const thread = deps.threads.get(threadId);
  const turn = thread?.turns.find((t) => t.id === turnId);
  return { ended: !admitted.launch && thread && turn && turn.status !== 'running' ? { thread, turn } : null };
}

/**
 * What a run's turn that a kill cut short, and that did not finish once the host carried it on, says
 * for the run: the app stopped, and nothing of it was resent. Null for any other turn.
 */
export function cutShort(turn: Turn, said: string): string | null {
  if (!turn.interrupted || turn.status === 'done') return null;
  const unknown = turn.effects.some((e) => e.outcome === 'UNKNOWN');
  return `The app stopped during this run. ${unknown ? 'A write\'s outcome is UNKNOWN; it was not resent.' : 'Nothing of it was resent.'} ${said}`.trim();
}

export function createProactivity(deps: ProactivityDeps) {
  const path = join(deps.home, 'proactivity.json');
  const stored: Stored = readJson<Stored>(path, { schedules: [], runs: [], brief: { time: DEFAULT_BRIEF, latest: null, pending: [], finished: 0 }, interruptions: { date: '', briefs: 0, emergencies: [] }, keys: {} });
  // Once the host has closed, nothing is written: a late timer or turn end would otherwise recreate a home
  // already removed, or write beside whichever process holds it next.
  let closed = false;
  const gates = new AbortController();
  const gateRunner = createWakeGateRunner();
  const save = () => { if (!closed) { assertHomeWriteAdmission(deps.home); writeJson(path, stored); } };
  const changed = () => { save(); deps.emit({ topic: 'schedules' }); };
  const today = () => {
    const date = localDate(deps.now());
    if (stored.interruptions.date !== date) stored.interruptions = { date, briefs: 0, emergencies: [] };
    return stored.interruptions;
  };
  const find = (id: Id) => stored.schedules.find((s) => s.id === id);
  const heartbeat = () => stored.schedules.find((s) => s.kind === 'heartbeat') ?? null;

  /** A goal's schedule pinned to the goal it was allowed for pauses, and says so, once that goal changed. */
  const GOAL_CHANGED = 'The chat\'s goal changed since this schedule was allowed, so it is paused. Resume it to work toward the goal as it is now.';
  function goalMoved(s: Schedule): boolean {
    if (s.goal === undefined || s.text.trim() || s.kind === 'heartbeat') return false;
    const now = s.threadId ? deps.threads.get(s.threadId)?.goal?.current?.text : undefined;
    if (now === s.goal) return false;
    Object.assign(s, { paused: true, pausedBecause: GOAL_CHANGED });
    s.version++;
    changed();
    return true;
  }

  /** What a schedule's turn says, and the sources of the goal it copies in, if it does. */
  function textFor(s: Schedule): { text: string; sources: NonNullable<Turn['textSources']> } | { problem: string } {
    if (goalMoved(s)) return { problem: GOAL_CHANGED };
    const said = wordsFor(s);
    if (typeof said !== 'string') return said;
    const goal = !s.text.trim() && s.kind !== 'heartbeat' && s.threadId ? deps.threads.get(s.threadId)?.goal?.current : undefined;
    const sources = goal?.reads ?? [];
    if (taintedReads({ reads: sources }, (id) => deps.material.load(id)).length) return { problem: 'A source this chat\'s goal came from was withdrawn, so its words are not sent. Set the goal again.' };
    return { text: said, sources };
  }

  function wordsFor(s: Schedule): string | { problem: string } {
    if (s.kind === 'heartbeat') {
      return `Heartbeat check: ${s.text}\n\nIf nothing needs the person, reply with ${HEARTBEAT_OK}. If a security or money emergency needs them now, begin with URGENT-SECURITY: or URGENT-MONEY:. Otherwise say briefly what needs them.`;
    }
    if (s.text.trim()) return s.text;
    const goal = s.threadId ? deps.threads.get(s.threadId)?.goal?.current?.text : undefined;
    return goal ? `Work toward the goal: ${goal}` : { problem: 'This chat has no goal to work toward, and the schedule has no words of its own.' };
  }

  function newRun(s: Schedule, id: Id, dueAt: string, caughtUp?: number): ScheduleRun {
    const run: ScheduleRun = {
      id, scheduleId: s.id, kind: s.kind, title: s.kind === 'heartbeat' ? 'Heartbeat' : firstLines(s.text) || 'Work toward the goal',
      dueAt, startedAt: iso(deps.now()), endedAt: null, threadId: s.threadId, turnId: null, outcome: 'starting', summary: '',
      ...(caughtUp && caughtUp > 1 ? { caughtUp } : {}),
    };
    stored.runs = [run, ...stored.runs].slice(0, MAX_RUNS);
    return run;
  }

  /** Admit a recorded run's turn under its own key, then start it outside the lock. */
  const admitting = new Map<Id, Promise<void>>();
  const gated = new Set<Id>();
  function admitRun(run: ScheduleRun): Promise<void> {
    const pending = admitting.get(run.id);
    if (pending) return pending;
    if (find(run.scheduleId)?.wakeGate) gated.add(run.id);
    const task = admitCheckedRun(run).finally(() => { admitting.delete(run.id); gated.delete(run.id); });
    admitting.set(run.id, task);
    return task;
  }
  async function admitCheckedRun(run: ScheduleRun) {
    await deps.ready;
    const s = find(run.scheduleId);
    let made = s ? textFor(s) : { problem: 'Its schedule was deleted before it ran.' };
    if (!s || 'problem' in made) return finish(run, 'skipped', 'problem' in made ? made.problem : '');
    if (closed || deps.closing() || deps.readOnly || (s.wakeGate && s.paused)) return finish(run, 'skipped', 'The schedule cannot start now.');
    if (s.wakeGate) {
      const version = s.version;
      const problem = gateProblem(deps.home, s.wakeGate, s.settings);
      if (problem) return finish(run, 'failed', problem);
      if (run.wakeGate === 'checking') {
        s.paused = true; s.version++;
        s.pausedBecause = 'The app stopped during a script check. Inspect its outcome before resuming.';
        return finish(run, 'interrupted', s.pausedBecause);
      }
      if (!run.wakeGate) {
        run.wakeGate = 'checking'; changed();
        run.wakeGate = await gateRunner.check(deps.home, s.wakeGate, gates.signal).catch(() => 'failed' as const);
        if (closed) return;
        changed();
      }
      if (run.wakeGate === 'quiet') return finish(run, 'quiet', 'The script found no change; no model was called.');
      if (run.wakeGate !== 'wake') {
        s.paused = true; s.version++;
        s.pausedBecause = 'The script check failed or timed out. Inspect its outcome before resuming; no model was called.';
        return finish(run, 'failed', s.pausedBecause);
      }
      if (deps.closing() || deps.readOnly || s.paused || find(s.id) !== s || s.version !== version) return finish(run, 'skipped', 'The schedule changed while its script was running.');
      // A long-running check does not pin live goal or withdrawal state. Recheck it before waking.
      made = textFor(s);
      if ('problem' in made) return finish(run, 'skipped', made.problem);
    }
    const admitted = await admitProactive(deps, { threadId: s.threadId ?? undefined, projectId: s.projectId, text: made.text, attachments: [], settings: s.settings, clientKey: `schedule-run:${run.id}` }, (threadId, turnId) => {
      run.threadId = threadId;
      run.turnId = turnId;
      run.outcome = 'running';
      s.threadId ??= threadId;
      changed();
    }, made.sources);
    if ('problem' in admitted) return finish(run, 'skipped', admitted.problem);
    if (admitted.ended) ended(admitted.ended.thread, admitted.ended.turn);
  }

  function finish(run: ScheduleRun, outcome: RunOutcome, summary: string) {
    run.outcome = outcome;
    run.summary = summary;
    run.endedAt = iso(deps.now());
    report(run, outcome, summary);
  }

  /**
   * What a run came to reaches the person only through the one daily brief, unless it is a security or
   * money emergency, told at once and counted (C3). Triggers' runs report here too; one started by
   * outside data that claims an emergency reports it `suppressed`: held for the brief, and counted.
   */
  function report(run: Pick<ScheduleRun, 'id' | 'threadId' | 'title' | 'startedAt'> & { kind: string }, outcome: RunOutcome, summary: string, urgent?: 'security' | 'money', suppressed?: boolean) {
    const brief = stored.brief;
    if (outcome === 'needs-you' || outcome === 'failed' || outcome === 'interrupted' || (outcome === 'stopped' && run.kind !== 'heartbeat')) {
      brief.pending.push({ id: keyed(`brief:${run.id}`), runId: run.id, threadId: run.threadId, title: summary || run.title, detail: `${run.title} · ${localClock(Date.parse(run.startedAt))}`, done: false });
    }
    if (outcome === 'done') brief.finished++;
    if (outcome === 'emergency' && urgent) today().emergencies.push({ at: iso(deps.now()), runId: run.id, kind: urgent, detail: summary });
    if (suppressed && urgent) (today().suppressed ??= []).push({ at: iso(deps.now()), runId: run.id, kind: urgent, detail: summary });
    changed();
    if (outcome === 'emergency' && urgent) deps.emit({ topic: 'schedules', urgent: summary });
  }

  /** Something for the person that never interrupts: held for the next daily brief, once per key. */
  function note(item: { key: string; threadId: Id | null; title: string; detail: string }) {
    const id = keyed(`note:${item.key}`);
    if (stored.brief.pending.some((p) => p.id === id)) return;
    stored.brief.pending.push({ id, runId: null, threadId: item.threadId, title: item.title, detail: item.detail, done: false });
    changed();
  }

  /** Take notes back by their keys, waiting or already in the latest brief: what they named was withdrawn. */
  function unnote(keys: string[]) {
    const ids = new Set(keys.map((k) => keyed(`note:${k}`)));
    const brief = stored.brief;
    const before = brief.pending.length + (brief.latest?.items.length ?? 0);
    brief.pending = brief.pending.filter((p) => !ids.has(p.id));
    if (brief.latest) brief.latest = { ...brief.latest, items: brief.latest.items.filter((i) => !ids.has(i.id)) };
    if (brief.pending.length + (brief.latest?.items.length ?? 0) !== before) changed();
  }

  /** A turn ended: if a run started it, say what came of it. */
  function ended(_thread: StoredThread, turn: Turn) {
    const run = stored.runs.find((r) => r.turnId === turn.id && open(r));
    if (!run) return;
    const answer = turn.answer?.text ?? '';
    const said = firstLines(answer);
    const cut = cutShort(turn, said);
    if (cut) return finish(run, 'interrupted', cut);
    if (turn.status === 'stopped') return finish(run, 'stopped', said || 'Stopped.');
    if (turn.status === 'refused') return finish(run, 'failed', said || 'It could not run.');
    if (turn.effects.some((e) => e.outcome === 'UNKNOWN')) return finish(run, 'needs-you', `A write's outcome is unknown. ${said}`.trim());
    if (run.kind !== 'heartbeat') return finish(run, 'done', said);
    const urgent = URGENT.exec(answer);
    if (urgent) {
      const detail = firstLines(urgent[2]) || said;
      today().emergencies.push({ at: iso(deps.now()), runId: run.id, kind: urgent[1] === 'MONEY' ? 'money' : 'security', detail });
      finish(run, 'emergency', detail);
      deps.emit({ topic: 'schedules', urgent: detail });
      return;
    }
    if (answer.includes(HEARTBEAT_OK)) return finish(run, 'quiet', said.replace(HEARTBEAT_OK, '').trim() || 'Nothing needs you.');
    finish(run, 'needs-you', said);
  }

  function countMissed(s: Schedule, due: number, now: number) {
    let n = 0;
    for (let t: number | null = due; t !== null && t <= now && n < MAX_COUNTED; t = nextAfter(s.rule, t, anchorOf(s), s.hours)) n++;
    return n;
  }

  let busy = false;
  /** The tick under way, if any: the host's close waits for it, so a home is removed only after it. */
  let current: Promise<unknown> = Promise.resolve();
  function tick() {
    if (busy || deps.closing() || deps.readOnly) return Promise.resolve();
    const run = ticking();
    current = run.catch(() => {});
    // Explicit callers may await the checks; the scheduler's busy scope and shutdown never do.
    return run.then(() => Promise.all([...admitting.values()])).then(() => {});
  }
  async function ticking() {
    busy = true;
    try {
      await deps.ready;
      if (deps.closing()) return;
      for (const run of stored.runs.filter((r) => r.outcome === 'starting')) {
        if (find(run.scheduleId)?.wakeGate) void admitRun(run).catch(() => {});
        else await admitRun(run);
      }
      for (const run of stored.runs.filter((r) => r.outcome === 'running' && r.threadId && r.turnId)) {
        const thread = deps.threads.get(run.threadId!);
        const turn = thread?.turns.find((t) => t.id === run.turnId);
        if (thread && turn && turn.status !== 'running' && !thread.summary.running) ended(thread, turn);
      }
      const now = deps.now();
      for (const s of [...stored.schedules]) {
        if (s.paused || !s.nextAt || Date.parse(s.nextAt) > now) continue;
        const due = Date.parse(s.nextAt);
        s.nextAt = nextOf(s, now);
        // A heartbeat that slept through its hours just waits for the next; nothing old is caught up.
        if (s.kind === 'heartbeat' && s.hours && !withinHours(now, s.hours)) { changed(); continue; }
        s.lastRunAt = iso(now);
        const run = newRun(s, keyed(`${s.id}:${iso(due)}`), iso(due), s.kind === 'schedule' ? countMissed(s, due, now) : undefined);
        changed();
        if (s.wakeGate) void admitRun(run).catch(() => {});
        else await admitRun(run);
      }
      if (deps.daily && !deps.closing()) await deps.daily().catch(() => {});
      briefIfDue(now);
    } finally {
      busy = false;
    }
  }

  function briefIfDue(now: number) {
    const counted = today();
    const brief = stored.brief;
    if (counted.briefs > 0 || brief.latest?.date === counted.date || localClock(now) < brief.time) return;
    const items = [...brief.pending];
    if (brief.finished > 0) items.push({ id: keyed(`finished:${counted.date}`), runId: null, threadId: null, title: `${brief.finished} scheduled ${brief.finished === 1 ? 'run' : 'runs'} finished`, detail: 'See Scheduled.', done: false });
    if (!items.length) return;
    brief.latest = { date: counted.date, at: iso(now), items };
    brief.pending = [];
    brief.finished = 0;
    counted.briefs = 1;
    changed();
  }

  const timer = deps.readOnly ? undefined : setInterval(() => void tick().catch(() => {}), deps.tickMs);
  if (timer) setTimeout(() => void tick().catch(() => {}), 0);

  function view(): Proactivity {
    return {
      schedules: stored.schedules.filter((s) => s.kind === 'schedule'),
      heartbeat: heartbeat(),
      runs: stored.runs,
      brief: { time: stored.brief.time, latest: stored.brief.latest },
      interruptions: today(),
    };
  }

  const read = (when: string): { rule: Rule; summary: string } | { problem: string } => {
    const parsed = parseWhen(when, deps.now());
    return 'problem' in parsed ? parsed : { rule: parsed.rule, summary: describeRule(parsed.rule, deps.now()) };
  };

  type Handlers = { [M in 'schedules.get' | 'schedules.parse' | 'schedules.create' | 'schedules.update' | 'schedules.delete' | 'schedules.run' | 'heartbeat.put' | 'brief.put' | 'brief.done']: (a: Args<M>) => Promise<Result<M>> | Result<M> };
  const handlers: Handlers = {
    'schedules.get': () => structuredClone(view()),
    'schedules.parse': ({ when }) => {
      const r = read(when);
      if ('problem' in r) return refused('INVALID', r.problem);
      const now = deps.now();
      const t = nextAfter(r.rule, now, now);
      return { ok: true, value: { ...r, nextAt: t === null ? null : iso(t), anchor: iso(now) } };
    },
    'schedules.create': ({ projectId, threadId, text, when, settings, clientKey, pinned, wakeGate }) => {
      const known = stored.keys[clientKey] && find(stored.keys[clientKey]);
      if (known) return { ok: true, value: structuredClone(known) };
      if (!deps.projectExists(projectId)) return refused('NOT_FOUND', 'No such project.');
      if (wakeGate !== undefined) {
        const problem = gateProblem(deps.home, wakeGate, settings);
        if (problem) return refused('INVALID', problem);
      }
      const thread = threadId ? deps.threads.get(threadId) : undefined;
      if (threadId && !thread) return refused('NOT_FOUND', `No thread ${threadId}.`);
      if (thread && thread.summary.projectId !== projectId) return refused('INVALID', 'Use the chat\'s own project.');
      if (text.length > MAX_TEXT) return refused('INVALID', `Keep it under ${MAX_TEXT} characters.`);
      if (!text.trim() && !thread) return refused('INVALID', 'Say what should run, or schedule a chat with a goal.');
      // What the person was shown runs as shown: its rule and anchor, never `when` read again later.
      const anchor = pinned ? Date.parse(pinned.anchor) : NaN;
      if (pinned && (Number.isNaN(anchor) || !pinned.rule)) return refused('INVALID', 'A pinned schedule needs the rule and anchor its time was read with.');
      const r = pinned ? { rule: pinned.rule, summary: describeRule(pinned.rule, anchor) } : read(when);
      if ('problem' in r) return refused('INVALID', r.problem);
      if (pinned?.goal !== undefined && (text.trim() || thread?.goal?.current?.text !== pinned.goal)) return refused('NOT_AVAILABLE', 'The chat\'s goal changed since you were shown it, so nothing was scheduled. Ask again.');
      const now = deps.now();
      const s: Schedule = { id: keyed(`schedule:${clientKey}`), kind: 'schedule', projectId, threadId: threadId ?? null, text: text.trim(), when: when.trim(), ...r, settings, paused: false, ...(pinned ? { anchor: pinned.anchor } : {}), ...(pinned?.goal !== undefined ? { goal: pinned.goal } : {}), createdAt: iso(now), nextAt: null, lastRunAt: null, version: 1 };
      if (wakeGate) s.wakeGate = structuredClone(wakeGate);
      s.nextAt = nextOf(s, now);
      if (!s.nextAt) return refused('INVALID', 'That time has already passed.');
      if (pinned && s.nextAt !== pinned.firstAt) return refused('NOT_AVAILABLE', `The first run you were shown (${pinned.firstAt}) is not when it would run now (${s.nextAt}), so nothing was scheduled. Ask again.`);
      stored.schedules.push(s);
      stored.keys[clientKey] = s.id;
      changed();
      return { ok: true, value: structuredClone(s) };
    },
    'schedules.update': ({ id, patch, baseVersion, pinned }) => {
      const s = find(id);
      if (!s) return refused('NOT_FOUND', 'No such schedule.');
      if (s.version !== baseVersion) return refused('STALE_BASE', 'This schedule changed since you saw it. Look again.');
      if (patch.wakeGate !== undefined && patch.wakeGate !== null) {
        const problem = gateProblem(deps.home, patch.wakeGate, s.settings);
        if (problem) return refused('INVALID', problem);
      }
      // The person resuming a goal's schedule takes the goal as it is now.
      const resumedGoal = patch.paused === false && s.paused && s.goal !== undefined && s.threadId ? deps.threads.get(s.threadId)?.goal?.current?.text : undefined;
      if (patch.paused === false && s.paused && s.goal !== undefined && !s.text.trim() && resumedGoal === undefined) return refused('INVALID', 'This chat has no goal to work toward. Set one, or give the schedule words of its own.');
      const now = deps.now();
      // Validate the entire candidate before mutating stored state: a refused edit changes nothing.
      if (patch.text !== undefined && patch.text.length > MAX_TEXT) return refused('INVALID', `Keep it under ${MAX_TEXT} characters.`);
      let timing: Partial<Schedule> = {};
      if (pinned && patch.when === undefined) return refused('INVALID', 'A time preview needs the words being edited.');
      if (patch.when !== undefined) {
        const anchor = pinned ? Date.parse(pinned.anchor) : now;
        if (!Number.isFinite(anchor)) return refused('INVALID', 'A time preview needs its original anchor.');
        const r = pinned ? { rule: pinned.rule, summary: describeRule(pinned.rule, anchor) } : read(patch.when);
        if ('problem' in r) return refused('INVALID', r.problem);
        const candidate = { ...s, ...r, when: patch.when.trim(), createdAt: iso(now), anchor: iso(anchor) };
        candidate.nextAt = nextOf(candidate, now);
        if (!candidate.nextAt) return refused('INVALID', 'That time has already passed. Preview the time again.');
        if (pinned && candidate.nextAt !== pinned.firstAt) return refused('NOT_AVAILABLE', 'The first run you saw has passed or changed. Preview the time again.');
        timing = { rule: candidate.rule, summary: candidate.summary, when: candidate.when, createdAt: candidate.createdAt, anchor: candidate.anchor, nextAt: candidate.nextAt };
      }
      Object.assign(s, timing);
      if (patch.text !== undefined) {
        s.text = patch.text.trim();
      }
      if (patch.wakeGate === null) delete s.wakeGate;
      else if (patch.wakeGate !== undefined) s.wakeGate = structuredClone(patch.wakeGate);
      if (patch.paused !== undefined && patch.paused !== s.paused) {
        s.paused = patch.paused;
        delete s.pausedBecause;
        if (resumedGoal !== undefined) s.goal = resumedGoal;
        // Resuming runs what is due now, not what was missed while paused.
        if (!s.paused) s.nextAt = nextOf(s, now - 60_000);
      }
      s.version++;
      changed();
      return { ok: true, value: structuredClone(s) };
    },
    'schedules.delete': ({ id }) => {
      if (!find(id)) return refused('NOT_FOUND', 'No such schedule.');
      stored.schedules = stored.schedules.filter((s) => s.id !== id);
      changed();
      return { ok: true, value: structuredClone({ id }) };
    },
    'schedules.run': async ({ id, clientKey }) => {
      const s = find(id);
      if (!s) return refused('NOT_FOUND', 'No such schedule.');
      const runId = keyed(`${s.id}:now:${clientKey}`);
      const known = stored.runs.find((r) => r.id === runId);
      if (known) return { ok: true, value: structuredClone(known) };
      const run = newRun(s, runId, iso(deps.now()));
      changed();
      await admitRun(run);
      return { ok: true, value: structuredClone(run) };
    },
    'heartbeat.put': ({ enabled, projectId, everyMinutes, hours, check, settings }) => {
      const prior = heartbeat();
      if (!enabled) {
        stored.schedules = stored.schedules.filter((s) => s.kind !== 'heartbeat');
        changed();
        return { ok: true, value: null };
      }
      if (!deps.projectExists(projectId)) return refused('NOT_FOUND', 'No such project.');
      if (!Number.isInteger(everyMinutes) || everyMinutes < 1 || everyMinutes > 24 * 60) return refused('INVALID', 'A heartbeat runs every 1 to 1,440 minutes.');
      if (!isClock(hours.start) || !isClock(hours.end)) return refused('INVALID', 'Active hours are written HH:MM.');
      if (!check.trim() || check.length > MAX_TEXT) return refused('INVALID', 'Say what the heartbeat should check.');
      const rule: Rule = { kind: 'rrule', rrule: everyMinutes % 60 === 0 ? `FREQ=HOURLY;INTERVAL=${everyMinutes / 60}` : `FREQ=MINUTELY;INTERVAL=${everyMinutes}` };
      const now = deps.now();
      const s: Schedule = {
        id: prior?.id ?? keyed(`heartbeat:${iso(now)}`), kind: 'heartbeat', projectId, threadId: prior?.projectId === projectId ? prior.threadId : null,
        text: check.trim(), when: `every ${everyMinutes} minutes`, rule, summary: `${describeRule(rule)}, ${hours.start}–${hours.end}`, hours: hours as Hours, settings,
        paused: false, createdAt: prior?.createdAt ?? iso(now), nextAt: null, lastRunAt: prior?.lastRunAt ?? null, version: (prior?.version ?? 0) + 1,
      };
      s.nextAt = nextOf(s, now);
      stored.schedules = [...stored.schedules.filter((x) => x.kind !== 'heartbeat'), s];
      changed();
      return { ok: true, value: structuredClone(s) };
    },
    'brief.put': ({ time }) => {
      if (!isClock(time)) return refused('INVALID', 'Write the time as HH:MM.');
      stored.brief.time = time;
      changed();
      return { ok: true, value: structuredClone({ time, latest: stored.brief.latest }) };
    },
    'brief.done': ({ id }) => {
      const latest = stored.brief.latest;
      const item = latest?.items.find((i) => i.id === id);
      if (!latest || !item) return refused('NOT_FOUND', 'No such brief item.');
      item.done = true;
      changed();
      return { ok: true, value: structuredClone(latest) };
    },
  };

  return {
    handlers,
    ended,
    report,
    note,
    unnote,
    tick,
    close: () => { closed = true; gates.abort(); if (timer) clearInterval(timer); },
    /** Settles once no tick is under way: housekeeping started before close (which takes the home lock, creating the home) ends before removal. */
    whenIdle: async () => { await current; await Promise.all([...admitting].filter(([id]) => !gated.has(id)).map(([, promise]) => promise)); },
  };
}
