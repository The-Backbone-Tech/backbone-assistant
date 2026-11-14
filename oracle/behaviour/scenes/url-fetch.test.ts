import { GROUP_A } from './cases/group-a.ts';
import { scenarioSuite } from './suite.ts';

scenarioSuite(
  'url-fetch',
  'url fetch',
  GROUP_A.filter((s) => s.family === 'url fetch'),
);
