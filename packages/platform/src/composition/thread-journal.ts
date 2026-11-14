// The home's append-only journal of goals, the child tree, turn lifecycle and what each turn was told.
// One file, one order across threads, each event flushed before it is acted on. Thread files are a cache
// of it: at open the fields it owns are dropped from them and rebuilt by replay, so a stale or lost file
// cannot decide anything. What it does not own stays in the thread file: a turn's steps, summary edits
// such as a title, side chats and the private write custody (thread-custody.ts).
import { cleanThreadWorkspace } from './workspace-lifecycle.ts';
import { closeSync, existsSync, fstatSync, fsyncSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import {writeAll,createDurableFile} from '@backbone-next/kernel/files';
import type {MaterialFileReadEvent} from './material-file-read.ts';
import type {ConnectorObservationEvent} from './connector-observations.ts';
import type { ChildLink, GoalChange, GoalProposal, GoalState, Id, QueuedMessage, SteerState, Thread, Turn, TurnSteer } from '../api.ts';

/** A source by version. A restore starts a new `withdrawals` count, so no restore revives an older source version. */
export interface Source { id: Id; name: string; version: number; withdrawals: number }
/** The private half of a child's link: its mandate, the key that makes its start once-only, and what its brief came from. */
export type StoredChild = ChildLink & { mandate: string; key: string; reviewTurns?: Id[]; briefSources?: Source[]; /** Its brief came from a turn whose sources are not all known: withheld once anything in the project was withdrawn. */ briefUnknown?: true };
export type StoredThread = Omit<Thread, 'card' | 'child' | 'children' | 'queueHeld' | 'steering' | 'reviewer'> & { personId?: string; automationId?: string; rewindPending?: import('../api-rewind.ts').RewindRecord; /** Stop holds the queue until the person sends it on. */ queuePaused?: string; /** Queued messages that were sent or removed: a retried add does not bring one back. */ queueDone?: Id[]; clientKeys: string[]; task?: string; child?: StoredChild; forkKey?: string; /** The tasks a fork came from: a hold outlives a deleted thread between them. */ heldTasks?: string[]; /** A fork of a briefed child: the brief keeps its sources, though the fork is no child. */ briefSources?: Source[]; /** And its unknown provenance: withheld once anything in the project was withdrawn. */ briefUnknown?: true };

export interface ToldItem { kind: 'goal' | 'brief' | 'report' | 'transcript' | 'steer' | 'peer'; digest: string; sources: Source[]; /** The record's decision: its words were not given. */ withheld?: boolean; report?: { threadId: Id; turnId: Id } }
type Closed = Pick<Turn, 'status' | 'effects'> & Partial<Pick<Turn, 'answer' | 'completed' | 'withheld' | 'unknownSources' | 'reads' | 'refusal' | 'failure' | 'unknownOutcome' | 'unknownEvidence' | 'nativeAccountActivity'>> & { endedAt?: string; usage?: Turn['work']['usage'] };

export type JournalBody =
  | { kind: 'turn.unknown.checked'; threadId: Id; turnId: Id; check: import('../api.ts').UnknownCheck }
  | { kind: 'thread.rewind.started'; threadId: Id; record: import('../api-rewind.ts').RewindRecord }
  | { kind: 'thread.rewind.progress'; threadId: Id; record: import('../api-rewind.ts').RewindRecord }
  | { kind: 'thread.rewound'; threadId: Id; record: import('../api-rewind.ts').RewindRecord }
  | ConnectorObservationEvent
  | MaterialFileReadEvent
  /** `queued`: the queued message this turn is. One line, so a message is queued or a turn and never both. */
  | { kind: 'turn.reserved'; threadId: Id; turn: Turn; clientKey: string; created?: Pick<StoredThread, 'summary' | 'task' | 'child' | 'personId' | 'automationId'>; queued?: Id }
  | { kind: 'turn.steered'; threadId: Id; turnId: Id; steer: TurnSteer }
  /** `requeue`: words that did not arrive go back to the queue in the same line. */
  | { kind: 'turn.steer.settled'; threadId: Id; turnId: Id; steerId: Id; state: Exclude<SteerState, 'sending'>; detail?: string; requeue?: QueuedMessage }
  | { kind: 'queue.added'; threadId: Id; message: QueuedMessage }
  | { kind: 'queue.edited'; threadId: Id; id: Id; text: string }
  | { kind: 'queue.removed'; threadId: Id; id: Id }
  | { kind: 'queue.problem'; threadId: Id; id: Id; problem: string }
  | { kind: 'queue.paused'; threadId: Id; reason: string }
  | { kind: 'turn.stop'; threadId: Id; turnId: Id }
  | { kind: 'turn.told'; threadId: Id; turnId: Id; digest: string; items: ToldItem[]; unknownSources?: true }
  | { kind: 'turn.closed'; threadId: Id; turnId: Id; state: Closed }
  | { kind: 'goal.changed'; threadId: Id; change: GoalChange; reads?: Turn['reads'] }
  | { kind: 'goal.proposed'; threadId: Id; proposal: GoalProposal }
  | { kind: 'thread.forked'; threadId: Id; thread: StoredThread }
  | { kind: 'thread.deleted'; threadId: Id };
export type JournalEvent = JournalBody & { at: string };

const TORN = '{"kind":"journal.torn"}';
export const emptyGoal = (): GoalState => ({ current: null, version: 0, proposals: [], history: [] });

export class ThreadJournal {
  readonly path: string;
  private readonly home: string;
  constructor(home: string) { this.home = home; this.path = join(home, 'thread-journal.jsonl'); }

  /** On disk when this returns. A torn tail from a kill is marked first, so replay can tell it from damage. */
  append<T extends JournalBody>(body: T): T & { at: string } {
    const event = { ...body, at: new Date().toISOString() };
    // The home has one writer. Name the first journal durably before its first dispatch
    // barrier; syncing only its file would not persist a newly created directory entry.
    if(!existsSync(this.path))createDurableFile(this.path,0o600);
    const fd = openSync(this.path, 'r+');
    try {
      const { size } = fstatSync(fd);
      const last = Buffer.alloc(1);
      if (size) readSync(fd, last, 0, 1, size - 1);
      const torn = size > 0 && last[0] !== 10;
      writeAll(fd,Buffer.from(`${torn ? `\n${TORN}\n` : ''}${JSON.stringify(event)}\n`),size);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    return event;
  }

  read(): JournalEvent[] {
    if (!existsSync(this.path)) return [];
    const lines = readFileSync(this.path, 'utf8').split('\n');
    lines.pop();
    const events: JournalEvent[] = [];
    lines.forEach((line, i) => {
      if (line === TORN) return;
      try { events.push(JSON.parse(line) as JournalEvent); }
      catch { if (lines[i + 1] !== TORN) throw new Error('The thread journal is damaged; it is preserved and nothing was opened.'); }
    });
    return events;
  }

  /** Thread files in, journal truth out. Returns the threads whose file must go, a kill having left it. */
  rebuild(threads: Map<Id, StoredThread>, options: {readOnly?: boolean} = {}): Id[] {
    const events = this.read();
    const known = new Set(events.map((e) => e.threadId));
    const gone: Id[] = [];
    for (const [id, t] of threads) {
      if (known.has(id)) strip(t);
      // Only `turn.reserved` commits a child, so a file for any other was never one.
      else if (t.child) { threads.delete(id); gone.push(id); }
    }
    for (const event of events) {
      applyEvent(threads, event);
      if (event.kind === 'thread.deleted') {
        gone.push(event.threadId);
        // Inspection replays in memory; a later writable open retires the durable deletion's scratch.
        if (!options.readOnly) cleanThreadWorkspace(this.home, event.threadId);
      }
    }
    return gone;
  }
}

function strip(t: StoredThread) {
  for (const field of ['rewinds', 'rewindPending', 'goal', 'child', 'forkedFrom', 'heldTasks', 'forkKey', 'briefSources', 'queue', 'queuePaused', 'queueDone'] as const) delete t[field];
  for (const turn of t.turns) {
    // `stopRequested` stays: a stop only narrows, so a cache saying so is safe to honour with the journal.
    delete turn.unknownChecked;
    delete turn.unknownCheckedCurrent;
    delete turn.unknownCheck;
    delete turn.handovers;
    delete turn.steers;
    if (turn.reads) turn.reads = turn.reads.filter((read) => !read.told);
  }
}

const turnOf = (threads: Map<Id, StoredThread>, threadId: Id, turnId: Id) => threads.get(threadId)?.turns.find((t) => t.id === turnId);

/** The one reducer: live changes and replay go through it, so they cannot differ. Unknown threads are ignored. */
export function applyEvent(threads: Map<Id, StoredThread>, event: JournalBody): void {
  const thread = threads.get(event.threadId);
  switch (event.kind) {
    case 'thread.rewind.started':
    case 'thread.rewind.progress':
      if (thread) thread.rewindPending = event.record;
      return;
    case 'thread.rewound': {
      if (!thread) return;
      const index = thread.turns.findIndex(turn => turn.id === event.record.turnId);
      if (index < 0) return;
      const removed = new Set(event.record.turns.map(turn => turn.id));
      // Cached later work (including its steps) can already be present during replay.
      // Remove only this archive's ids, keeping keys aligned with their own turns.
      thread.clientKeys = thread.clientKeys.filter((_, i) => !removed.has(thread.turns[i]?.id));
      thread.turns = thread.turns.filter(turn => !removed.has(turn.id));
      thread.sideTurns = thread.sideTurns.filter(turn => !event.record.sideTurns?.some(removed => removed.id === turn.id));
      if (!thread.rewinds?.some(record => record.id === event.record.id)) (thread.rewinds ??= []).push(event.record);
      delete thread.rewindPending;
      return;
    }
    case 'turn.reserved': {
      const t = thread ?? (event.created ? { summary: event.created.summary, turns: [], sideTurns: [], clientKeys: [] } as StoredThread : undefined);
      if (!t) return;
      threads.set(event.threadId, t);
      if (event.created?.task) t.task = event.created.task;
      if (event.created?.personId) t.personId = event.created.personId;
      if (event.created?.automationId) t.automationId = event.created.automationId;
      if (event.created?.child) t.child = event.created.child;
      const held = t.turns.find((x) => x.id === event.turn.id);
      if (held) held.status = 'running';
      else { t.turns.push(event.turn); t.clientKeys.push(event.clientKey); }
      t.summary.running = true;
      // A Stop's hold is answered one message at a time, and ends with the last of them.
      if (event.queued) { t.queue = t.queue?.filter((m) => m.id !== event.queued); (t.queueDone ??= []).push(event.queued); if (!t.queue?.length) delete t.queuePaused; }
      return;
    }
    case 'turn.steered': {
      const turn = turnOf(threads, event.threadId, event.turnId);
      if (turn && !turn.steers?.some((s) => s.id === event.steer.id)) (turn.steers ??= []).push({ ...event.steer });
      return;
    }
    case 'turn.steer.settled': {
      const steer = turnOf(threads, event.threadId, event.turnId)?.steers?.find((s) => s.id === event.steerId);
      if (steer) { steer.state = event.state; if (event.detail) steer.detail = event.detail; }
      if (thread && event.requeue && !thread.queue?.some((m) => m.id === event.requeue!.id)) thread.queue = [event.requeue, ...(thread.queue ?? [])];
      return;
    }
    case 'queue.added':
      if (thread && !thread.queue?.some((m) => m.id === event.message.id)) thread.queue = [...(thread.queue ?? []), event.message];
      return;
    case 'queue.edited':
      if (thread) thread.queue = thread.queue?.map((m) => { if (m.id !== event.id) return m; const { problem: _p, ...kept } = m; return { ...kept, text: event.text, version: m.version + 1 }; });
      return;
    case 'queue.removed':
      if (thread) { thread.queue = thread.queue?.filter((m) => m.id !== event.id); (thread.queueDone ??= []).push(event.id); if (!thread.queue?.length) delete thread.queuePaused; }
      return;
    case 'queue.problem':
      if (thread) thread.queue = thread.queue?.map((m) => (m.id === event.id ? { ...m, problem: event.problem } : m));
      return;
    case 'queue.paused':
      if (thread) thread.queuePaused = event.reason;
      return;
    case 'turn.stop': {
      const turn = turnOf(threads, event.threadId, event.turnId);
      if (turn) turn.stopRequested = true;
      return;
    }
    case 'turn.told': {
      const turn = turnOf(threads, event.threadId, event.turnId);
      if (!turn) return;
      if (event.unknownSources) turn.unknownSources = true;
      for (const item of event.items) {
        if (item.report && !turn.handovers?.some((h) => h.turnId === item.report!.turnId)) (turn.handovers ??= []).push(item.report);
        if (item.withheld) continue;
        const reads = (turn.reads ??= []);
        for (const s of item.sources) {
          if (!reads.some((r) => r.told && r.id === s.id && r.version === s.version && r.withdrawals === s.withdrawals)) reads.push({ ...s, inherited: true, told: true });
        }
      }
      return;
    }
    case 'turn.unknown.checked': {
      const turn = turnOf(threads, event.threadId, event.turnId);
      if (turn) turn.unknownChecked = event.check;
      return;
    }
    case 'turn.closed': {
      const turn = turnOf(threads, event.threadId, event.turnId);
      if (!turn) return;
      const { endedAt, usage, ...state } = event.state;
      Object.assign(turn, state);
      if (endedAt) turn.work.endedAt = endedAt;
      if (usage) turn.work.usage = usage;
      if (thread!.turns.at(-1) === turn) thread!.summary.running = false;
      return;
    }
    case 'goal.changed': {
      if (!thread) return;
      const goal = thread.goal ?? emptyGoal();
      const { change } = event;
      const proposals = change.proposalId ? goal.proposals.map((p) => (p.id === change.proposalId ? { ...p, state: change.action === 'accepted' ? 'accepted' as const : 'declined' as const, decidedAt: change.at } : p)) : goal.proposals;
      const current = change.action === 'cleared' ? null : change.action === 'declined' ? goal.current
        : { text: change.text, by: 'person' as const, at: change.at, ...(change.proposalId ? { fromProposal: change.proposalId } : {}), ...(event.reads?.length ? { reads: event.reads } : {}) };
      thread.goal = { current, version: goal.version + 1, proposals, history: [...goal.history, change] };
      return;
    }
    case 'goal.proposed': {
      if (!thread) return;
      const goal = thread.goal ?? emptyGoal();
      thread.goal = { ...goal, proposals: [...goal.proposals, event.proposal] };
      return;
    }
    case 'thread.forked':
      if (!thread) { threads.set(event.threadId, event.thread); return; }
      // Rebuilding over its file: later turns, steps and summary edits stay, the journal's fields come back.
      Object.assign(thread, { task: event.thread.task, forkKey: event.thread.forkKey, heldTasks: event.thread.heldTasks, forkedFrom: event.thread.forkedFrom, goal: event.thread.goal, briefSources: event.thread.briefSources });
      for (const copied of event.thread.turns) { const turn = thread.turns.find((t) => t.id === copied.id); if (turn) turn.reads = copied.reads; }
      return;
    case 'thread.deleted':
      threads.delete(event.threadId);
  }
}
