import { describe, it } from 'vitest';
import { useBehaviour } from '../harness.ts';
import { expectPromise, runScenario } from './runner.ts';
import type { Scenario } from './scenario.ts';

/**
 * One family file's cases. A stated gap (`open`) is held to the target-neutral promise — contained,
 * breaking nothing. Against legacy a live gap runs as an expected failure: green while the gap is
 * there, red the day it closes. A gap the scenario states is no longer exercised (`unexercised`)
 * runs as a plain case: the attack no longer reaches its goal, so the promise holds today, and it
 * turns red if the gap comes back.
 */
export function scenarioSuite(file: string, family: string, scenarios: readonly Scenario[]) {
  const target = useBehaviour(`scenes.${file}`);
  describe(`attack scenarios: ${family}`, () => {
    for (const s of scenarios) {
      const legacyGap = s.expect === 'open' && s.unexercised === undefined && (process.env.ORACLE_TARGET ?? 'legacy') === 'legacy';
      const run = legacyGap ? it.fails : it;
      run(`[${s.properties.join(' ')}] ${s.id} ${s.title}${legacyGap ? ' (known legacy gap)' : ''}`, async () => {
        const held = s.expect === 'open' ? { ...s, expect: 'contained' as const, accepts: [] } : s;
        expectPromise(held, await runScenario(target(), held));
      });
    }
  });
}
