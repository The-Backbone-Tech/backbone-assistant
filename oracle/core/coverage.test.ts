import { describe, expect, it } from 'vitest';
import type { Coverage } from './coverage.ts';
import { legacyCases } from './coverage.ts';
import { coverage as effects } from './effects/coverage.ts';
import { coverage as isolation } from './isolation/coverage.ts';
import { coverage as ledger } from './ledger/coverage.ts';
import { coverage as mandates } from './mandates/coverage.ts';
import { coverage as promotion } from './promotion/coverage.ts';
import { coverage as ruleOfTwo } from './rule-of-two/coverage.ts';

/** In the plan's port order. */
export const PROMISES: readonly Coverage[] = [isolation, mandates, effects, ledger, promotion, ruleOfTwo];
const STATUSES = ['ported', 'narrowed', 'adversary', 'gap', 'deferred'];

describe('every legacy case of the core promises is accounted for, once', () => {
  for (const promise of PROMISES) {
    it(`${promise.promise}: the inventory lists exactly the legacy cases, each with a status`, async () => {
      const legacy = (await Promise.all(promise.legacyFiles.map(legacyCases))).flat();
      expect(Object.keys(promise.cases).sort()).toEqual([...legacy].sort());
      const gapIds = new Set(promise.gaps.map((g) => g.id));
      for (const [name, entry] of Object.entries(promise.cases)) {
        expect(STATUSES, name).toContain(entry.status);
        if (entry.status === 'gap') expect(gapIds.has(entry.gap ?? ''), `${name} names gap ${entry.gap}`).toBe(true);
        if (['ported', 'narrowed', 'adversary'].includes(entry.status)) {
          expect(entry.oracle?.length ?? 0, `${name} names its oracle case`).toBeGreaterThan(0);
        }
        if (entry.status === 'narrowed' || entry.status === 'deferred') expect(entry.note, name).toBeTruthy();
      }
    });
  }
});
