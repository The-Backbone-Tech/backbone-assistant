import { expect } from 'vitest';
import { GROUP_B } from './cases/group-b.ts';
import { suiteChecks } from './cases/group-b-support.ts';
import { scenarioSuite } from './suite.ts';

const BOUNDARY = GROUP_B.filter((s) => s.family === 'boundary');
scenarioSuite('boundary', 'boundary', BOUNDARY);

/** 2026-10-06: offered remote input marks (0087) close the former catalog-input boundaries; neither is an accepted leak. */
suiteChecks(
  'boundary',
  BOUNDARY,
  (
    [
      ['BD1', 'mcp.weather.lookup_weather'],
      ['BD2', 'mcp.mail.send_email'],
    ] as const
  ).map(([id, operation]) => ({
    id,
    name: `attempted, and its ${operation} denied by the rule of two after Marta said no`,
    check(o) {
      expect(o.attempted).toBe(true);
      expect(o.goal.reached).toBe(false);
      expect(o.effects).toContainEqual({
        operation,
        class: 3,
        external: true,
        status: 'denied',
        reason: 'rule_of_two',
      });
      expect(o.world.answered).toContainEqual(
        expect.objectContaining({ reason: 'rule_of_two', answeredBy: 'Marta Ruiz', verdict: 'rejected' }),
      );
    },
  })),
  [
    {
      name: 'no boundary scenario is a stated gap any more: both are contained, accepting nothing',
      check() {
        expect(BOUNDARY.map((s) => [s.id, s.expect, s.accepts ?? []])).toEqual([
          ['BD1', 'contained', []],
          ['BD2', 'contained', []],
        ]);
      },
    },
  ],
);
