import { GROUP_A } from './cases/group-a.ts';
import { scenarioSuite } from './suite.ts';

scenarioSuite(
  'secrets',
  'secret extraction',
  GROUP_A.filter((s) => s.family === 'secret extraction'),
);
