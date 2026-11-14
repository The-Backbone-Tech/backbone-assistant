// The operation class of a mail request, from the request itself (work-planes-lab decision 0007,
// point 4: assigned by the adapter from the effect, never from command strings). The shape is
// Gmail's (`users.messages.modify` with label ids; moves are label changes on INBOX, SPAM and
// TRASH), which Graph's moves and categories map onto. Every field is checked: an unknown
// operation, an unknown argument or an unknown label is refused, never guessed.
import type { Classification, ClassifiedOperation, MailLabel, MailRequest } from '@backbone-next/platform/ports/mail';

const KEYS: Record<string, { required: string[]; optional: string[] }> = {
  list: { required: ['op'], optional: ['after'] },
  read: { required: ['op', 'id'], optional: [] },
  labels: { required: ['op'], optional: [] },
  modify: { required: ['op', 'id', 'version', 'add', 'remove'], optional: [] },
};
/** System labels a change may add or remove; SENT and DRAFT are never touched. */
const MAY_ADD = new Set(['INBOX', 'SPAM', 'TRASH', 'UNREAD']);
const MAY_REMOVE = new Set(['INBOX', 'UNREAD', 'SPAM', 'TRASH']);
const ID = /^[A-Za-z0-9_.@:-]{1,200}$/;

const refuse = (reason: string): Classification => ({ ok: false, reason });
const read = (operation: string, args: Record<string, unknown>, summary: string): Classification => ({
  ok: true,
  value: { operation, effectClass: 1, external: true, read: true, recovery: null, undo: null, args, summary },
});

export function classifyMailRequest(request: MailRequest, labels: MailLabel[]): Classification {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return refuse('a request is an object');
  const r = request as unknown as Record<string, unknown>;
  const shape = typeof r.op === 'string' ? KEYS[r.op] : undefined;
  if (!shape) return refuse('unknown operation: a mail connector lists, reads and changes labels, nothing else');
  for (const k of Object.keys(r)) if (!shape.required.includes(k) && !shape.optional.includes(k)) return refuse('unknown argument');
  for (const k of shape.required) if (r[k] === undefined) return refuse(`missing argument: ${k}`);

  switch (r.op) {
    case 'list':
      if (r.after !== undefined && (typeof r.after !== 'string' || !/^\d{0,20}$/.test(r.after))) return refuse('after is a cursor this connector gave');
      return read('mail.list', r.after === undefined ? { op: 'list' } : { op: 'list', after: r.after }, 'Listed the inbox');
    case 'read':
      if (typeof r.id !== 'string' || !ID.test(r.id)) return refuse('id names one message');
      return read('mail.read', { op: 'read', id: r.id }, `Read message ${r.id}`);
    case 'labels':
      return read('mail.labels', { op: 'labels' }, 'Listed the labels');
    default:
      return modify(r, labels);
  }
}

function modify(r: Record<string, unknown>, labels: MailLabel[]): Classification {
  if (typeof r.id !== 'string' || !ID.test(r.id)) return refuse('id names one message');
  if (typeof r.version !== 'string' || !/^\d{1,20}$/.test(r.version)) return refuse('version is the one the message was read at');
  const lists = [r.add, r.remove];
  if (!lists.every((l) => Array.isArray(l) && l.every((x) => typeof x === 'string'))) return refuse('add and remove are lists of label ids');
  const add = [...new Set(r.add as string[])].sort();
  const remove = [...new Set(r.remove as string[])].sort();
  if (!add.length && !remove.length) return refuse('a change adds or removes at least one label');
  if (add.some((x) => remove.includes(x))) return refuse('a label is both added and removed');
  const known = new Map(labels.map((l) => [l.id, l]));
  for (const id of [...add, ...remove]) if (!known.has(id)) return refuse('unknown label');
  if (add.some((id) => known.get(id)!.system && !MAY_ADD.has(id))) return refuse('that system label is never added');
  if (remove.some((id) => known.get(id)!.system && !MAY_REMOVE.has(id))) return refuse('that system label is never removed');

  const args = { op: 'modify', id: r.id, version: r.version, add, remove };
  // The provider's next version and actual label differences are not known until apply succeeds.
  const undo = null;
  const name = (id: string) => known.get(id)!.name;
  let value: ClassifiedOperation;
  if (add.includes('TRASH')) {
    // Restorable from Trash until the provider empties it (Gmail: 30 days), then gone.
    value = { operation: 'mail.trash', effectClass: 4, external: true, read: false, recovery: 'bounded-cancellation', undo, args, summary: 'Move to Trash' };
  } else if (add.includes('SPAM') || add.includes('INBOX') || remove.includes('INBOX') || remove.includes('SPAM') || remove.includes('TRASH')) {
    const to = add.includes('SPAM') ? 'Spam' : add.includes('INBOX') ? 'Inbox' : 'Archive';
    const labelled = add.filter((x) => !known.get(x)!.system).map(name);
    value = { operation: 'mail.move', effectClass: 3, external: true, read: false, recovery: 'exact-undo', undo, args, summary: `Move to ${to}${labelled.length ? `, labelled ${labelled.join(', ')}` : ''}` };
  } else {
    const parts = [...add.map((x) => `add ${name(x)}`), ...remove.map((x) => `remove ${name(x)}`)];
    value = { operation: 'mail.label', effectClass: 3, external: true, read: false, recovery: 'exact-undo', undo, args, summary: `Label: ${parts.join(', ')}` };
  }
  return { ok: true, value };
}
