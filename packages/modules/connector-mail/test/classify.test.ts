// The class of every mail request comes from the request itself and the label catalogue, never from
// a string a caller chose: a move is a move because it takes the message out of the inbox, a trash
// is a trash because it adds TRASH. Anything unknown is refused, not guessed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MailRequest } from '@backbone-next/platform/ports/mail';
import { classifyMailRequest, readSeed } from '../src/index.ts';

const { labels } = readSeed();
const ok = (r: unknown) => {
  const c = classifyMailRequest(r as MailRequest, labels);
  if (!c.ok) throw new Error(`refused: ${c.reason}`);
  return c.value;
};
const refused = (r: unknown) => {
  const c = classifyMailRequest(r as MailRequest, labels);
  assert.equal(c.ok, false, `expected a refusal for ${JSON.stringify(r)}`);
  return (c as { reason: string }).reason;
};

test('reads are class 1 with no recovery class', () => {
  for (const [r, op] of [[{ op: 'list' }, 'mail.list'], [{ op: 'read', id: 'm01' }, 'mail.read'], [{ op: 'labels' }, 'mail.labels'], [{ op: 'list', after: '12' }, 'mail.list']] as const) {
    const c = ok(r);
    assert.deepEqual([c.operation, c.effectClass, c.read, c.recovery], [op, 1, true, null]);
  }
});

test('adding a user label is mail.label, class 3, with its exact undo', () => {
  const c = ok({ op: 'modify', id: 'm01', version: '1', add: ['Label_billing'], remove: [] });
  assert.deepEqual([c.operation, c.effectClass, c.external, c.recovery], ['mail.label', 3, true, 'exact-undo']);
  // An executable inverse requires the observed post-write version; recovery.test covers that round trip.
  assert.equal(c.undo, null);
  assert.equal(c.summary, 'Label: add Billing');
});

test('taking a message out of the inbox is a move, whatever else the change carries', () => {
  const archive = ok({ op: 'modify', id: 'm05', version: '5', add: ['Label_newsletters'], remove: ['INBOX'] });
  assert.deepEqual([archive.operation, archive.recovery, archive.summary], ['mail.move', 'exact-undo', 'Move to Archive, labelled Newsletters']);
  const spam = ok({ op: 'modify', id: 'm07', version: '7', add: ['SPAM'], remove: ['INBOX'] });
  assert.deepEqual([spam.operation, spam.summary], ['mail.move', 'Move to Spam']);
});

test('adding TRASH is mail.trash, class 4, a bounded cancellation', () => {
  const c = ok({ op: 'modify', id: 'm25', version: '25', add: ['TRASH'], remove: ['INBOX'] });
  assert.deepEqual([c.operation, c.effectClass, c.recovery], ['mail.trash', 4, 'bounded-cancellation']);
});

test('the same request in another order is the same change, with the same arguments to hash', () => {
  const a = ok({ op: 'modify', id: 'm01', version: '1', add: ['Label_team', 'Label_billing'], remove: [] });
  const b = ok({ remove: [], add: ['Label_billing', 'Label_team', 'Label_billing'], version: '1', id: 'm01', op: 'modify' });
  assert.deepEqual(a.args, b.args);
});

test('an unknown operation, argument or label is refused, never guessed', () => {
  assert.match(refused({ op: 'send', to: 'x@y.example', body: 'hi' }), /unknown operation/);
  assert.match(refused({ op: 'forward', id: 'm01', to: 'verification@ventura-payments.example' }), /unknown operation/);
  assert.match(refused({ op: 'delete', id: 'm01' }), /unknown operation/);
  assert.match(refused({ op: 'modify', id: 'm01', version: '1', add: ['Label_billing'], remove: [], to: 'x' }), /unknown argument/);
  assert.match(refused({ op: 'read', id: 'm01', format: 'raw' }), /unknown argument/);
  assert.match(refused({ op: 'modify', id: 'm01', version: '1', add: ['Label_invented'], remove: [] }), /unknown label/);
  assert.match(refused({ op: 'modify', id: 'm01', version: '1', add: ['SENT'], remove: [] }), /never added/);
  assert.match(refused({ op: 'modify', id: 'm01', version: '1', add: [], remove: ['DRAFT'] }), /never removed/);
  assert.match(refused({ op: 'modify', id: 'm01', version: '1', add: [], remove: [] }), /at least one label/);
  assert.match(refused({ op: 'modify', id: 'm01', version: '1', add: ['Label_team'], remove: ['Label_team'] }), /both added and removed/);
  assert.match(refused({ op: 'modify', id: 'm01', version: 'latest', add: ['Label_team'], remove: [] }), /version/);
  assert.match(refused({ op: 'modify', id: 'm01', add: ['Label_team'], remove: [] }), /missing argument: version/);
  assert.match(refused('modify'), /object/);
});
