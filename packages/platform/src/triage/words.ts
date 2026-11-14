import type { MailLabel, MailRequest } from '../ports/mail.ts';

export function undoWords(undo: Pick<Extract<MailRequest, { op: 'modify' }>, 'add' | 'remove'>, labels: MailLabel[]): string {
  const name = (id: string) => (id === 'INBOX' ? 'the inbox' : (labels.find((l) => l.id === id)?.name ?? id));
  const parts = [...undo.add.map((x) => (x === 'INBOX' ? 'Move it back to the inbox' : `Add ${name(x)} back`)), ...undo.remove.map((x) => (x === 'SPAM' ? 'Take it out of Spam' : `Remove the label ${name(x)}`))];
  return parts.join('; ');
}
