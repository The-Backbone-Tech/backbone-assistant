import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { SCENES } from './cases/index.ts';

/**
 * Every scenario id the legacy harness defines (packages/evals/src/scenarios.ts, skill-scenarios.ts
 * and scenario-support.ts of the old repository), read from their syntax trees at the frozen head and
 * kept in legacy-scenarios.json.
 */
async function legacyIds(): Promise<string[]> {
  const frozen = JSON.parse(await readFile(new URL('./legacy-scenarios.json', import.meta.url), 'utf8')) as { scenarios: string[] };
  return frozen.scenarios;
}

describe('every legacy attack scenario is restated once', () => {
  it('the oracle’s scenarios are exactly the legacy harness’s', async () => {
    const oracle = SCENES.map((s) => s.id);
    expect(new Set(oracle).size).toBe(oracle.length);
    expect([...oracle].sort()).toEqual([...new Set(await legacyIds())].sort());
  });
});
