// A rubric narrows the completion assessment. These are model findings, never executable commands
// or proof that an outside effect happened. Ambiguous, duplicate and empty findings fail closed.
import type { GoalRun } from '../api.ts';

export function rubricText(rubric: string[] = []): string {
  return rubric.length ? '\n\nRequired rubric:\n' + rubric.map((criterion, i) => `${i + 1}. ${criterion}`).join('\n') : '';
}

export function checkGoalRubric(answer: string, rubric: string[]): NonNullable<GoalRun['rubricResults']> {
  const findings = [...answer.matchAll(/^[\t ]*(PASS|FAIL|BLOCKED)[\t ]+(\d+)[\t ]*:[\t ]*([^\r\n]*)$/gim)];
  return rubric.map((criterion, i) => {
    const matches = findings.filter(match => Number(match[2]) === i + 1);
    const evidence = matches.length === 1 ? matches[0][3].trim() : '';
    const passed = matches.length === 1 && matches[0][1].toUpperCase() === 'PASS' && !!evidence;
    return { criterion, passed, ...(evidence ? { evidence } : {}) };
  });
}
