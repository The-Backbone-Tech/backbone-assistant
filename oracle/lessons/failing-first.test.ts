import { describe, expect, it } from 'vitest';
import { openStub } from '../adapters/stub/index.ts';
import { LESSONS } from './cases.ts';

/**
 * Each lesson case passes on a correct stub and fails, on an assertion, on the same stub with
 * exactly that lesson's mistake switched on. The pair shows the case catches the mistake itself.
 */
describe('every lesson case fails on a deliberately wrong stub, and only because of its flaw', () => {
  for (const lesson of LESSONS) {
    it(`${lesson.id}: passes on the correct stub`, async () => {
      await lesson.run(openStub());
    });
    it(`${lesson.id}: fails on the stub with ${lesson.flaw}`, async () => {
      const outcome = await lesson.run(openStub(lesson.flaw)).then(
        () => null,
        (error: Error) => error,
      );
      expect(outcome, 'the lesson case passed on the flawed stub').not.toBeNull();
      // An assertion of the case, not a missing binding or a crash.
      expect(outcome?.name).toBe('AssertionError');
    });
  }
});
