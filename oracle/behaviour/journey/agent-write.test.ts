import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useBehaviour } from '../harness.ts';
import { applied, coherentWrite, editableBrief, sleep } from './cases.ts';
import type { CrashPoint, Journey } from './port.ts';

const target = useBehaviour('journey.agent-write');
const legacy = (process.env.ORACLE_TARGET ?? 'legacy') === 'legacy';

/** Every point of the agent's write where the service can die. */
const CRASH_POINTS: readonly CrashPoint[] = [
  'write.proposed',
  'write.claimed',
  'write.begun',
  'write.recorded',
];

/** A reconciliation can wait for a lease and its grace period (legacy: 30 s after the lease). */
const SETTLE_MS = 120_000;

/**
 * J-01 A2 through the API, the kill half: the service dies at each point of the agent's edit of
 * the brief. Afterwards the write's outcome is stated and agrees with the document, it is never
 * sent again (not by recovery, not by a later restart), and an exact copy under a new key never
 * changes the document a second time. A Stop during the write is in stop.test.ts.
 */
describe('[O1][S8] A2: the service dies during the agent’s write', () => {
  let j: Journey;
  const outcomes: string[] = [];
  beforeAll(async () => {
    j = await target().journeys.open(`agent-write-${randomUUID().slice(0, 6)}`);
  });
  afterAll(async () => {
    if (outcomes.length > 0) console.info(`A2 crash outcomes: ${outcomes.join(', ')}`);
    await j?.close();
  });

  for (const point of CRASH_POINTS) {
    it(`[O1][S8] killed at ${point}: the outcome is stated and true, never resent, and its exact copy is not applied twice`, async () => {
      const tag = randomUUID().slice(0, 6);
      const b = await editableBrief(j, tag);
      await j.start({ crashAt: point });
      await j.followUp(b.thread, `Apply the reporting-period edit ${tag}.`, b.edit);
      expect(await j.crashed(), 'the armed service did not die at its point').toBe(true);
      await j.start();
      const after = await j.settled(b.thread, 2, SETTLE_MS);
      const original = after.writes.at(-1);
      outcomes.push(`${point} → ${original?.status}`);
      expect(after.writes, 'the replayed step proposed its write twice').toHaveLength(2);
      await coherentWrite(j, b.id, b.v3, original);
      const once = await applied(j, b.id, b.v3);

      await j.restart();
      await sleep(2_000);
      expect(await applied(j, b.id, b.v3), 'a later recovery sent the write again').toBe(once);
      expect((await j.thread(b.thread)).writes.at(-1)).toEqual(original);

      await j.followUp(b.thread, `Write that same edit again ${tag}.`, b.edit);
      const later = await j.settled(b.thread, 3, SETTLE_MS);
      const copy = later.writes.at(-1);
      expect(copy?.id).not.toBe(original?.id);
      expect(await applied(j, b.id, b.v3), 'the exact copy was applied as well').toBeLessThanOrEqual(1);
      if (original?.status === 'unknown' || original?.status === 'succeeded')
        expect(copy?.status, 'the copy of an unknown or done write was let through').not.toBe('succeeded');
    });
  }

  // J-01 A2 says the outcome shows UNKNOWN. Legacy keeps an interrupted internal write as
  // "dispatching" until its lease and a 30 s grace pass, then inspects the document history and
  // settles it (succeeded or failed); an internal write is never `unknown`.
  (legacy ? it.fails : it)(
    '[S8] killed once the write has begun: after the restart the outcome reads unknown or settled, never still in progress (known legacy deviation)',
    async () => {
      const tag = randomUUID().slice(0, 6);
      const b = await editableBrief(j, tag);
      await j.start({ crashAt: 'write.begun' });
      await j.followUp(b.thread, `Apply the reporting-period edit ${tag}.`, b.edit);
      expect(await j.crashed()).toBe(true);
      await j.start();
      const first = (await j.thread(b.thread)).writes.at(-1);
      try {
        expect(first?.status, 'the interrupted write reads as still in progress').not.toBe('pending');
      } finally {
        // Leave the installation quiet for whatever runs next.
        await j.settled(b.thread, 2, SETTLE_MS).catch(() => undefined);
      }
    },
  );
});
