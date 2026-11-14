import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useBehaviour } from '../harness.ts';
import { applied, coherentWrite, editableBrief, sleep } from './cases.ts';
import type { Journey } from './port.ts';

const target = useBehaviour('journey.stop');

/** Milliseconds between the follow-up and the person's Stop. */
const STOP_TIMINGS = [0, 25, 100, 400, 800, 1_100, 1_500] as const;

/**
 * J-01 A2 through the API, the Stop half: the person presses Stop while the agent edits the
 * brief, at several timings (Stop while the write is held is lesson J-L8). Whatever the timing,
 * the write's outcome is stated and agrees with the document, and nothing is sent afterwards —
 * not when the run winds down, not after a restart.
 */
describe('[S8] A2: the person stops the agent during its write', () => {
  let j: Journey;
  const outcomes: string[] = [];
  beforeAll(async () => {
    j = await target().journeys.open(`stop-${randomUUID().slice(0, 6)}`);
  });
  afterAll(async () => {
    if (outcomes.length > 0) console.info(`A2 stop outcomes: ${outcomes.join(', ')}`);
    await j?.close();
  });

  for (const ms of STOP_TIMINGS) {
    it(`[S8] stopped ${ms} ms into the edit: a stated, true outcome, and nothing sent afterwards`, async () => {
      const tag = randomUUID().slice(0, 6);
      const b = await editableBrief(j, tag);
      await j.followUp(b.thread, `Apply the reporting-period edit ${tag}.`, b.edit);
      if (ms > 0) await sleep(ms);
      const stopped = await j.stop(b.thread);
      await sleep(1_000);
      const after = await j.settled(b.thread, 1);
      const edit = after.writes[1];
      outcomes.push(`${ms} ms → ${stopped ? 'stopped' : 'nothing at work'}, ${edit?.status ?? 'no write'}`);
      expect(after.writes.length, 'the edit was proposed more than once').toBeLessThanOrEqual(2);
      if (edit) await coherentWrite(j, b.id, b.v3, edit);
      else expect(await applied(j, b.id, b.v3)).toBe(0);
      if (!stopped)
        expect(edit?.status, 'Stop found nothing at work, yet the edit is not done').toBe('succeeded');
      const once = await applied(j, b.id, b.v3);

      await j.restart();
      await sleep(2_000);
      expect(await applied(j, b.id, b.v3), 'the stopped write was sent after a restart').toBe(once);
      expect((await j.thread(b.thread)).writes).toEqual(after.writes);
    });
  }
});
