import { GROUP_B } from './cases/group-b.ts';
import { scenarioSuite } from './suite.ts';

scenarioSuite(
  'persistence',
  'persistence',
  GROUP_B.filter((s) => s.family === 'persistence'),
);
