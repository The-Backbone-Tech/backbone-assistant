import { describe, expect, it } from 'vitest';
import { type Id, Refusal } from '../../target.ts';
import { addPerson, candidateWithEvidence, newWorld, useTarget, verifierAnswer } from '../harness.ts';
import { candidate, entries, knowledgeOf } from './fixtures.ts';

// Answering takes the question from the installation-wide verification queue: this file holds only this case's work.
const target = useTarget('promotion.accepted');

describe('knowledge: promotion happens only inside an independent approving answer', () => {
  it('[S7] the approving answer promotes the candidate with exactly the terms that were approved', async () => {
    const w = await newWorld(target(), 'Promote');
    const steward = await addPerson(w, 'Steward');
    const { candidate: c } = await candidateWithEvidence(
      w,
      'Minutes: the launch is on 3 November.',
      'launch is on 3 November',
    );
    const validFrom = new Date('2026-11-01T00:00:00Z');
    const validTo = new Date('2027-01-01T00:00:00Z');
    const d = await w.agent$.call<Id>('knowledge.request_promotion', {
      candidate: c,
      owner: steward.id,
      validFrom,
      validTo,
    });
    expect(await knowledgeOf(w, c)).toEqual([]);
    await verifierAnswer(w.verifier$, w, d);
    const rows = await knowledgeOf(w, c);
    expect(rows).toHaveLength(1);
    const [k] = rows;
    if (!k) throw new Error('no knowledge');
    expect(k).toMatchObject({ owner: steward.id, validFrom, validTo, decision: d, status: 'accepted' });
    expect((await candidate(w, c)).status).toBe('accepted');
    const accepted = await entries(w.owner$, k.id, 'knowledge.accepted');
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      actor: w.verifier,
      payload: { candidate: c, decision: d, owner: steward.id },
    });
    // Accepted knowledge is not rewritten in place afterwards, not even by the workspace's owner.
    const outcome = await w.owner$
      .call<number>('pro.rewrite_knowledge', { knowledge: k.id, statement: 'The launch is on 4 November' })
      .then(
        (changed) => changed,
        (error: unknown) => {
          if (error instanceof Refusal) return 0;
          throw error;
        },
      );
    expect(outcome).toBe(0);
    expect((await knowledgeOf(w, c))[0]?.statement).toBe(k.statement);
  });
});
