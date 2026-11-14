import { expect } from 'vitest';
import { GROUP_B } from './cases/group-b.ts';
import { suiteChecks } from './cases/group-b-support.ts';
import { scenarioSuite } from './suite.ts';

const PUBLICATION = GROUP_B.filter((s) => s.family === 'internal publication');
scenarioSuite('publication', 'internal publication', PUBLICATION);

suiteChecks('internal publication', PUBLICATION, [
  {
    id: 'AN1',
    name: 'keeps what work marked both ways answers for its person where others read the task, asking nobody',
    check(o) {
      expect(o.facts.kept.answers).toBeGreaterThanOrEqual(1);
      expect(o.facts.ruleOfTwo.asked).toBe(0);
    },
  },
]);
