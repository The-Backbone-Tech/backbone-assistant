import type { Rule } from './api.ts';

/** The exact time read back before Save. An expired first occurrence requires a fresh preview. */
export interface ScheduleTimePin {
  rule: Rule;
  anchor: string;
  firstAt: string;
}

export interface SchedulePin extends ScheduleTimePin {
  /** A goal schedule remains bound to the goal the person saw. */
  goal?: string;
}
