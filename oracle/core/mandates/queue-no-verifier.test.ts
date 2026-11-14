import { describe, expect, it } from 'vitest';
import { candidateWithEvidence, decision, newWorld, requestPromotion, useTarget } from '../harness.ts';

// Its own installation: the verification queue holds only this case's question.
const target = useTarget('mandates.queue-no-verifier');

describe('the verification queue', () => {
  it('[S15] a workspace without a verifier keeps its questions for owners and admins', async () => {
    const w = await newWorld(target(), 'NoVerifier', { verifier: false });
    const { candidate } = await candidateWithEvidence(w, 'Office: closes at 18:00.', 'closes at 18:00');
    const d = await requestPromotion(w, candidate);
    expect((await decision(w, d)).checkerKind).toBe('person');
    expect(await target().setWorkspace(null).call('man.claim_next_verification', {})).toBeNull();
  });
});
