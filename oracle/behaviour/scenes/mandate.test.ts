import { GROUP_A } from './cases/group-a.ts';
import { scenarioSuite } from './suite.ts';

scenarioSuite(
  'mandate',
  'beyond the mandate',
  GROUP_A.filter((s) => s.family === 'beyond the mandate'),
);
