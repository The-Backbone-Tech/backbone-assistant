import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useBehaviour } from '../harness.ts';
import { material, sha256 } from './fixtures.ts';
import type { Journey } from './port.ts';

const target = useBehaviour('journey.brief');

/**
 * J-01 phases 2, 3, 5, 7 and 8 through the API, in order, on one installation: attach a note and
 * a workbook, ask for an editable brief, edit it and Save, restart the service, follow up.
 */
describe('J-01: one thread, one brief, a human edit, a restart, a follow-up', () => {
  const tag = randomUUID().slice(0, 6);
  const m = material(tag);
  const brief = `Brief ${tag}`;
  const v1 = `# ${brief}\n\nNorth leads with 120; South follows with 80.\n`;
  const v2 = `${v1}\nPerson's correction ${tag}: confirm the reporting period before Friday.\n`;
  let j: Journey;
  let thread = '';
  let project = '';
  let attachments: readonly string[] = [];
  let briefId = '';

  beforeAll(async () => {
    j = await target().journeys.open(`brief-${tag}`);
  });
  afterAll(async () => {
    await j?.close();
  });

  it('[V1] phase 2: a project, a note and a workbook are attached; the original bytes are kept', async () => {
    project = await j.createProject(`Friday review ${tag}`);
    const asked = await j.ask({
      message: `Read my note and the workbook, then write an editable brief ${tag}.`,
      project,
      material: { note: m.note, spreadsheet: m.spreadsheet },
      agent: {
        read: [m.note.title, m.spreadsheet.name],
        write: { title: brief, content: v1 },
        answer: `Saved ${brief}.`,
      },
    });
    thread = asked.thread;
    attachments = asked.attachments;
    expect((await j.thread(thread)).project).toBe(project);
    expect(attachments).toHaveLength(2);
    const workbook = await j.document(attachments[1] ?? '');
    expect(workbook.original).toEqual({
      filename: m.spreadsheet.name,
      sha256: sha256(m.spreadsheet.bytes),
      byteLength: m.spreadsheet.bytes.byteLength,
    });
    expect(sha256(await j.original(workbook.id, workbook.version))).toBe(sha256(m.spreadsheet.bytes));
  });

  it('[V1] phase 3: the agent, given the note and the workbook, writes the brief as version 1, asking nothing', async () => {
    const done = await j.settled(thread, 1);
    expect(done.writes.map((w) => w.status)).toEqual(['succeeded']);
    expect(done.questions).toBe(0);
    briefId = done.writes[0]?.document ?? '';
    const written = await j.document(briefId);
    expect(written).toMatchObject({ title: brief, version: 1, content: v1, by: 'agent' });
    // Judged by what the agent was given, not by what it said.
    const given = j
      .seen()
      .map((s) => s.text)
      .join('\n');
    expect(given).toContain(m.note.text);
    expect(given).toContain(m.cell);
  });

  it('[O5] phase 5: the person edits the brief and Saves; version 2 is the person’s, version 1 is kept', async () => {
    const ticket = await j.prepareSave(briefId, { title: brief, content: v2, expectedVersion: 1 });
    expect(await j.save(ticket)).toEqual({ status: 'accepted', version: 2 });
    const saved = await j.document(briefId);
    expect(saved).toMatchObject({ version: 2, content: v2, by: 'person' });
    expect(saved.versions.map(({ version, by, content }) => ({ version, by, content }))).toEqual([
      { version: 1, by: 'agent', content: v1 },
      { version: 2, by: 'person', content: v2 },
    ]);
    // The file list shows version 2 at once, without a restart.
    expect((await j.documents()).find((d) => d.id === briefId)?.version).toBe(2);
  });

  it('[O1] phase 7: after a clean restart the thread, the brief and its versions are as they were', async () => {
    const before = await j.thread(thread);
    await j.restart();
    const after = await j.thread(thread);
    expect(after.answers).toEqual(before.answers);
    expect(after.writes).toEqual(before.writes);
    expect(after.project).toBe(project);
    expect((await j.document(briefId)).versions.map((v) => v.version)).toEqual([1, 2]);
  });

  it('phase 8: a follow-up in the same thread gives the agent version 2', async () => {
    const asked = j.seen().length;
    await j.followUp(thread, `What does the brief ${tag} say now?`, { read: [brief], answer: 'Read it.' });
    await j.settled(thread, 2);
    const given = j.seen().slice(asked);
    const reads = given.flatMap((s) => s.documents).filter((d) => d.id === briefId.toLowerCase());
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((d) => d.version === 2 && d.content === v2)).toBe(true);
    expect((await j.document(briefId)).version).toBe(2);
  });
});
