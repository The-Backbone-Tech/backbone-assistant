import { describe, expect, it } from 'vitest';
import { type Id, Refusal, type Session } from '../../target.ts';
import { addPerson, issue, newWorld, refused, startRun, useTarget } from '../harness.ts';

const target = useTarget('promotion.memory');

/** Memory a session reads directly. */
const read = async (session: Session) =>
  (await session.observe<{ content: string }>('memory')).map((m) => m.content);
/** How many memories a recall returns; a refused recall returns none. */
const count = (recall: Promise<unknown[]>) =>
  recall.then(
    (rows) => rows.length,
    (error: unknown) => {
      if (error instanceof Refusal) return 0;
      throw error;
    },
  );

describe('memory stays with its person', () => {
  it('when a run acts, the database decides whose memory it may read — not the session settings', async () => {
    const w = await newWorld(target(), 'Memory');
    await w.owner$.call('memory.write', {
      owner: w.owner,
      agent: w.agent,
      content: 'Private: prefers calls after 16:00.',
    });
    const colleague = await addPerson(w, 'Colleague');
    expect(await read(colleague.$)).toEqual([]);
    // The run working for the owner, holding its secret, recalls the owner's memory — and only so.
    expect(await count(w.agent$.call('memory.recall', { run: w.run }))).toBe(1);
    expect(
      await count(colleague.$.call('pro.memory_recall_claiming', { run: w.run, secret: w.secret })),
    ).toBe(1);
    expect(await read(w.agent$)).toEqual([]);
    // Naming the run without its secret recalls nothing, whatever principal the session claims.
    expect(await count(colleague.$.call('pro.memory_recall_claiming', { run: w.run }))).toBe(0);
    expect(await count(w.owner$.call('pro.memory_recall_claiming', { run: w.run }))).toBe(0);
    // A run working for the colleague cannot see the owner's memory, and can write only the colleague's.
    const helper = await colleague.$.call<Id>('agent.create', { name: 'Helper' });
    const theirs = await startRun(
      w.t,
      w.ws,
      colleague.$,
      colleague.id,
      await issue(colleague.$, helper),
      helper,
    );
    expect(await count(theirs.$.call('memory.recall', { run: theirs.run }))).toBe(0);
    await refused(
      theirs.$.call('pro.memory_write', { owner: w.owner, agent: helper, content: 'Injected' }),
      'denied',
    );
    await theirs.$.call('pro.memory_write', {
      owner: colleague.id,
      agent: helper,
      content: 'Remembered: prefers email.',
    });
    expect(await read(colleague.$)).toEqual(['Remembered: prefers email.']);
    expect(await read(w.owner$)).toEqual(['Private: prefers calls after 16:00.']);
  });

  it('[S12] forgetting erases the content and cannot be undone; only the person forgets', async () => {
    const w = await newWorld(target(), 'Forget');
    const id = await w.owner$.call<Id>('memory.write', {
      owner: w.owner,
      agent: w.agent,
      content: 'Allergic to shellfish.',
    });
    await refused(w.agent$.call('memory.forget', { memory: id }), 'someone_else');
    expect(await w.owner$.observe('pro.memory', { id })).toEqual([
      { id, owner: w.owner, content: 'Allergic to shellfish.', forgotten: false },
    ]);
    await w.owner$.call('memory.forget', { memory: id });
    expect(await w.owner$.observe('pro.memory', { id })).toEqual([
      { id, owner: w.owner, content: '', forgotten: true },
    ]);
    await refused(w.owner$.call('memory.forget', { memory: id }), 'not_found');
  });
});
