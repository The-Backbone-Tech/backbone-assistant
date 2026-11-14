import { describe } from 'vitest';
import { itKeeps, useHomes } from './harness.ts';
import { LIFECYCLE_LESSONS } from './lessons.ts';

const homes = useHomes('lessons');

/** The lifecycle lessons against the target; a known legacy deviation runs as an expected failure. */
describe('the lifecycle lessons, against the target', () => {
  for (const lesson of LIFECYCLE_LESSONS) {
    itKeeps(`${lesson.id} ${lesson.title}`, lesson.legacyDeviation, () => lesson.run(homes()));
  }
});
