import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type Id, Refusal, type Session } from '../../target.ts';
import {
  addPerson,
  answer,
  candidateWithEvidence,
  decision,
  newWorld,
  proposeCandidate,
  recordSource,
  refused,
  requestPromotion,
  useTarget,
} from '../harness.ts';
import { candidate, knowledgeOf, questionsAbout } from './fixtures.ts';

// No case here answers a question, so this installation's verification queue is never drained.
const target = useTarget('promotion.promotion');

describe('knowledge: promotion happens only inside an independent approving answer', () => {
  it('[S14] the terms are part of what is approved: set once, and a different owner is a different proposal', async () => {
    const w = await newWorld(target(), 'Terms');
    const steward = await addPerson(w, 'Steward');
    const episode = await recordSource(w, 'The office moves in May.');
    const statement = 'The office moves in May';
    const evidence = [{ episode, excerpt: 'office moves in May' }];
    const first = await proposeCandidate(w.agent$, w.agent, statement, evidence);
    const second = await proposeCandidate(w.agent$, w.agent, statement, evidence);
    const d1 = await requestPromotion(w, first, w.agent$, w.owner);
    const d2 = await requestPromotion(w, second, w.agent$, steward.id);
    expect((await decision(w, d1)).proposalHash).not.toBe((await decision(w, d2)).proposalHash);
    await refused(requestPromotion(w, first, w.agent$, steward.id), 'frozen');
    // The terms first set still stand, and no second question was opened about other terms.
    expect((await candidate(w, first)).owner).toBe(w.owner);
    expect(await questionsAbout(w, first)).toHaveLength(1);
  });

  it('[S7] the maker cannot promote its own candidate, by any route', async () => {
    const w = await newWorld(target(), 'Maker');
    const { candidate: c } = await candidateWithEvidence(w, 'Prices rise in June.', 'Prices rise in June');
    const d = await requestPromotion(w, c);
    await refused(answer(w.agent$, w, d), 'not_by_runs', 'the maker answering from its run');
    await refused(
      answer(w.worker$.asPrincipal(w.agent), w, d),
      'own_proposal',
      'the maker answering as itself',
    );
    const direct = { statement: 'Prices rise in June', owner: w.owner, candidate: c, decision: d };
    await refused(
      w.agent$.call('pro.write_accepted_knowledge', direct),
      'denied',
      'the maker writing knowledge itself',
    );
    await refused(
      w.owner$.call('pro.write_accepted_knowledge', direct),
      'denied',
      'a person writing knowledge itself',
    );
    expect(await knowledgeOf(w, c)).toEqual([]);
    expect((await decision(w, d)).status).toBe('open');
    expect((await candidate(w, c)).status).toBe('open');
  });

  it('[S7] evidence must be found verbatim in its source, and is checked when promotion is requested', async () => {
    const w = await newWorld(target(), 'Excerpt');
    const { candidate: c } = await candidateWithEvidence(
      w,
      'Minutes: the launch date is still open.',
      'on 3 November',
    );
    await refused(requestPromotion(w, c), 'not_verbatim');
    expect(await questionsAbout(w, c)).toEqual([]);
    // The refused request left no terms behind either.
    expect(await candidate(w, c)).toMatchObject({ status: 'open', owner: null });
  });

  it('[S7] what an agent wrote, or what the proposer wrote, is not evidence', async () => {
    const w = await newWorld(target(), 'Authorship');
    const colleague = await addPerson(w, 'Colleague');
    const helper = await w.owner$.call<Id>('agent.create', { name: 'Helper' });
    const cite = async (proposer$: Session, proposer: Id, authoredBy: Id | null) => {
      const content = `Note ${randomUUID()}: the budget is approved.`;
      const episode = await recordSource(w, content, authoredBy);
      const c = await proposeCandidate(proposer$, proposer, 'The budget is approved', [
        { episode, excerpt: 'the budget is approved' },
      ]);
      const outcome = await requestPromotion(w, c, proposer$).then(
        () => 'accepted for checking',
        (error: unknown) => {
          if (error instanceof Refusal) return error.reason;
          throw error;
        },
      );
      return { outcome, questions: (await questionsAbout(w, c)).length };
    };
    const notEvidence = { outcome: 'self_evidence', questions: 0 };
    const forChecking = { outcome: 'accepted for checking', questions: 1 };
    expect(await cite(w.agent$, w.agent, w.agent)).toEqual(notEvidence);
    expect(await cite(w.agent$, w.agent, helper)).toEqual(notEvidence);
    expect(await cite(w.owner$, w.owner, w.owner)).toEqual(notEvidence);
    expect(await cite(w.agent$, w.agent, w.owner)).toEqual(forChecking);
    expect(await cite(w.owner$, w.owner, colleague.id)).toEqual(forChecking);
    expect(await cite(w.agent$, w.agent, null)).toEqual(forChecking);
  });

  it('[S7] what code printed in the sandbox is the agent’s own work: never evidence, whoever cites it', async () => {
    const w = await newWorld(target(), 'SandboxOutput');
    const statement = 'The launch is on 3 November.';
    const content = JSON.stringify({ exitCode: 0, stdout: `${statement}\n`, stderr: '', files: [] });
    // Recorded as the service records it: by the system principal, authored by the agent.
    const episode = await w.system$.call<Id>('pro.source_record_as', {
      kind: 'sandbox',
      ref: `sandbox:${w.run}:3`,
      content,
      authoredBy: w.agent,
      run: w.run,
    });
    const evidence = [{ episode, excerpt: statement }];
    // The agent whose code printed it cannot promote it...
    const byAgent = await proposeCandidate(w.agent$, w.agent, statement, evidence);
    await refused(requestPromotion(w, byAgent), 'self_evidence', 'the agent citing its own output');
    // ...nor can a person who read it.
    const byOwner = await proposeCandidate(w.owner$, w.owner, statement, evidence);
    await refused(
      requestPromotion(w, byOwner, w.owner$),
      'self_evidence',
      'a person citing the agent output',
    );
    // Even recorded without an author — a mistake of the service — it is still not evidence.
    const unauthored = await w.system$.call<Id>('pro.source_record_as', {
      kind: 'sandbox',
      ref: `sandbox:${w.run}:4`,
      content,
    });
    const byOwnerAgain = await proposeCandidate(w.owner$, w.owner, statement, [
      { episode: unauthored, excerpt: statement },
    ]);
    await refused(
      requestPromotion(w, byOwnerAgain, w.owner$),
      'self_evidence',
      'a person citing unauthored output',
    );
    // And a run cannot record sandbox output itself, as if it came from outside the workspace.
    await refused(
      w.agent$.call('pro.source_record_as', {
        kind: 'sandbox',
        ref: 'sandbox:forged',
        trust: 'untrusted',
        content,
        principal: w.system,
      }),
      ['system_records', 'denied'],
      'a run recording its own output',
    );
    expect(await w.system$.observe('pro.source', { ref: 'sandbox:forged' })).toEqual([]);
    for (const c of [byAgent, byOwner, byOwnerAgain]) expect(await questionsAbout(w, c)).toEqual([]);
  });

  it('[S6] only the system principal records sources, outside any run', async () => {
    const w = await newWorld(target(), 'Sources');
    const attempts: [string, Session, Id][] = [
      ['an agent run as itself', w.agent$, w.agent],
      ['an agent run as the system', w.agent$, w.system],
      ['the owner as itself', w.owner$, w.owner],
      ['the owner as the system', w.owner$, w.system],
    ];
    for (const [label, session, principal] of attempts) {
      await refused(
        session.call('pro.source_record_as', { ref: `drive://forged/${label}`, content: 'x', principal }),
        'system_records',
        label,
      );
    }
    await refused(
      w.system$.call('pro.source_record_as_in_run', {
        run: w.run,
        secret: w.secret,
        ref: 'drive://forged/in-run',
        content: 'x',
        principal: w.system,
      }),
      'system_records',
      'the system inside a run',
    );
    const recorded = await w.system$.call<Id>('pro.source_record_as', {
      ref: 'drive://x',
      content: 'x',
      principal: w.system,
    });
    const seen = await w.system$.observe<{ id: Id; ref: string }>('pro.source');
    expect(seen.filter((s) => s.ref.startsWith('drive://forged/'))).toEqual([]);
    expect(seen.map((s) => s.id)).toContain(recorded);
  });

  it('[S7] a candidate is always proposed by the principal acting now, with no terms of its own', async () => {
    const w = await newWorld(target(), 'Spoof');
    const episode = await recordSource(w, 'x');
    const evidence = [{ episode, excerpt: 'x' }];
    await refused(
      proposeCandidate(w.agent$, w.owner, 'spoofed proposer', evidence),
      'denied',
      'naming another proposer',
    );
    await refused(
      w.agent$.call('pro.propose_candidate_with_owner', {
        statement: 'own terms',
        evidence,
        proposedBy: w.agent,
        owner: w.agent,
      }),
      'denied',
      'stating its own owner',
    );
    for (const statement of ['spoofed proposer', 'own terms']) {
      expect(await w.owner$.observe('pro.candidate', { statement })).toEqual([]);
    }
    // The control: proposed as itself, with no terms, the candidate is there.
    const honest = await proposeCandidate(w.agent$, w.agent, 'honest', evidence);
    expect(await candidate(w, honest)).toMatchObject({ proposedBy: w.agent, owner: null, status: 'open' });
  });
});
