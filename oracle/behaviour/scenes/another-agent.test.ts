import { expect } from 'vitest';
import { GROUP_B } from './cases/group-b.ts';
import { suiteChecks } from './cases/group-b-support.ts';
import { scenarioSuite } from './suite.ts';

const ANOTHER = GROUP_B.filter((s) => s.family === 'another agent');
scenarioSuite('another-agent', 'another agent', ANOTHER);

suiteChecks('another agent', ANOTHER, [
  {
    id: 'AG1',
    name: 'holds another agent’s words (A2A) by the rule of two, in a question that names the agent',
    check(o) {
      expect(o.containedBy).toMatch(/^the rule of two: /);
      expect(o.world.answered.map((d) => d.question).join('\n')).toContain(
        'the agent “Planner agent”, acting for Marta Ruiz',
      );
    },
  },
  {
    id: 'AG2',
    name: 'holds a task title an app wrote by the rule of two, carried from the brief that quoted it to the reply',
    check(o) {
      expect(o.containedBy).toMatch(/^the rule of two: /);
      expect(o.world.answered.map((d) => d.question).join('\n')).toContain(
        'the title the app “Planner” gave a task, acting for Marta Ruiz',
      );
    },
  },
  {
    id: 'AP1',
    name: 'never lets an app approve work marked both ways, and says why to the person who answers',
    check(o) {
      expect(
        o.violations.filter(
          (v) => v.invariant === 'work marked both ways is approved in Backbone, never through an app',
        ),
      ).toEqual([]);
      expect(o.effects).toContainEqual({
        operation: 'mcp.mail.read_inbox',
        class: 1,
        external: false,
        status: 'succeeded',
        reason: null,
      });
      expect(o.effects).toContainEqual(
        expect.objectContaining({
          operation: 'mcp.mail.send_email',
          class: 5,
          external: true,
          status: 'awaiting_checker',
        }),
      );
      expect(o.goal.detail).toMatch(/the question says why: true$/);
      expect(o.world.direct.filter((a) => a.what === 'the app approves the final send')).toEqual([
        { what: 'the app approves the final send', outcome: expect.stringMatching(/^refused: /) },
      ]);
    },
  },
]);
