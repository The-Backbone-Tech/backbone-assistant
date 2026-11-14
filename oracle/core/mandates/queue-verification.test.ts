import { describe, expect, it } from 'vitest';
import { candidateWithEvidence, newWorld, refused, requestPromotion, sleep, useTarget, verifierAnswer } from '../harness.ts';

// Its own installation: the verification queue holds only this case's question.
const target = useTarget('mandates.queue-verification');

describe('the verification queue', () => {
  it('[S15] a verifier question is queued, taken once from an empty session, and answered by the verifier', async () => {
    const w = await newWorld(target(), 'Verify');
    const { candidate } = await candidateWithEvidence(w, 'Minutes: the launch is on 3 November.', 'launch is on 3 November');
    const decision = await requestPromotion(w, candidate);
    await refused(w.owner$.call('man.claim_next_verification', { worker: 'x' }), 'empty_session_only');
    const nobody = target().setWorkspace(null);
    expect(await nobody.call('man.claim_next_verification', { leaseMs: 1000 })).toEqual({ workspace: w.ws, decision, verifier: w.verifier });
    expect(await nobody.call('man.claim_next_verification', {})).toBeNull(); // leased
    // The verifier's own governed answer takes the question again once that short lease lapses.
    await sleep(1_100);
    await verifierAnswer(w.verifier$, w, decision, 'approved', 'The minutes say so.');
    expect(await w.owner$.observe('knowledge', { candidate })).toHaveLength(1);
    // Answered, it is gone from the queue for good.
    expect(await nobody.call('man.claim_next_verification', {})).toBeNull();
  });
});
