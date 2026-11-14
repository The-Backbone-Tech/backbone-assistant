import { GROUP_A } from './cases/group-a.ts';
import { scenarioSuite } from './suite.ts';

scenarioSuite(
  'knowledge-poisoning',
  'knowledge poisoning',
  GROUP_A.filter((s) => s.family === 'knowledge poisoning'),
);
