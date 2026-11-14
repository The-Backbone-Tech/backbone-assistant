import { describe, expect, it } from 'vitest';
import { candidateWithEvidence, decision, newWorld, refused, requestPromotion, useTarget } from '../harness.ts';

// Its own installation: the verification queue holds only this case's question.
const target = useTarget('mandates.queue-escalation');

describe('the verification queue', () => {
  it('[S15] only a verifier escalates, once; an escalated question leaves the queue for people', async () => {
    const w = await newWorld(target(), 'Escalate');
    const { candidate } = await candidateWithEvidence(w, 'Minutes: the launch is on 3 November.', 'launch is on 3 November');
    const d = await requestPromotion(w, candidate);
    await refused(w.owner$.call('decision.escalate', { decision: d, note: 'not sure' }), 'role');
    await refused(w.agent$.call('decision.escalate', { decision: d, note: 'not sure' }), 'role');
    await w.verifier$.call('decision.escalate', { decision: d, note: 'Check the date is final.' });
    await refused(w.verifier$.call('decision.escalate', { decision: d, note: 'again' }), 'not_open');
    expect(await decision(w, d)).toMatchObject({ status: 'open', escalationNote: 'Check the date is final.' });
    expect(await target().setWorkspace(null).call('man.claim_next_verification', {})).toBeNull();
    const entries = await w.owner$.observe<{ type: string }>('ledger', { subject: d });
    expect(entries.at(-1)?.type).toBe('decision.escalated');
  });
});
