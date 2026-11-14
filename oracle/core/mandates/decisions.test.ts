import { describe, expect, it } from 'vitest';
import {
  addPerson,
  answer,
  candidateWithEvidence,
  decision,
  decisionOf,
  effect,
  newWorld,
  propose,
  readUntrustedAndPrivate,
  refused,
  requestPromotion,
  useTarget,
  verifierAnswer,
} from '../harness.ts';

const target = useTarget('mandates.decisions');

const knowledgeOf = async (w: { owner$: import('../../target.ts').Session }, candidate: string) =>
  (await w.owner$.observe('knowledge', { candidate })).length;

describe('no one approves their own proposal', () => {
  it('[S7] the proposing agent cannot answer its own question, a run answers nothing, and the person it acts for can', async () => {
    const w = await newWorld(target(), 'OwnProposal');
    const id = await propose(w, { classHint: 5 });
    const d = await decisionOf(w, id);
    await refused(answer(target().setWorkspace(w.ws).asPrincipal(w.agent), w, d), 'own_proposal');
    await refused(answer(w.agent$, w, d), 'not_by_runs');
    await refused(answer(w.owner$.asRun(w.run, w.secret), w, d), 'not_by_runs');
    expect((await effect(w, id)).status).toBe('awaiting_checker');
    await answer(w.owner$, w, d);
    expect((await effect(w, id)).status).toBe('allowed');
  });

  it('[S14] an answer is bound to the exact proposal it was shown, and the first valid answer wins', async () => {
    const w = await newWorld(target(), 'HashBound');
    const d = await decisionOf(w, await propose(w, { classHint: 5 }));
    await refused(w.owner$.call('decision.answer', { decision: d, proposalHash: 'not-the-hash', verdict: 'approved', note: null }), 'different_proposal');
    expect((await decision(w, d)).status).toBe('open');
    await answer(w.owner$, w, d, 'rejected');
    await refused(answer(w.owner$, w, d), 'not_open');
    expect((await decision(w, d)).status).toBe('rejected');
  });

  it('[S7] a decision that belongs to one person is answered by that person alone', async () => {
    const w = await newWorld(target(), 'OtherPerson');
    const colleague = await addPerson(w, 'Colleague');
    const admin = await addPerson(w, 'Admin', 'admin');
    const d = await decisionOf(w, await propose(w, { classHint: 5 }));
    expect(await decision(w, d)).toMatchObject({ checkerKind: 'person', checker: w.owner, reason: 'final' });
    for (const other of [colleague, admin]) await refused(answer(other.$, w, d), 'someone_else');
    expect((await decision(w, d)).status).toBe('open');
  });

  it('[S7] there is one open question per subject: a second request cannot shop for a friendlier checker', async () => {
    const w = await newWorld(target(), 'OneOpen');
    const { candidate } = await candidateWithEvidence(w, 'The warehouse closes at 18:00.', 'closes at 18:00');
    await requestPromotion(w, candidate);
    await refused(requestPromotion(w, candidate), 'conflict');
    expect(await w.owner$.observe('decision', { subject: candidate })).toHaveLength(1);
  });
});

describe('strict questions exclude the proposer’s whole delegation tree, people included', () => {
  it('[S7] the owner’s agent asks for access.grant: in a team the owner cannot decide; an independent admin can', async () => {
    const w = await newWorld(target(), 'Elevation');
    const independent = await addPerson(w, 'Independent admin', 'admin');
    const member = await addPerson(w, 'Member');
    const id = await propose(w, { operation: 'access.grant', args: { role: 'admin', to: 'someone@example.com' } });
    expect(await effect(w, id)).toMatchObject({ effectClass: 6, status: 'awaiting_checker', routeReason: 'elevation' });
    const d = await decisionOf(w, id);
    expect(await decision(w, d)).toMatchObject({ checkerKind: 'person', checker: null });
    await refused(answer(w.owner$, w, d), 'not_independent');
    await refused(answer(member.$, w, d), 'role');
    await refused(answer(w.verifier$, w, d), 'role');
    expect((await effect(w, id)).status).toBe('awaiting_checker');
    await answer(independent.$, w, d);
    expect((await effect(w, id)).status).toBe('allowed');
  });

  it('[S7] in a personal workspace the owner decides the same question', async () => {
    const w = await newWorld(target(), 'PersonalElevation', { kind: 'personal' });
    const id = await propose(w, { operation: 'access.grant', args: { role: 'admin', to: 'me@example.com' } });
    await answer(w.owner$, w, await decisionOf(w, id));
    expect((await effect(w, id)).status).toBe('allowed');
  });

  it('[S7] in a personal workspace the owner accepts knowledge and an unprepared verifier cannot substitute a raw answer', async () => {
    const w = await newWorld(target(), 'PersonalKnowledge', { kind: 'personal' });
    const byOwner = await candidateWithEvidence(w, 'My dentist is on Fridays.', 'dentist is on Fridays');
    const byVerifier = await candidateWithEvidence(w, 'The gym closes at 22:00.', 'closes at 22:00');
    await answer(w.owner$, w, await requestPromotion(w, byOwner.candidate));
    const question = await requestPromotion(w, byVerifier.candidate);
    await refused(answer(w.verifier$, w, question), 'verifier_proof');
    expect(await knowledgeOf(w, byVerifier.candidate)).toBe(0);
    await answer(w.owner$, w, question);
    expect((await knowledgeOf(w, byOwner.candidate)) + (await knowledgeOf(w, byVerifier.candidate))).toBe(2);
  });

  it('[S15] a rule-of-two question goes to the verifier first, and in its place to the person whose material it is — never to another admin', async () => {
    const w = await newWorld(target(), 'RuleOfTwoPerson');
    const independent = await addPerson(w, 'Independent admin', 'admin');
    const member = await addPerson(w, 'Member');
    await readUntrustedAndPrivate(w, w);
    const first = await propose(w);
    const second = await propose(w, { args: { field: 'stage', value: 'lost' } });
    const firstQuestion = await decisionOf(w, first);
    const secondQuestion = await decisionOf(w, second);
    expect(await decision(w, firstQuestion)).toMatchObject({ checkerKind: 'verifier', checker: w.owner, reason: 'rule_of_two' });
    // Another admin neither answers it nor sees what would be sent; a member does not either.
    for (const other of [independent, member]) {
      await refused(answer(other.$, w, firstQuestion), 'verifier_only');
      expect(await other.$.observe('effect', { id: first })).toEqual([]);
      expect(await other.$.observe('decision', { id: firstQuestion })).toEqual([]);
      expect(await other.$.call('decision.may_decide', { decision: firstQuestion })).toBe(false);
    }
    // The verifier answers one; the person the work is for answers the other in its place.
    expect(await w.owner$.call('decision.may_decide', { decision: secondQuestion })).toBe(true);
    await verifierAnswer(w.verifier$, w, firstQuestion);
    await answer(w.owner$, w, secondQuestion);
    expect([(await effect(w, first)).status, (await effect(w, second)).status]).toEqual(['allowed', 'allowed']);
  });

  it('[S7] other verifier questions still go to an independent owner or admin in the verifier’s place', async () => {
    const w = await newWorld(target(), 'StrictVerifierQuestion');
    const independent = await addPerson(w, 'Independent admin', 'admin');
    const { candidate } = await candidateWithEvidence(w, 'The office moves in June.', 'office moves in June');
    const d = await requestPromotion(w, candidate);
    expect(await decision(w, d)).toMatchObject({ checkerKind: 'verifier', checker: null });
    expect(await independent.$.call('decision.may_decide', { decision: d })).toBe(true);
    await answer(independent.$, w, d);
    expect(await knowledgeOf(w, candidate)).toBe(1);
  });

  it('[S7] the owner cannot approve its agent’s candidate for knowledge, even in the verifier’s place', async () => {
    const w = await newWorld(target(), 'CandidateStrict');
    const independent = await addPerson(w, 'Independent admin', 'admin');
    const { candidate } = await candidateWithEvidence(w, 'The office moves in May.', 'office moves in May');
    const d = await requestPromotion(w, candidate);
    expect(await decision(w, d)).toMatchObject({ checkerKind: 'verifier', reason: 'promotion' });
    await refused(answer(w.owner$, w, d), 'not_independent');
    expect(await knowledgeOf(w, candidate)).toBe(0);
    await answer(independent.$, w, d);
    expect(await knowledgeOf(w, candidate)).toBe(1);
  });

  it('[S7] without a verifier, promotion goes to an independent owner or admin', async () => {
    const w = await newWorld(target(), 'NoVerifier', { verifier: false });
    const member = await addPerson(w, 'Member');
    const independent = await addPerson(w, 'Independent admin', 'admin');
    const { candidate } = await candidateWithEvidence(w, 'Invoices are due in 30 days.', 'due in 30 days');
    const d = await requestPromotion(w, candidate);
    expect(await decision(w, d)).toMatchObject({ checkerKind: 'person', checker: null });
    await refused(answer(w.owner$, w, d), 'not_independent');
    await refused(answer(member.$, w, d), 'role');
    await answer(independent.$, w, d);
    expect(await knowledgeOf(w, candidate)).toBe(1);
  });

  it('[S7] a person inside the proposer’s delegation tree is never independent, however the mandate got there', async () => {
    const w = await newWorld(target(), 'Tree');
    const colleague = await addPerson(w, 'Colleague', 'admin');
    const second = await w.owner$.call<string>('agent.create', { name: 'Second worker' });
    const d = await decisionOf(w, await propose(w, { operation: 'access.grant' }));
    // A mandate in the tree naming the colleague as issuer: the crossings never write one, but a writer below every grant might.
    expect(
      await target().adversary.attack('storage.colleague_in_tree_then_answer', {
        workspace: w.ws,
        proposer: w.agent,
        colleague: colleague.id,
        subject: second,
        onBehalfOf: w.owner,
        parent: w.mandate,
        decision: d,
      }),
    ).toEqual({ before: { strict: true, lenient: true }, after: { strict: false, lenient: true }, answered: 'not_independent' });
    // The public check agrees for the tree as it really is.
    expect(await w.owner$.call('man.checker_independent', { workspace: w.ws, proposer: w.agent, checker: colleague.id, strict: true })).toBe(true);
  });

  it('[S15] a verifier belongs to the workspace, never to the admin who created it, and a worker never verifies', async () => {
    const w = await newWorld(target(), 'VerifierOwner', { verifier: false });
    const colleague = await addPerson(w, 'Quality lead', 'admin');
    const verifier = await colleague.$.call<string>('agent.create', { name: 'Independent verifier', role: 'verifier' });
    expect((await w.owner$.observe<{ owner: string }>('principal', { id: verifier }))[0]?.owner).toBe(w.system);
    const theirs = await colleague.$.call<string>('agent.create', { name: 'Their worker' });
    const other = await w.owner$.call<string>('agent.create', { name: 'Other worker' });
    const { candidate } = await candidateWithEvidence(w, 'Prices rise in June.', 'Prices rise in June');
    const d = await requestPromotion(w, candidate);
    for (const worker of [other, theirs]) {
      await refused(answer(target().setWorkspace(w.ws).asPrincipal(worker), w, d), 'verifier_only');
    }
    await verifierAnswer(target().setWorkspace(w.ws).asPrincipal(verifier), w, d);
    expect((await decision(w, d)).status).toBe('approved');
  });
});
