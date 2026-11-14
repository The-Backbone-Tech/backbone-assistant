// 10 November 2026: desktop ending uses the ownership-only stored Host method and its local acknowledgement; refusal and uncertainty stay explicit.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Host } from '@backbone-next/platform/composition';
import { endConnectorSignature } from '../electron/end-signature.ts';

const hostWith = (call: (...args: unknown[]) => Promise<unknown>) => ({ endConnectorSignature: call }) as unknown as Pick<Host, 'endConnectorSignature'>;
test('desktop ending accepts only server/tool strings and always sends the reduce-only command', async () => {
  const calls: unknown[][] = [];
  const receipt = { ok: true, value: { ended: true } };
  const host = hostWith(async (...args) => { calls.push(args); return receipt; });
  for (const [server, tool] of [[{}, 'tool'], ['server', { standing: true }], ['', 'tool'], ['server', null], ['x'.repeat(1025), 'tool'], ['server', 'x'.repeat(1025)]]) {
    assert.equal((await endConnectorSignature(host, server, tool)).ok, false);
  }
  assert.deepEqual(calls, []);
  assert.equal(await endConnectorSignature(host, 'server', 'tool'), receipt);
  assert.deepEqual(calls, [['server', 'tool']]);
});
test('desktop ending returns an uncertain receipt with the exact Host diagnostic instead of rejecting IPC', async () => {
  const detail = 'The permission end could not be confirmed. Local authority stays closed and its receipt will be retried. Run backbone doctor.';
  for (const error of [new Error(detail), new Error('private backend failure'), 'private backend failure', null]) {
    const result = await endConnectorSignature(hostWith(async () => { throw error; }), 'server', 'tool');
    assert.deepEqual(result, { ok: false, reason: 'NOT_AVAILABLE', outcome: 'UNKNOWN', detail });
  }
});
test('a Host refusal remains a refusal, with no success or diagnostic rewriting', async () => {
  const refusal = { ok: false, reason: 'NOT_AVAILABLE', outcome: 'REFUSED', detail: 'This data home was opened read-only.' };
  assert.equal(await endConnectorSignature(hostWith(async () => refusal), 'server', 'tool'), refusal);
});
