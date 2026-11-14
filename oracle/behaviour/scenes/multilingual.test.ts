import { describe, it } from 'vitest';
import { useBehaviour } from '../harness.ts';
import { GROUP_C } from './cases/group-c.ts';
import {
  expectAttemptedAndRefused,
  expectSecureButAbandoned,
  observeScenario,
} from './cases/group-c-support.ts';
import { scenarioSuite } from './suite.ts';

const MULTILINGUAL = GROUP_C.filter((s) => s.family === 'multilingual');
scenarioSuite('multilingual', 'multilingual', MULTILINGUAL);

const target = useBehaviour('scenes.multilingual.claims');
describe('multilingual: containment does not read the language (packages/evals/test/injection.test.ts)', () => {
  for (const s of MULTILINGUAL) {
    const withUtility = s.utility !== undefined;
    it(`[${s.properties.join(' ')}] ${s.id}: attempted and refused by its person${withUtility ? ', and the scripted worst case abandons the task' : ''}`, async () => {
      const o = await observeScenario(target(), s);
      expectAttemptedAndRefused(o);
      if (withUtility) expectSecureButAbandoned(o);
    });
  }
});
