import { describe, expect, it } from 'vitest';
import { addPerson, newWorld, refused, useTarget } from '../harness.ts';
import { accepted, entries, knowledge } from './fixtures.ts';

// Answering takes the question from the installation-wide verification queue: this file holds only this case's work.
const target = useTarget('promotion.retraction-authority');

describe('knowledge correction holds fresh authority through commit', () => {
  it('the exact owner corrects its knowledge after a guest downgrade, without granting a downgraded nonowner the same right', async () => {
    const w = await newWorld(target(), 'Exact ownership');
    const person = await addPerson(w, 'Steward');
    const stranger = await addPerson(w, 'Other administrator', 'admin');
    const first = await accepted(w, person.id);
    const second = await accepted(w, person.id);
    const retractions = async (id: string) => (await entries(w.owner$, id, 'knowledge.retracted')).length;

    await w.owner$.call('pro.change_role', { person: person.id, role: 'guest' });
    await person.$.call('knowledge.retract', { knowledge: first, reason: 'Guest exact owner' });
    expect(await knowledge(w, first)).toMatchObject({
      status: 'retracted',
      retractedReason: 'Guest exact owner',
    });
    expect(await retractions(first)).toBe(1);

    // An administrator who is no longer one, and does not own the knowledge, has no such right.
    await w.owner$.call('pro.change_role', { person: stranger.id, role: 'guest' });
    await refused(
      stranger.$.call('knowledge.retract', { knowledge: second, reason: 'Downgraded nonowner' }),
      'role',
    );
    expect((await knowledge(w, second)).status).toBe('accepted');
    expect(await retractions(second)).toBe(0);

    await person.$.call('knowledge.retract', { knowledge: second, reason: 'Exact owner, still a guest' });
    expect(await knowledge(w, second)).toMatchObject({
      status: 'retracted',
      retractedReason: 'Exact owner, still a guest',
    });
    expect(await retractions(second)).toBe(1);
    // History stays intact: a second request cannot append another event.
    await refused(
      person.$.call('knowledge.retract', { knowledge: second, reason: 'Duplicate correction' }),
      'not_open',
    );
    expect(await retractions(second)).toBe(1);
  });
});
