import { GROUP_C } from './cases/group-c.ts';
import { scenarioSuite } from './suite.ts';

scenarioSuite(
  'channels',
  'channels',
  GROUP_C.filter((s) => s.family === 'channels'),
);
