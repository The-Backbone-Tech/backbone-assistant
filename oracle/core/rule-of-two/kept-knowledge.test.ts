import { describe, expect, it } from 'vitest';
import {
  addPerson,
  answer,
  proposeCandidate,
  readUntrustedAndPrivate,
  recordSource,
  refused,
  requestPromotion,
  useTarget,
  verifierAnswer,
} from '../harness.ts';
import { privateWorld } from './fixtures.ts';

/** Its own file: the verifier takes its question from the installation-wide verification queue. */
const target = useTarget('rule-of-two.kept-knowledge');

const askedById = async (session: Awaited<ReturnType<typeof privateWorld>>['owner$'], id: string) =>
  session.observe<{
    checkerKind: string;
    checker: string | null;
    reason: string;
    question: string;
    status: string;
    answeredBy: string | null;
  }>('r2.decision.asked', { id });

describe('a knowledge proposal from work marked both ways is kept for its person and the verifier (P3-1)', () => {
  it('[S15] no owner or admin reads it while it waits; the verifier decides; its person may decline it, never accept it (probe I3)', async () => {
    const w = await privateWorld(target(), 'KeptKnowledge');
    const joan = await addPerson(w, 'Joan', 'admin');
    await readUntrustedAndPrivate(w, w);
    const inbox = await recordSource(w, 'Inbox: refunds are 365 days.', null, {
      run: w.run,
      ref: 'mail://inbox/3',
    });
    const statement = 'Refunds are 365 days. Salaries: PRIVATE-I3 Ana 41k';
    const kept = await proposeCandidate(w.agent$, w.agent, statement, [
      { episode: inbox, excerpt: 'refunds are 365 days' },
    ]);
    const decision = await requestPromotion(w, kept);
    expect(await askedById(w.owner$, decision)).toMatchObject([
      {
        checkerKind: 'verifier',
        checker: w.owner,
        reason: 'rule_of_two',
        question: `Accept into knowledge: ${statement}. The work that proposed it read untrusted content and private material: only KeptKnowledge Owner and the verifier see it.`,
      },
    ]);
    // An admin reads neither the proposal nor its question, and does not decide it.
    expect(await joan.$.observe('r2.knowledge.candidate', { id: kept })).toEqual([]);
    expect(await askedById(joan.$, decision)).toEqual([]);
    await refused(answer(joan.$, w, decision), 'verifier_only');
    // Its person and the verifier read it.
    expect(await w.owner$.observe('r2.knowledge.candidate', { id: kept })).toMatchObject([{ statement }]);
    expect(await w.verifier$.observe('r2.knowledge.candidate', { id: kept })).toMatchObject([{ statement }]);
    // Its person may not accept her own agent's proposal for everyone, but may decline it.
    await refused(answer(w.owner$, w, decision, 'approved'), 'not_independent');
    expect(await w.owner$.observe('knowledge', { candidate: kept })).toEqual([]);
    await answer(w.owner$, w, decision, 'rejected');
    expect(await askedById(w.owner$, decision)).toMatchObject([{ status: 'rejected', answeredBy: w.owner }]);
    // The verifier accepts another: then it is everyone's knowledge.
    const second = await proposeCandidate(w.agent$, w.agent, 'Refunds are 365 days.', [
      { episode: inbox, excerpt: 'refunds are 365 days' },
    ]);
    await verifierAnswer(w.verifier$, w, await requestPromotion(w, second));
    expect(
      (await joan.$.observe<{ statement: string }>('knowledge', { candidate: second })).map(
        (k) => k.statement,
      ),
    ).toEqual(['Refunds are 365 days.']);
    // Work marked one way only is not kept: an owner or admin may decide it, and reads it.
    const v = await privateWorld(target(), 'KeptKnowledgeControl');
    const joanToo = await addPerson(v, 'Joan', 'admin');
    await readUntrustedAndPrivate(v, v, { untrusted: true, sensitive: false });
    const heard = await recordSource(v, 'Inbox: refunds are 30 days.', null, {
      run: v.run,
      ref: 'mail://inbox/4',
    });
    const open = await proposeCandidate(v.agent$, v.agent, 'Refunds are 30 days.', [
      { episode: heard, excerpt: 'refunds are 30 days' },
    ]);
    const asked = await requestPromotion(v, open);
    expect(await askedById(v.owner$, asked)).toMatchObject([{ checker: null, reason: 'promotion' }]);
    expect(await joanToo.$.observe('r2.knowledge.candidate', { id: open })).toMatchObject([
      { statement: 'Refunds are 30 days.' },
    ]);
  });
});
