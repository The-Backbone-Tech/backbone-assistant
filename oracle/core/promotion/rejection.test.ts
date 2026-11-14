import { describe, expect, it } from 'vitest';
import {
  addPerson,
  decision,
  newWorld,
  proposeCandidate,
  recordSource,
  refused,
  requestPromotion,
  useTarget,
  verifierAnswer,
} from '../harness.ts';
import { candidate, knowledgeOf, questionsAbout } from './fixtures.ts';

// Answering takes the question from the installation-wide verification queue: this file holds only this case's work.
const target = useTarget('promotion.rejection');

describe('knowledge: promotion happens only inside an independent approving answer', () => {
  it('[S14] a rejection closes the candidate, and the same proposal is not asked again', async () => {
    const w = await newWorld(target(), 'RejectedCandidate');
    const steward = await addPerson(w, 'Steward');
    const episode = await recordSource(w, 'Price list v3 applies from May.');
    const evidence = [{ episode, excerpt: 'Price list v3' }];
    const first = await proposeCandidate(w.agent$, w.agent, 'Price list v3 applies', evidence);
    await verifierAnswer(w.verifier$, w, await requestPromotion(w, first), 'rejected');
    expect((await candidate(w, first)).status).toBe('rejected');
    expect(await knowledgeOf(w, first)).toEqual([]);
    await refused(requestPromotion(w, first), 'not_open');
    const again = await proposeCandidate(w.agent$, w.agent, 'Price list v3 applies', evidence);
    await refused(requestPromotion(w, again), 'already_rejected');
    expect(await questionsAbout(w, again)).toEqual([]);
    // Other terms make it a different proposal, for a checker to decide afresh.
    const fresh = await requestPromotion(w, again, w.agent$, steward.id);
    expect((await decision(w, fresh)).status).toBe('open');
  });
});
