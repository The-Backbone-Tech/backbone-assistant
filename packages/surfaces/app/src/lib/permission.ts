// A tool's permission in one line of plain words, for the Settings row and the main process's
// confirmation: "write files to Assistant’s outbox · up to medium risk · until 25 Nov 2026".
import { CEILING_WORDS } from '@backbone-next/platform';

export const operationWords = (op: string, appName: string) => (op === 'outbox.write' ? `write files to ${appName}’s outbox` : op);
export const untilWords = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export function permissionWords(p: { operations: string[]; ceiling: number; expiresAt: string }, appName: string): string {
  return `${p.operations.map((op) => operationWords(op, appName)).join(', ')} · up to ${CEILING_WORDS[p.ceiling] ?? `class ${p.ceiling}`} · until ${untilWords(p.expiresAt)}`;
}
