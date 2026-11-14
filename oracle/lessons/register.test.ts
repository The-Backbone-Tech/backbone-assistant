import { describe, it } from 'vitest';
import { useTarget } from '../core/harness.ts';
import { LESSONS } from './cases.ts';

const target = useTarget('lessons.register');

/**
 * Against the legacy repository a lesson case either holds, or, where the repository does not keep
 * the lesson, is run as an expected failure: it stays green while the deviation is there and turns
 * red the day it is fixed, so the register is updated rather than silently outdated.
 */
describe('the lessons register, against the target', () => {
  for (const lesson of LESSONS) {
    const run = lesson.legacyDeviation && (process.env.ORACLE_TARGET ?? 'legacy') === 'legacy' ? it.fails : it;
    run(`${lesson.id} ${lesson.title}${lesson.legacyDeviation ? ' (known legacy deviation)' : ''}`, () => lesson.run(target()));
  }
});
