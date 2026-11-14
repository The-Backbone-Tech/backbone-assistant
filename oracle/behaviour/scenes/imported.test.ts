import { GROUP_B } from './cases/group-b.ts';
import { scenarioSuite } from './suite.ts';

scenarioSuite(
  'imported',
  'imported material',
  GROUP_B.filter((s) => s.family === 'imported material'),
);
