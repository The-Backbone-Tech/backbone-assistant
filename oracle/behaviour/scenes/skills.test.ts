import { GROUP_B } from './cases/group-b.ts';
import { scenarioSuite } from './suite.ts';

scenarioSuite(
  'skills',
  'skills',
  GROUP_B.filter((s) => s.family === 'skills'),
);
