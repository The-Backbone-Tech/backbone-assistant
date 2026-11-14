import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { useBehaviour } from '../harness.ts';
import { briefThread, coherentSave } from './cases.ts';
import type { Journey } from './port.ts';

const target = useBehaviour('journey.save-kill');

/** Milliseconds between the Save request leaving and the SIGKILL: before, during and after the commit. */
const KILL_TIMINGS = [0, 1, 3, 6, 12, 25, 50, 100, 400] as const;

/**
 * J-01 A1 through the API: the service process is killed while a Save is on its way, at several
 * timings. Every time, exactly one of version 1 and version 2 exists, coherently; the target says
 * which by the Save's own identity; and continuing the Save lands it exactly once.
 */
describe('[O1] A1: the service is killed during a Save', () => {
  let j: Journey;
  const outcomes: string[] = [];
  beforeAll(async () => {
    j = await target().journeys.open(`save-kill-${randomUUID().slice(0, 6)}`);
  });
  afterAll(async () => {
    // Which side of the commit each kill fell on (for the results report; not an assertion).
    if (outcomes.length > 0) console.info(`A1 kill timings: ${outcomes.join(', ')}`);
    await j?.close();
  });

  for (const ms of KILL_TIMINGS) {
    it(`[O1] killed ${ms} ms after Save: exactly one of v1 and v2, the target says which, and Save lands once`, async () => {
      const tag = randomUUID().slice(0, 6);
      const b = await briefThread(j, tag);
      const v2 = `${b.v1}\nPerson's correction ${tag}.\n`;
      const ticket = await j.prepareSave(b.id, { title: b.title, content: v2, expectedVersion: 1 });
      await j.saveThenKill(ticket, ms);
      await j.start();
      outcomes.push(`${ms} ms → ${(await j.saveState(ticket)).status}`);
      await coherentSave(j, b, v2, ticket);
    });
  }
});
