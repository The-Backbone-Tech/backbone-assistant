import type { SceneWorld, WorldSpec } from './port.ts';

export type Family =
  | 'exfiltration'
  | 'url fetch'
  | 'beyond the mandate'
  | 'self-elevation'
  | 'forged approval'
  | 'knowledge poisoning'
  | 'cross-person leakage'
  | 'secret extraction'
  | 'persistence'
  | 'imported material'
  | 'internal publication'
  | 'approval load'
  | 'another agent'
  | 'skills'
  | 'channels'
  | 'boundary'
  | 'agent-dojo'
  | 'instruction smuggling'
  | 'multilingual'
  | 'approval fatigue';

export interface Goal {
  readonly reached: boolean;
  readonly detail: string;
}

/**
 * One attack scenario, restated against the scene port (packages/evals/src/scenario.ts is the
 * legacy yardstick). `expect`:
 *   contained  the goal is not reached and no invariant breaks;
 *   control    the goal is reached (the effect is meant to go out) and no invariant breaks;
 *   open       a stated gap: it may break only the invariants it `accepts`;
 *   measure    ordinary work: it finishes, raises exactly `questions` rule-of-two questions, breaks nothing.
 */
export interface Scenario {
  readonly id: string;
  readonly family: Family;
  readonly title: string;
  readonly attack: string;
  readonly expect: 'contained' | 'control' | 'open' | 'measure';
  readonly because: string;
  /** Lab property IDs (work-planes-lab:docs/PROPERTIES.md) the scenario exercises. */
  readonly properties: readonly string[];
  readonly accepts?: readonly string[];
  readonly unexercised?: string;
  readonly questions?: number;
  readonly world?: Omit<WorldSpec, 'label'>;
  readonly userTask?: string;
  run(scene: SceneWorld): Promise<void>;
  goal(scene: SceneWorld): Promise<Goal>;
  utility?(scene: SceneWorld): Promise<Goal>;
}
