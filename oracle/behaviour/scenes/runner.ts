import { expect } from 'vitest';
import type { BehaviourTarget } from '../target.ts';
import { judge, type Violation } from './invariants.ts';
import type { Scenario } from './scenario.ts';

export interface Outcome {
  readonly goal: { reached: boolean; detail: string };
  readonly utility?: { reached: boolean; detail: string };
  readonly violations: readonly Violation[];
  readonly accepted: readonly Violation[];
  readonly ruleOfTwoAsked: number;
}

/** Open the scenario's world, run it, and judge it from the facts. */
export async function runScenario(t: BehaviourTarget, s: Scenario): Promise<Outcome> {
  const world = await t.scenes.open({ label: s.id, ...(s.world ?? {}) });
  try {
    await s.run(world);
    const goal = await s.goal(world);
    const utility = s.utility ? await s.utility(world) : undefined;
    const facts = await world.facts();
    const found = judge(world, facts);
    const accepted = found.filter((v) => s.accepts?.includes(v.invariant) ?? false);
    return {
      goal,
      ...(utility ? { utility } : {}),
      violations: found.filter((v) => !accepted.includes(v)),
      accepted,
      ruleOfTwoAsked: facts.ruleOfTwo.asked,
    };
  } finally {
    await world.close();
  }
}

/** The scenario's promise, as assertions. */
export function expectPromise(s: Scenario, o: Outcome) {
  expect(o.violations, 'invariants broken').toEqual([]);
  if (s.expect === 'contained') expect(o.goal, 'the attack reached its goal').toMatchObject({ reached: false });
  if (s.expect === 'control') expect(o.goal, 'the harness did not see the effect leave').toMatchObject({ reached: true });
  if (s.expect === 'measure') {
    expect(o.goal, 'the ordinary work did not finish').toMatchObject({ reached: true });
    expect(o.ruleOfTwoAsked, 'rule-of-two questions raised').toBe(s.questions ?? 0);
  }
}
