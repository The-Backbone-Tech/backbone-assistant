import { describe, expect, it } from 'vitest';
import { guarded } from './harness.ts';
import { LIFECYCLE_LESSONS } from './lessons.ts';
import { openLifecycleStub } from './stub.ts';

/**
 * Each lifecycle lesson case passes on a correct stub and fails, on an assertion, on the same stub
 * with exactly that lesson's mistake switched on (behind the same guard as the target).
 */
describe('every lifecycle lesson case fails on a deliberately wrong stub, and only because of its flaw', () => {
  for (const lesson of LIFECYCLE_LESSONS) {
    it(`${lesson.id}: passes on the correct stub`, async () => {
      await lesson.run(guarded(openLifecycleStub()));
    });
    it(`${lesson.id}: fails on the stub with ${lesson.flaw}`, async () => {
      const outcome = await lesson.run(guarded(openLifecycleStub(lesson.flaw))).then(
        () => null,
        (error: Error) => error,
      );
      expect(outcome, 'the lesson case passed on the flawed stub').not.toBeNull();
      expect(outcome?.name, String(outcome)).toBe('AssertionError');
    });
  }
});
