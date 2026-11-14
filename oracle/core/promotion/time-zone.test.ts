import { describe, expect, it } from 'vitest';
import type { Id } from '../../target.ts';
import { candidateWithEvidence, newWorld, useTarget, verifierAnswer } from '../harness.ts';
import { knowledgeOf } from './fixtures.ts';

// Answering takes the question from the installation-wide verification queue: this file holds only this case's work.
const target = useTarget('promotion.time-zone');

describe('knowledge: promotion happens only inside an independent approving answer', () => {
  it('[S14] what is approved does not depend on the time zone of whoever asks or answers', async () => {
    const w = await newWorld(target(), 'TimeZones');
    const { candidate: c } = await candidateWithEvidence(
      w,
      'Minutes: the launch is on 3 November.',
      'launch is on 3 November',
    );
    const validFrom = new Date('2026-11-01T00:00:00Z');
    // The verifier answers in the installation's zone; the agent asks from a different one.
    const [answering] = await w.verifier$.observe<{ zone: string }>('pro.time_zone');
    const timeZone = answering?.zone === 'Pacific/Auckland' ? 'UTC' : 'Pacific/Auckland';
    const d = await w.agent$.call<Id>('pro.request_promotion_in_zone', {
      candidate: c,
      owner: w.owner,
      validFrom,
      timeZone,
    });
    await verifierAnswer(w.verifier$, w, d);
    const [k] = await knowledgeOf(w, c);
    expect(k).toMatchObject({ status: 'accepted', decision: d, validFrom });
  });
});
