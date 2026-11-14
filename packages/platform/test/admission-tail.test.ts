// A Stop's children are stopped before its admission ends; their saves finish after it. A failure
// meanwhile must not surface as an unhandled rejection that can end the Host, and the caller's
// Stop must still report it (confirmation review of M1, 14 Nov 2026).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deferPastAdmission, withAdmissionTail } from '../src/composition/admission-tail.ts';

test('a child-stop failure during the admission commit wait is observed at once and still rejects the Stop', async () => {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', listener);
  try {
    const stop = withAdmissionTail(true, async () => {
      // The handler starts the children's stop; its save fails before the admission commits.
      const childrenStopped = Promise.reject(new Error('child journal append failed'));
      const deferred = deferPastAdmission(async () => { await childrenStopped; return { ok: true }; }, childrenStopped);
      // The admission's COMMIT and release take I/O turns.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return deferred;
    });
    await assert.rejects(stop, /child journal append failed/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', listener); }
});
