import { describe, expect, it } from 'vitest';
import {
  canTransition,
  EFFECT_STATUSES,
  type EffectClass,
  type RouteInput,
  route,
} from '../reference.ts';
import { addPerson, answer, classify, effect, newWorld, propose, refused, useTarget } from '../harness.ts';

const target = useTarget('eff.gateway');

/** Every standing the gateway can reach. The type below fails to compile if the kernel adds one. */
const STANDINGS = [
  'ok',
  'outside_mandate',
  'mandate_expired',
  'mandate_revoked',
  'budget_exhausted',
  'already_rejected',
] as const satisfies readonly RouteInput['standing'][];
const everyStanding: Exclude<RouteInput['standing'], (typeof STANDINGS)[number]> extends never
  ? true
  : false = true;

/** Run `work` over `items`, a few at a time. */
async function each<T, R>(items: readonly T[], work: (item: T) => Promise<R>, width = 8): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await work(items[i] as T);
      }
    }),
  );
  return out;
}

describe('the gateway routes exactly as the kernel does', () => {
  it('[S8] sec.route_effect agrees with kernel route() on every one of the 2304 possible inputs', async () => {
    expect(everyStanding).toBe(true);
    const inputs: RouteInput[] = [];
    for (const effectClass of [1, 2, 3, 4, 5, 6] as EffectClass[])
      for (const standing of STANDINGS)
        for (const ceiling of [1, 2, 3, 4] as const)
          for (const untrustedInput of [false, true])
            for (const sensitiveData of [false, true])
              for (const externalParty of [false, true])
                for (const outboundFixed of [false, true])
                  inputs.push({
                    effectClass,
                    standing,
                    ceiling,
                    taint: { untrustedInput, sensitiveData },
                    externalParty,
                    outboundFixed,
                  });
    expect(inputs).toHaveLength(2304);
    const s = target().setWorkspace(null);
    const text = (r: ReturnType<typeof route>) => ('reason' in r ? `${r.kind}:${r.reason}` : r.kind);
    const answers = await each(inputs, async (i) => {
      const args = {
        effectClass: i.effectClass,
        standing: i.standing,
        ceiling: i.ceiling,
        untrustedInput: i.taint.untrustedInput,
        sensitiveData: i.taint.sensitiveData,
        externalParty: i.externalParty,
        outboundFixed: i.outboundFixed,
      };
      return {
        stated: await s.call<string>('policy.route', args),
        unstated: await s.call<string>('policy.route_unstated', args),
      };
    });
    inputs.forEach((input, index) => {
      expect(answers[index]?.stated, JSON.stringify(input)).toBe(text(route(input)));
      // A caller that does not state who fixed a read's arguments gets the closed answer.
      expect(answers[index]?.unstated, JSON.stringify(input)).toBe(
        text(route({ ...input, outboundFixed: false })),
      );
    });
  });

  it('[S8] the database lifecycle table matches the kernel lifecycle table', async () => {
    const s = target().setWorkspace(null);
    const pairs = EFFECT_STATUSES.flatMap((from) => EFFECT_STATUSES.map((to) => ({ from, to })));
    expect(pairs).toHaveLength(EFFECT_STATUSES.length ** 2);
    const allowed = await each(pairs, (p) => s.call<boolean>('policy.transition_allowed', p));
    pairs.forEach((p, i) => {
      expect(allowed[i], `${p.from} -> ${p.to}`).toBe(canTransition(p.from, p.to));
    });
  });
});

describe('the class of an effect: built-in classes are fixed, the catalogue decides the rest, hints only raise', () => {
  it('[S8] an unknown operation is treated as a reversible external change (class 3)', async () => {
    const w = await newWorld(target(), 'UnknownOp');
    const id = await propose(w, { operation: 'mystery:thing', classHint: null, externalHint: false });
    expect(await effect(w, id)).toMatchObject({ effectClass: 3, external: true, status: 'allowed' });
  });

  it('[S8] a hint may raise the class, never lower it', async () => {
    const w = await newWorld(target(), 'Hints');
    expect(
      await effect(w, await propose(w, { operation: 'workspace.post_message', classHint: 5 })),
    ).toMatchObject({
      effectClass: 5,
      external: false,
      status: 'awaiting_checker',
    });
    expect(
      await effect(w, await propose(w, { operation: 'payment.send', classHint: 1, externalHint: false })),
    ).toMatchObject({
      effectClass: 5,
      external: true,
      routeReason: 'final',
    });
    expect(
      await effect(w, await propose(w, { operation: 'workspace.update_task', externalHint: true })),
    ).toMatchObject({
      effectClass: 2,
      external: true,
    });
  });

  it('[S8] lowering a built-in in the catalogue changes nothing, even once it is applied', async () => {
    // A personal workspace has one root of authority, so the change applies at once.
    const w = await newWorld(target(), 'BuiltinsFixed', { kind: 'personal' });
    const change = await classify(w.owner$, [
      { operation: 'payment.send', class: 1, external: false },
      { operation: 'access.grant', class: 1, external: false },
      { operation: 'email.send', class: 1, external: false },
    ]);
    expect(change.decision).toBeNull();
    const catalogue = await w.owner$.observe<{ operation: string; effectClass: number }>('operation');
    expect(catalogue.filter((o) => o.effectClass === 1)).toHaveLength(3);
    expect(await effect(w, await propose(w, { operation: 'payment.send' }))).toMatchObject({
      effectClass: 5,
      external: true,
      routeReason: 'final',
    });
    expect(await effect(w, await propose(w, { operation: 'access.grant' }))).toMatchObject({
      effectClass: 6,
      routeReason: 'elevation',
    });
    expect(await effect(w, await propose(w, { operation: 'email.send' }))).toMatchObject({
      effectClass: 4,
      external: true,
    });
  });

  it('[S4] in a team, lowering a built-in is an elevation, and even approved it changes nothing', async () => {
    const w = await newWorld(target(), 'BuiltinsTeam');
    const second = await addPerson(w, 'Second admin', 'admin');
    const change = await classify(w.owner$, [
      { operation: 'payment.send', class: 1, external: false },
      { operation: 'access.grant', class: 1, external: false },
    ]);
    expect(change.decision).not.toBeNull();
    await answer(second.$, w, change.decision ?? '');
    expect(await effect(w, await propose(w, { operation: 'payment.send' }))).toMatchObject({
      effectClass: 5,
    });
    expect(await effect(w, await propose(w, { operation: 'access.grant' }))).toMatchObject({
      effectClass: 6,
    });
  });

  it('[S4] in a team, lowering an operation below its class is an elevation the proposer cannot decide and a second admin can', async () => {
    const w = await newWorld(target(), 'Lowering');
    const second = await addPerson(w, 'Second admin', 'admin');
    const member = await addPerson(w, 'Member');
    // Raising restricts agents, so it applies at once.
    const raised = await classify(w.owner$, [{ operation: 'crm:export', class: 5, external: true }]);
    expect(raised.decision).toBeNull();
    const lowered = await classify(w.owner$, [{ operation: 'crm:export', class: 1, external: true }]);
    const id = lowered.decision ?? '';
    expect(id).not.toBe('');
    const [question] = await w.owner$.observe('decision', { id });
    expect(question).toMatchObject({
      subjectKind: 'elevation',
      checkerKind: 'person',
      checker: null,
      reason: 'elevation',
    });
    // Until someone else decides, the old class holds.
    expect((await effect(w, await propose(w, { operation: 'crm:export' }))).effectClass).toBe(5);
    await refused(answer(w.owner$, w, id), 'own_proposal');
    await refused(answer(member.$, w, id), 'role');
    expect((await w.owner$.observe<{ status: string }>('decision', { id }))[0]?.status).toBe('open');
    await answer(second.$, w, id);
    expect(
      await effect(w, await propose(w, { operation: 'crm:export', args: { list: 'all' } })),
    ).toMatchObject({
      effectClass: 1,
      route: 'free',
      status: 'allowed',
    });
  });

  it('[S4] in a team, marking an external operation internal is an elevation too', async () => {
    const w = await newWorld(target(), 'Internalise');
    const change = await classify(w.owner$, [{ operation: 'crm:note', class: 3, external: false }]);
    expect(change.decision).not.toBeNull();
    expect((await effect(w, await propose(w, { operation: 'crm:note' }))).external).toBe(true);
    const [row] = await w.owner$.observe<{ status: string }>('operation.change', { id: change.change });
    expect(row?.status).toBe('open');
  });

  it('[S4] only owners and admins classify operations, never from inside a run', async () => {
    const w = await newWorld(target(), 'ClassifyAuth');
    const member = await addPerson(w, 'Member');
    const before = await w.owner$.observe('operation');
    for (const session of [w.agent$, member.$, w.t.setWorkspace(w.ws).asPrincipal(w.agent)]) {
      await refused(classify(session, [{ operation: 'crm:x', class: 5, external: true }]), 'role');
    }
    await refused(classify(w.owner$, [{ operation: 'crm:x', class: 7, external: true }]), 'invalid');
    expect(await w.owner$.observe('operation')).toEqual(before);
  });
});
