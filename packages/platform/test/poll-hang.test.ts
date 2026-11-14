import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
import { pollUntil } from './helpers.ts';

test('a stalled state poll rejects and stops reading after its hang diagnostic', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  const pending = pollUntil(async active => {
    while (active()) {
      reads++;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }, 'injected product state never settles');
  const rejected = assert.rejects(pending, /injected product state never settles.*hang detector/);
  t.mock.timers.tick(TEST_HANG_MS);
  await rejected;
  const stoppedAt = reads;
  t.mock.timers.tick(25);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(reads, stoppedAt, 'a failed test leaves no orphan polling loop');
});
