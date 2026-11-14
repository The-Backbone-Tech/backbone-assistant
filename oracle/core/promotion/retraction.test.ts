import { describe, expect, it } from 'vitest';
import {
  addPerson,
  candidateWithEvidence,
  newWorld,
  refused,
  requestPromotion,
  useTarget,
  verifierAnswer,
} from '../harness.ts';
import { candidate, entries, knowledge, knowledgeOf } from './fixtures.ts';

// Answering takes the question from the installation-wide verification queue: this file holds only this case's work.
const target = useTarget('promotion.retraction');

describe('knowledge: promotion happens only inside an independent approving answer', () => {
  it('[S7] knowledge is owned by a member of the workspace, and retracted only by its owner or an admin', async () => {
    const w = await newWorld(target(), 'Retract');
    const guest = await addPerson(w, 'Guest', 'guest');
    const member = await addPerson(w, 'Member');
    const { candidate: c } = await candidateWithEvidence(w, 'Office closes at 18:00.', 'closes at 18:00');
    for (const owner of [w.agent, guest.id]) {
      await refused(requestPromotion(w, c, w.agent$, owner), 'not_member', `owned by ${owner}`);
    }
    expect((await candidate(w, c)).owner).toBeNull();
    await verifierAnswer(w.verifier$, w, await requestPromotion(w, c, w.agent$, w.owner));
    const [k] = await knowledgeOf(w, c);
    if (!k) throw new Error('the approved candidate was not promoted');
    for (const [label, session] of [
      ['the agent', w.agent$],
      ['a member', member.$],
    ] as const) {
      await refused(session.call('knowledge.retract', { knowledge: k.id, reason: 'wrong' }), 'role', label);
    }
    expect((await knowledge(w, k.id)).status).toBe('accepted');
    expect(await entries(w.owner$, k.id, 'knowledge.retracted')).toEqual([]);
    await w.owner$.call('knowledge.retract', { knowledge: k.id, reason: 'hours changed' });
    expect(await knowledge(w, k.id)).toMatchObject({ status: 'retracted', retractedReason: 'hours changed' });
    expect(await entries(w.owner$, k.id, 'knowledge.retracted')).toHaveLength(1);
  });
});
