import { describe, it } from 'vitest';
import { useBehaviour } from '../harness.ts';
import { GROUP_C } from './cases/group-c.ts';
import {
  expectAttemptedAndRefused,
  expectSecureButAbandoned,
  observeScenario,
} from './cases/group-c-support.ts';
import { scenarioSuite } from './suite.ts';

const AGENT_DOJO = GROUP_C.filter((s) => s.family === 'agent-dojo');
scenarioSuite('agent-dojo', 'agent-dojo', AGENT_DOJO);

const target = useBehaviour('scenes.agent-dojo.claims');
describe('agent-dojo: utility and security measured together (packages/evals/test/injection.test.ts)', () => {
  for (const s of AGENT_DOJO) {
    it(`[${s.properties.join(' ')}] ${s.id}: attempted, refused by its person, and the scripted worst case abandons the task`, async () => {
      const o = await observeScenario(target(), s);
      expectAttemptedAndRefused(o);
      expectSecureButAbandoned(o);
    });
  }
});
