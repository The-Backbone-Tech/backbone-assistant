import { TEST_HANG_MS, waitFor } from '../../../../scripts/lib/test-hang.ts';

// The sample inbox is serial model/receipt work, not a throughput benchmark. Keep the
// completion property and the last visible progress when the generous hang guard trips.
export async function waitForSampleInbox(readCounts: () => Promise<string>, diagnostic: () => string = () => '') {
  let counts = '';
  await waitFor(async () => {
    counts = await readCounts();
    return counts.includes('47 requests');
  }, 'sample inbox completes all 47 requests', {
    hangMs: TEST_HANG_MS * 3,
    diagnostic: () => `last visible brief counts: ${counts}; ${diagnostic()}`,
  });
}
