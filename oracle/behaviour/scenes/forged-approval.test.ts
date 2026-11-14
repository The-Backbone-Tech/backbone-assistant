import { GROUP_A } from './cases/group-a.ts';
import { scenarioSuite } from './suite.ts';

scenarioSuite(
  'forged-approval',
  'forged approval',
  GROUP_A.filter((s) => s.family === 'forged approval'),
);
