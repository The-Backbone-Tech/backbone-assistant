import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { AgentPlan, Journey, JourneyPort, SaveTicket, WriteView } from './port.ts';
import { hold } from './port.ts';

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A thread whose agent wrote a brief (version 1). */
export async function briefThread(j: Journey, tag: string) {
  const title = `Brief ${tag}`;
  const v1 = `# ${title}\n\nNorth leads with 120; South follows with 80.\n`;
  const { thread } = await j.ask({
    message: `Write an editable brief ${tag}.`,
    agent: { write: { title, content: v1 }, answer: `Saved ${title}.` },
  });
  const done = await j.settled(thread, 1);
  const id = done.writes[0]?.document;
  if (done.writes[0]?.status !== 'succeeded' || id === undefined)
    throw new Error(`the brief was not written: ${JSON.stringify(done)}`);
  return { thread, id, title, v1 };
}

/**
 * A brief the person has edited and saved (version 2), and the agent edit the next message asks
 * for (version 3 if it lands): the subject of every agent-write case.
 */
export async function editableBrief(j: Journey, tag: string) {
  const b = await briefThread(j, tag);
  const v2 = `${b.v1}\nPerson's correction ${tag}.\n`;
  const ticket = await j.prepareSave(b.id, { title: b.title, content: v2, expectedVersion: 1 });
  const saved = await j.save(ticket);
  if (saved.status !== 'accepted')
    throw new Error(`the person's Save did not land: ${JSON.stringify(saved)}`);
  const v3 = `${v2}\nAgent edit ${tag}: the reporting period is Q3.\n`;
  const edit: AgentPlan = {
    read: [b.title],
    write: { title: b.title, content: v3, document: b.id, version: 2 },
    answer: `Applied the edit to ${b.title}.`,
  };
  return { ...b, v2, v3, edit };
}

/** How many kept versions carry exactly these words: the harmful effect of a resent write. */
export async function applied(j: Journey, id: string, content: string): Promise<number> {
  return (await j.document(id)).versions.filter((v) => v.content === content).length;
}

/** A write's stated outcome agrees with the document: done once, not done, or unknown and not resent. */
export async function coherentWrite(j: Journey, id: string, content: string, write: WriteView | undefined) {
  expect(write, 'the write is not listed').toBeDefined();
  expect(write?.status, 'the write is still in progress').not.toBe('pending');
  const times = await applied(j, id, content);
  if (write?.status === 'succeeded') expect(times, 'a succeeded write is not in the document once').toBe(1);
  else if (write?.status === 'unknown')
    expect(times, 'an unknown write was sent again').toBeLessThanOrEqual(1);
  else expect(times, `a ${write?.status} write is in the document`).toBe(0);
}

/**
 * After a Save the service may not have finished: exactly one of version 1 and version 2 exists,
 * the target says which, and continuing the Save lands it exactly once (never a version 3).
 */
export async function coherentSave(
  j: Journey,
  b: { id: string; v1: string },
  v2: string,
  ticket: SaveTicket,
) {
  const doc = await j.document(b.id);
  const state = await j.saveState(ticket);
  if (state.status === 'accepted') {
    expect(state.version).toBe(2);
    expect(doc, 'the target says saved, the document disagrees').toMatchObject({
      version: 2,
      content: v2,
      by: 'person',
    });
    expect(doc.versions.map((v) => v.content)).toEqual([b.v1, v2]);
  } else {
    expect(state.status, 'the target cannot say what became of the Save').toBe('prepared');
    expect(doc, 'the target says not saved, the document disagrees').toMatchObject({
      version: 1,
      content: b.v1,
    });
    expect(doc.versions).toHaveLength(1);
  }
  const again = await j.save(ticket);
  expect(['accepted', 'retired'], `continuing the Save: ${JSON.stringify(again)}`).toContain(again.status);
  if (again.status === 'accepted') expect(again.version).toBe(2);
  const after = await j.document(b.id);
  expect(after, 'continuing the Save did not leave exactly version 2').toMatchObject({
    version: 2,
    content: v2,
    by: 'person',
  });
  expect(after.versions.map((v) => v.content)).toEqual([b.v1, v2]);
}

/** A journey lesson (transition-lists §3) on this surface, run on a target and on the stub. */
export interface JourneyLesson {
  readonly id: string;
  readonly lesson: number;
  readonly title: string;
  readonly flaw: JourneyFlaw;
  /** Set when legacy does not keep the lesson: what it does instead. */
  readonly legacyDeviation?: string;
  run(port: JourneyPort): Promise<void>;
}

export type JourneyFlaw =
  | 'L6-recovery-resends'
  | 'L7-key-only-dedupe'
  | 'L8-no-recheck-before-send'
  | 'L14-reported-not-stored';

async function opened(port: JourneyPort, label: string, run: (j: Journey, tag: string) => Promise<void>) {
  const tag = randomUUID().slice(0, 6);
  const j = await port.open(`${label}-${tag}`);
  try {
    await run(j, tag);
  } finally {
    await j.close();
  }
}

/** Kill the service at the moment the agent's edit has begun, then bring it back. */
async function killedMidWrite(j: Journey, tag: string) {
  const b = await editableBrief(j, tag);
  await j.start({ crashAt: 'write.begun' });
  await j.followUp(b.thread, `Apply the reporting-period edit ${tag}.`, b.edit);
  expect(await j.crashed(), 'the armed service did not die at the write').toBe(true);
  await j.start();
  const after = await j.settled(b.thread, 2);
  return { b, original: after.writes.at(-1) };
}

export const JOURNEY_LESSONS: readonly JourneyLesson[] = [
  {
    id: 'J-L6',
    lesson: 6,
    title: '[O1][S8] recovery after a kill mid-write sorts the write first and never sends it again',
    flaw: 'L6-recovery-resends',
    run: (port) =>
      opened(port, 'l6', async (j, tag) => {
        const { b, original } = await killedMidWrite(j, tag);
        await coherentWrite(j, b.id, b.v3, original);
        const kept = await applied(j, b.id, b.v3);
        // Another restart, and time for anything queued: nothing more goes out.
        await j.restart();
        await sleep(2_000);
        expect(await applied(j, b.id, b.v3), 'a later recovery sent the write again').toBe(kept);
        expect((await j.thread(b.thread)).writes.at(-1)).toEqual(original);
      }),
  },
  {
    id: 'J-L7',
    lesson: 7,
    title: '[S8] the exact copy of a write interrupted by a kill, under a new key, is never applied twice',
    flaw: 'L7-key-only-dedupe',
    run: (port) =>
      opened(port, 'l7', async (j, tag) => {
        const { b, original } = await killedMidWrite(j, tag);
        await j.followUp(b.thread, `Write that same edit again ${tag}.`, b.edit);
        const later = await j.settled(b.thread, 3);
        const copy = later.writes.at(-1);
        expect(copy?.id).not.toBe(original?.id);
        expect(await applied(j, b.id, b.v3), 'the exact copy was applied as well').toBeLessThanOrEqual(1);
        if (original?.status === 'unknown' || original?.status === 'succeeded')
          expect(copy?.status, 'the copy of an unknown or done write was let through').not.toBe('succeeded');
      }),
  },
  {
    id: 'J-L8',
    lesson: 8,
    title: '[S8] a Stop that lands while the agent’s write waits is honoured before the write is sent',
    flaw: 'L8-no-recheck-before-send',
    run: (port) =>
      opened(port, 'l8', async (j, tag) => {
        const b = await editableBrief(j, tag);
        const h = hold();
        await j.followUp(b.thread, `Apply the reporting-period edit ${tag}.`, { ...b.edit, hold: h });
        await h.reached;
        expect(await j.stop(b.thread), 'the target says nothing was at work').toBe(true);
        h.release();
        await sleep(2_000);
        await j.settled(b.thread, 1);
        expect(await applied(j, b.id, b.v3), 'the stopped write was sent').toBe(0);
        const after = await j.thread(b.thread);
        expect(after.writes.slice(1).filter((w) => w.status === 'succeeded')).toEqual([]);
        await j.restart();
        await sleep(2_000);
        expect(await applied(j, b.id, b.v3), 'the stopped write was sent after a restart').toBe(0);
      }),
  },
  {
    id: 'J-L14',
    lesson: 14,
    title: '[O1] a Save cut by a kill is judged by the versions stored, not by what the target reports',
    flaw: 'L14-reported-not-stored',
    run: (port) =>
      opened(port, 'l14', async (j, tag) => {
        const b = await briefThread(j, tag);
        const v2 = `${b.v1}\nPerson's correction ${tag}.\n`;
        const ticket = await j.prepareSave(b.id, { title: b.title, content: v2, expectedVersion: 1 });
        // Late enough that the Save has landed: the kill takes only its answer.
        await j.saveThenKill(ticket, 400);
        await j.start();
        await coherentSave(j, b, v2, ticket);
      }),
  },
];
