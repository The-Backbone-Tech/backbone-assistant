import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { Target } from '../target.ts';
import { connector, proposeConnected } from '../core/effects/fixtures.ts';
import { dispatch, effect, issue, newWorld, propose, runIn, sleep } from '../core/harness.ts';

/**
 * The lessons register's core cases (transition-lists §3). Each is a function of a target, so the
 * same case runs against the legacy adapter, a correct stub and a stub with the lesson's flaw.
 */
export interface LessonCase {
  /** The lesson's number in transition-lists §3, and a letter when it has more than one case. */
  readonly id: string;
  readonly lesson: number;
  readonly title: string;
  /** The stub flaw that makes exactly this mistake. */
  readonly flaw: 'L7-key-only-dedupe' | 'L8-no-recheck-before-send' | 'L9-ownerless-unknown' | 'L10-unwalled-store';
  /** Set when the legacy repository does not keep the lesson: what it does instead. */
  readonly legacyDeviation?: string;
  run(t: Target): Promise<void>;
}

/** Nothing of `id` may be sent: it was not let through, and a dispatcher cannot claim it. */
async function notSendable(w: Awaited<ReturnType<typeof newWorld>>, id: string) {
  expect((await effect(w, id)).status).not.toBe('allowed');
  const claimed = await w.system$.call('effect.claim', { effect: id, leaseMs: 30_000 }).then(
    () => true,
    () => false,
  );
  expect(claimed, 'a dispatcher could claim the copy').toBe(false);
}

export const LESSONS: readonly LessonCase[] = [
  {
    id: 'L7a',
    lesson: 7,
    title: '[S8] a new key for the same connector change does not slip past duplicate detection while the first attempt is unknown',
    flaw: 'L7-key-only-dedupe',
    async run(t) {
      const w = await newWorld(t, `Lesson 7a ${randomUUID().slice(0, 6)}`, { kind: 'personal', verifier: false });
      const c = await connector(w);
      const original = await proposeConnected(w, c, { step: 1 });
      await dispatch(w, original, 'unknown');
      const copy = await proposeConnected(w, c, { step: 2, key: `another-key-${randomUUID()}` });
      expect(copy).not.toBe(original);
      await notSendable(w, copy);
    },
  },
  {
    id: 'L7b',
    lesson: 7,
    title: '[S8] a new key for the same external change does not slip past duplicate detection while the first attempt is unknown',
    flaw: 'L7-key-only-dedupe',
    legacyDeviation:
      'The legacy gateway blocks an exact copy of an unknown change only for connector (mcp.*) changes above class 1; the same crm:update_deal under a new key is allowed and claimable while the first attempt is unknown.',
    async run(t) {
      const w = await newWorld(t, `Lesson 7b ${randomUUID().slice(0, 6)}`, { kind: 'personal', verifier: false });
      const original = await propose(w, { step: 1 });
      await dispatch(w, original, 'unknown');
      const copy = await propose(w, { step: 2, key: `another-key-${randomUUID()}` });
      expect(copy).not.toBe(original);
      await notSendable(w, copy);
    },
  },
  {
    id: 'L8a',
    lesson: 8,
    title: '[S5] permission revoked while a send waits is re-read just before sending: nothing goes out',
    flaw: 'L8-no-recheck-before-send',
    async run(t) {
      const w = await newWorld(t, `Lesson 8a ${randomUUID().slice(0, 6)}`, { verifier: false });
      const id = await propose(w);
      const claim = await w.system$.call<string>('effect.claim', { effect: id, leaseMs: 30_000 });
      await w.owner$.call('mandate.revoke', { mandate: w.mandate });
      const began = await w.system$.call<boolean>('effect.begin_dispatch', { effect: id, claim }).catch(() => false);
      expect(began).toBe(false);
      expect(['dispatching', 'succeeded', 'unknown']).not.toContain((await effect(w, id)).status);
    },
  },
  {
    id: 'L8b',
    lesson: 8,
    title: '[S5] permission that expired while a send waited is re-read just before sending: nothing goes out',
    flaw: 'L8-no-recheck-before-send',
    async run(t) {
      const w = await newWorld(t, `Lesson 8b ${randomUUID().slice(0, 6)}`, { verifier: false });
      const brief = await issue(w.owner$, w.agent, { parent: w.mandate, expiresAt: new Date(Date.now() + 1_200) });
      const run = await runIn(w, brief);
      const id = await propose(w, { run });
      const claim = await w.system$.call<string>('effect.claim', { effect: id, leaseMs: 30_000 });
      await sleep(1_300);
      const began = await w.system$.call<boolean>('effect.begin_dispatch', { effect: id, claim }).catch(() => false);
      expect(began).toBe(false);
      expect(['dispatching', 'succeeded', 'unknown']).not.toContain((await effect(w, id)).status);
    },
  },
  {
    id: 'L9',
    lesson: 9,
    title: '[S8] every unknown outcome is listed with the person who answers for it, its evidence and a deadline',
    flaw: 'L9-ownerless-unknown',
    legacyDeviation:
      'The legacy schema lists unknown effects and keeps the observation hash, but names no person responsible (any dispatcher or admin may settle) and sets no deadline.',
    async run(t) {
      const w = await newWorld(t, `Lesson 9 ${randomUUID().slice(0, 6)}`, { verifier: false });
      const id = await propose(w);
      await dispatch(w, id, 'unknown');
      const listed = (await w.owner$.observe<{ effect: string; resolver: string | null; evidence: string | null; deadline: Date | null }>(
        'lesson.unknowns',
      )).find((u) => u.effect === id);
      expect(listed, 'the unknown is not listed').toBeDefined();
      expect(listed?.resolver, 'no one answers for the unknown').toBeTruthy();
      expect(listed?.evidence, 'the unknown keeps no evidence').toBeTruthy();
      expect(listed?.deadline, 'the unknown has no deadline').toBeTruthy();
    },
  },
  {
    id: 'L10',
    lesson: 10,
    title: '[S1] every store, including ones added later, has the tenant wall',
    flaw: 'L10-unwalled-store',
    async run(t) {
      const w = await newWorld(t, `Lesson 10 ${randomUUID().slice(0, 6)}`, { verifier: false });
      const stores = await w.owner$.observe<{ store: string; forced: boolean; wall: string }>('catalog.stores');
      expect(stores.length).toBeGreaterThan(0);
      expect(stores.filter((s) => !s.forced || s.wall !== 'exact').map((s) => s.store)).toEqual([]);
    },
  },
];
