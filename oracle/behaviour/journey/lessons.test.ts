import { describe, expect, it } from 'vitest';
import { useBehaviour } from '../harness.ts';
import { JOURNEY_LESSONS } from './cases.ts';
import { openJourneyStub } from './stub.ts';

const target = useBehaviour('journey.lessons');

/**
 * The journey's lessons (transition-lists §3, lessons 6, 7, 8 and 14 on this surface). Each case
 * passes on a correct in-memory stub of the port and fails, on an assertion, with exactly its
 * lesson's flaw switched on; then it runs against the target, as an expected failure where the
 * target does not keep the lesson.
 */
describe('journey lessons fail first on a deliberately wrong stub, and only because of their flaw', () => {
  for (const lesson of JOURNEY_LESSONS) {
    it(`${lesson.id}: passes on the correct stub`, async () => {
      await lesson.run(openJourneyStub());
    });
    it(`${lesson.id}: fails on the stub with ${lesson.flaw}`, async () => {
      const outcome = await lesson.run(openJourneyStub(lesson.flaw)).then(
        () => null,
        (error: Error) => error,
      );
      expect(outcome, 'the lesson case passed on the flawed stub').not.toBeNull();
      expect(outcome?.name).toBe('AssertionError');
    });
  }
});

describe('journey lessons, against the target', () => {
  for (const lesson of JOURNEY_LESSONS) {
    const deviates =
      lesson.legacyDeviation !== undefined && (process.env.ORACLE_TARGET ?? 'legacy') === 'legacy';
    (deviates ? it.fails : it)(
      `${lesson.id} ${lesson.title}${deviates ? ' (known legacy deviation)' : ''}`,
      () => lesson.run(target().journeys),
    );
  }
});
