import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TEST_HANG_MS } from '../../../../scripts/lib/test-hang.ts';
import { waitForSampleInbox } from '../e2e/triage-progress.ts';

test('inbox completion retains the 47-request property', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let counts = '11 requests · 6 drafted';
  const pending = waitForSampleInbox(async () => counts);
  await Promise.resolve(); await Promise.resolve();
  counts = '47 requests · 28 drafted';
  t.mock.timers.tick(25);
  await pending;
});

test('a stalled inbox rejects with its pending property and last visible counts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = waitForSampleInbox(async () => '11 requests · 6 drafted', () => 'model requests: 19');
  const rejected = assert.rejects(pending, error => error instanceof Error
    && /sample inbox completes all 47 requests/.test(error.message)
    && /11 requests · 6 drafted/.test(error.message)
    && /model requests: 19/.test(error.message));
  await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(TEST_HANG_MS * 3);
  await rejected;
});
