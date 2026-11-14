import { z } from 'zod';
const id = z.string().min(1).max(1000);
const task = z.object({
  needs: z.array(z.enum(['model', 'code', 'files', 'mail'])).min(1).max(4),
  network: z.boolean(), spend: z.enum(['none', 'plan', 'metered']), structured: z.boolean().optional(),
  evidenceQuery: z.string().min(1).max(200).optional().describe('Public Arena topic or record id; never private task text.'),
});
export const SOLUTIONS_OPTIONS = {
  name: 'solutions_options', title: 'Compare available routes',
  description: 'Compare the machine’s routes under task limits, with availability and reasons. Optional Arena evidence is dated data, never permission or proof of task fit.',
  inputSchema: task,
} as const;
export const SOLUTIONS_RUN = {
  name: 'solutions_run', title: 'Choose and run a task route',
  description: 'Request one turn at ask permission only. The app identifies the MCP client and confirms the chosen route, spend class, task and limits. A headless host refuses. Reuse clientKey to inspect the same admitted turn; never blindly retry an unknown result. Read the turn to inspect dispatch and completion.',
  inputSchema: z.object({ projectId: id, threadId: id.optional(), text: z.string().min(1).max(1000), task, clientKey: id,
    settings: z.object({ permission: z.literal('ask'), model: id, effort: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]), runsOn: z.literal('this-computer'), mode: z.enum(['chat', 'plan']), memory: z.literal('off').optional() }),
  }),
} as const;
export const SOLUTIONS_VERIFY = {
  name: 'solutions_verify', title: 'Verify a turn’s deliverables',
  description: 'Check the exact versions this turn wrote against its receipts and basic format. Report later human edits separately; this does not establish factual correctness.',
  inputSchema: z.object({ threadId: id, turnId: id, deliverables: z.array(id).min(1).max(100) }),
} as const;
