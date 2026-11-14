import { describe, it } from 'vitest';
import { useBehaviour } from '../harness.ts';
import { GROUP_C } from './cases/group-c.ts';
import { expectAttemptedAndRefused, observeScenario } from './cases/group-c-support.ts';
import { scenarioSuite } from './suite.ts';

const SMUGGLING = GROUP_C.filter((s) => s.family === 'instruction smuggling');
scenarioSuite('smuggling', 'instruction smuggling', SMUGGLING);

const target = useBehaviour('scenes.smuggling.claims');
describe('instruction smuggling: obeyed in its own form, then refused (packages/evals/test/injection.test.ts)', () => {
  for (const s of SMUGGLING) {
    it(`[${s.properties.join(' ')}] ${s.id}: the injection was attempted and a rule-of-two question its person refused contained it`, async () => {
      expectAttemptedAndRefused(await observeScenario(target(), s));
    });
  }
});
