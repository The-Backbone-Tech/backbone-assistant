import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  attenuate,
  type Budget,
  canTransition,
  EFFECT_STATUSES,
  type EffectClass,
  intersectBudget,
  isWithin,
  type MandateTerms,
  normalizeTerms,
  type RouteInput,
  route,
  type SetSpec,
} from '../src/kernel/index.ts';

const ids = fc.constantFrom('a', 'b', 'c', 'd');
const setSpec: fc.Arbitrary<SetSpec> = fc.oneof(fc.constant<'*'>('*'), fc.uniqueArray(ids, { maxLength: 4 }));
const limit = fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 1_000 }));
const budget: fc.Arbitrary<Budget> = fc.record({ maxTokens: limit, maxCostMicros: limit, maxDurationMs: limit, maxEffects: limit });
const terms: fc.Arbitrary<MandateTerms> = fc.record({
  projects: setSpec,
  connections: setSpec,
  tools: setSpec,
  operations: setSpec,
  ceiling: fc.constantFrom(1, 2, 3, 4),
  budget,
  expiresAt: fc.integer({ min: 1_000_000, max: 2_000_000 }),
});

describe('attenuation (I-3): a child is the request intersected with its parent', () => {
  it('never exceeds the parent, nor the request', () => {
    fc.assert(
      fc.property(terms, terms, (parent, requested) => {
        const child = attenuate(parent, requested);
        expect(isWithin(child, parent)).toBe(true);
        expect(isWithin(child, requested)).toBe(true);
      }),
    );
  });

  it('is idempotent and keeps whatever already fits', () => {
    fc.assert(
      fc.property(terms, terms, (parent, requested) => {
        const child = attenuate(parent, requested);
        expect(normalizeTerms(attenuate(parent, child))).toEqual(normalizeTerms(child));
        if (isWithin(requested, parent)) expect(normalizeTerms(child)).toEqual(normalizeTerms(requested));
      }),
    );
  });

  it('a wildcard means everything the parent covers, and an absent limit is the parent’s', () => {
    const parent: MandateTerms = {
      projects: ['p'],
      connections: '*',
      tools: ['search', 'mail'],
      operations: '*',
      ceiling: 3,
      budget: { maxTokens: 100, maxCostMicros: null, maxDurationMs: null, maxEffects: 2 },
      expiresAt: 10,
    };
    const child = attenuate(parent, { ...parent, projects: '*', tools: ['mail', 'pay'], ceiling: 4, budget: { maxTokens: null, maxCostMicros: 5, maxDurationMs: null, maxEffects: 9 }, expiresAt: 99 });
    expect(child).toEqual({ ...parent, tools: ['mail'], budget: { maxTokens: 100, maxCostMicros: 5, maxDurationMs: null, maxEffects: 2 } });
    expect(intersectBudget(parent.budget, { maxTokens: 7, maxCostMicros: null, maxDurationMs: 1, maxEffects: null })).toEqual({
      maxTokens: 7,
      maxCostMicros: null,
      maxDurationMs: 1,
      maxEffects: 2,
    });
  });

  it('a child naming what its parent does not cover is not within it', () => {
    const parent: MandateTerms = { projects: '*', connections: ['crm'], tools: '*', operations: '*', ceiling: 2, budget: { maxTokens: null, maxCostMicros: null, maxDurationMs: null, maxEffects: null }, expiresAt: 5 };
    expect(isWithin({ ...parent, connections: '*' }, parent)).toBe(false);
    expect(isWithin({ ...parent, ceiling: 3 }, parent)).toBe(false);
    expect(isWithin({ ...parent, expiresAt: 6 }, parent)).toBe(false);
    expect(isWithin(parent, { ...parent, budget: { ...parent.budget, maxEffects: 1 } })).toBe(false);
  });
});

const input = (o: Partial<RouteInput>): RouteInput => ({
  effectClass: 3,
  standing: 'ok',
  ceiling: 4,
  taint: { untrustedInput: false, sensitiveData: false },
  externalParty: true,
  outboundFixed: false,
  ...o,
});
const both = { untrustedInput: true, sensitiveData: true };

describe('routing (I-5, I-7): classes decide the route; the rule of two sends outward work to a checker', () => {
  it('a mandate that does not stand denies, for its own reason', () => {
    for (const standing of ['outside_mandate', 'mandate_expired', 'mandate_revoked', 'budget_exhausted', 'already_rejected'] as const) {
      expect(route(input({ standing, effectClass: 6 }))).toEqual({ kind: 'denied', reason: standing });
    }
  });

  it('elevation and final effects always need a checker', () => {
    expect(route(input({ effectClass: 6 }))).toEqual({ kind: 'needs_checker', reason: 'elevation' });
    expect(route(input({ effectClass: 5, ceiling: 4 }))).toEqual({ kind: 'needs_checker', reason: 'final' });
  });

  it('a read is free unless it carries private material out after untrusted content, with its arguments not fixed', () => {
    expect(route(input({ effectClass: 1 }))).toEqual({ kind: 'free' });
    expect(route(input({ effectClass: 1, taint: both }))).toEqual({ kind: 'needs_checker', reason: 'rule_of_two' });
    expect(route(input({ effectClass: 1, taint: both, outboundFixed: true }))).toEqual({ kind: 'free' });
    expect(route(input({ effectClass: 1, taint: both, externalParty: false }))).toEqual({ kind: 'free' });
  });

  it('external changes of a run marked both ways need a checker; one mark is not enough', () => {
    expect(route(input({ effectClass: 3, taint: both }))).toEqual({ kind: 'needs_checker', reason: 'rule_of_two' });
    expect(route(input({ effectClass: 4, taint: both }))).toEqual({ kind: 'needs_checker', reason: 'rule_of_two' });
    expect(route(input({ effectClass: 3, taint: { untrustedInput: true, sensitiveData: false } }))).toEqual({ kind: 'allowed' });
    expect(route(input({ effectClass: 2, taint: both }))).toEqual({ kind: 'allowed' });
  });

  it('above the ceiling goes to a checker; a delayable change inside it waits out the window', () => {
    expect(route(input({ effectClass: 4, ceiling: 3 }))).toEqual({ kind: 'needs_checker', reason: 'above_ceiling' });
    expect(route(input({ effectClass: 4 }))).toEqual({ kind: 'allowed_after_window' });
    expect(route(input({ effectClass: 2, ceiling: 1 }))).toEqual({ kind: 'needs_checker', reason: 'above_ceiling' });
  });

  it('every class and standing has exactly one route', () => {
    for (const effectClass of [1, 2, 3, 4, 5, 6] as EffectClass[]) expect(route(input({ effectClass })).kind).toBeTruthy();
  });
});

describe('the effect lifecycle (I-6): forward only, and once dispatch begins only observation remains', () => {
  it('terminal states lead nowhere and nothing returns to proposed', () => {
    for (const to of EFFECT_STATUSES) {
      for (const from of ['denied', 'succeeded', 'failed', 'cancelled'] as const) expect(canTransition(from, to)).toBe(false);
      expect(canTransition(to, 'proposed')).toBe(false);
    }
  });

  it('dispatching and unknown cannot be cancelled or resent', () => {
    for (const from of ['dispatching', 'unknown'] as const) {
      expect(canTransition(from, 'cancelled')).toBe(false);
      expect(canTransition(from, 'allowed')).toBe(false);
      expect(canTransition(from, 'claimed')).toBe(false);
    }
    expect(canTransition('dispatching', 'unknown')).toBe(true);
    expect(canTransition('unknown', 'succeeded')).toBe(true);
    expect(canTransition('claimed', 'allowed')).toBe(true);
  });
});
