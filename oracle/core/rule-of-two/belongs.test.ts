import { describe, expect, it } from 'vitest';
import { addPerson, propose, recordSource, refused, useTarget } from '../harness.ts';
import { connect, documentOf, marks, newTask, privateWorld, uuid } from './fixtures.ts';

const target = useTarget('rule-of-two.belongs');

describe('a document an effect writes goes into the task its arguments name', () => {
  it('[S8] the dispatcher cannot write a new document anywhere else (P3-4)', async () => {
    const w = await privateWorld(target(), 'WhereItGoes');
    const other = await newTask(w.owner$, w.owner, 'Other');
    const doc = uuid();
    const id = await propose(w, {
      operation: 'workspace.write_document',
      args: { document_id: doc, title: 'Notes', content: 'x', task_id: w.task },
      description: 'Write “Notes”',
    });
    const claimToken = await w.system$.call<string>('effect.claim', { effect: id, leaseMs: 30_000 });
    await w.system$.call('effect.begin_dispatch', { effect: id, claim: claimToken });
    const write = (task: string | null) =>
      w.system$.call('r2.document.dispatch_write', {
        document: doc,
        task,
        title: 'Notes',
        content: 'x',
        effect: id,
        create: true,
      });
    await refused(write(other), 'invalid');
    await refused(write(null), 'invalid');
    expect(await w.owner$.observe('r2.document', { id: doc })).toEqual([]);
    await write(w.task);
    expect(await documentOf(w.owner$, doc)).toMatchObject({ task: w.task });
  });
});

describe('the database decides where a recorded source belongs and whose words it holds (P3-5)', () => {
  it('[S6] a run reads no source its person cannot see; a person is claimed as author only where they could have written', async () => {
    const w = await privateWorld(target(), 'WhoWrote');
    const colleague = await addPerson(w, 'Colleague');
    const theirs = await newTask(colleague.$, colleague.id, 'Theirs');
    // A run of the owner's worker is not given a source from a task its person cannot see.
    await refused(
      recordSource(w, 'Their notes.', colleague.id, { run: w.run, task: theirs, ref: 'drive://theirs' }),
      'denied',
    );
    expect(await marks(w, w.run)).toMatchObject({ untrusted: false, sensitive: false });
    // Words are the colleague's only where the colleague could have written them.
    await refused(
      recordSource(w, 'Marta’s notes.', colleague.id, { task: w.task, ref: 'drive://notes' }),
      'invalid',
    );
    await recordSource(w, 'Their notes.', colleague.id, { task: theirs, ref: 'drive://theirs' });
    // A server's answer belongs to the task of the run that read it, whatever the recorder states.
    const crm = await connect(w.owner$, 'CRM', 'crm', 'workspace');
    const answered = await w.system$.call<string>('r2.source.server_answer', {
      run: w.run,
      connection: crm,
      slug: 'crm',
      tool: 'get_deal',
      content: 'Deal 42.',
      statesTask: false,
    });
    expect(await w.owner$.observe('r2.source', { id: answered })).toMatchObject([{ task: w.task }]);
  });
});
