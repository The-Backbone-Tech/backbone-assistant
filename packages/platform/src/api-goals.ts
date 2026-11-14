// Goal projections of the api port, moved unchanged from api.ts.
import type { Id, TurnSelection, TurnSettings } from './api.ts';

// ---- Goals that run until met ---------------------------------------------

/**
 * A goal running until it is met. After each turn on the chat (and once its children are done) a
 * judge turn on the same route checks the work against the goal text, its completion criterion.
 * `budget` is the most turns of work the run starts; `used` counts them, the person's first included.
 */
export interface GoalRun {
  threadId: Id;
  /** interrupted: the app stopped during one of its turns, which did not finish; Resume goes on past it. */
  status: 'running' | 'paused' | 'met' | 'blocked' | 'budget' | 'interrupted';
  budget: number;
  used: number;
  /** Input plus output tokens, including checks and children, reported by the engine. Enforced between turns. */
  tokenBudget?: number;
  tokensUsed?: number;
  /** Usage at admission; earlier turns are excluded, and restart never resets the allowance. */
  usageBefore?: Record<Id, number>;
  initialTurnId?: Id;
  /** Consecutive unchanged work/check pairs. Hashes keep withdrawn answer text out of this record. */
  progressCheck?: { turnId: Id; fingerprint: string; repeats: number };
  /** Person-supplied criteria pinned for this run. A MET assessment needs evidence for every one. */
  rubric?: string[];
  rubricResults?: { criterion: string; passed: boolean; evidence?: string }[];
  /** What the run waits on now: a turn of work, the judge, or the chat's children. */
  phase: 'work' | 'judge' | 'children';
  /** Why it is paused or blocked, or what is missing. */
  detail?: string;
  /** The judge's words when it found the goal met, and the turn that said so. */
  evidence?: { turnId: Id; detail: string };
  /** The turn the person resumed past: its Stop or interruption no longer holds the run. An UNKNOWN in it still does. */
  past?: Id;
  /** Pinned when the run was allowed: every turn of it runs so, whatever the chat's later turns use. */
  settings?: TurnSettings;
  /** Pinned when the run was allowed: if the chat's goal changes, the run pauses rather than follow it. */
  goal?: string;
  /** The chosen route the chat's task had when the run was allowed, recorded for its work and its checks alike; a later choice in the chat does not move it. */
  selection?: TurnSelection;
  startedAt: string;
  updatedAt: string;
}
