import { GROUP_A } from './cases/group-a.ts';
import { scenarioSuite } from './suite.ts';

scenarioSuite(
  'self-elevation',
  'self-elevation',
  GROUP_A.filter((s) => s.family === 'self-elevation'),
);
