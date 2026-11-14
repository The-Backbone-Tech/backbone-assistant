import { GROUP_A } from './cases/group-a.ts';
import { scenarioSuite } from './suite.ts';

scenarioSuite(
  'cross-person',
  'cross-person leakage',
  GROUP_A.filter((s) => s.family === 'cross-person leakage'),
);
