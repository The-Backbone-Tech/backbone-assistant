import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { prepareGmailSend as prepare, gmailSendRefusal as refusal } from '../src/connectors/gmail-send-arguments.ts';

const launch = { transport: 'stdio' as const, command: 'uvx', args: ['workspace-mcp@2.3.0', '--single-user', '--permissions', 'gmail:readonly+drafts+send'], env: { WORKSPACE_MCP_DISABLE_LOCAL_FILES: 'true' } };
const prepareGmailSend = (tool: string, args: Record<string, unknown>) => prepare(tool, args, launch);
const gmailSendRefusal = (tool: string, args: Record<string, unknown>) => refusal(tool, args, launch);

const message = () => ({ user_google_email: 'person@example.com', to: 'to@example.com', subject: 'Reviewed', body: 'Exactly this body.' });
const attachment = () => ({ filename: 'note.txt', mime_type: 'text/plain', content: Buffer.from('Exactly these bytes.').toString('base64') });

test('Gmail proposals contain only explicit message content and the fixed no-signature control', () => {
  const input = { ...message(), cc: 'cc@example.com', bcc: 'bcc@example.com', attachments: [attachment()] };
  const before = structuredClone(input), prepared = prepareGmailSend('send_gmail_message', input);
  assert.ok(prepared.ok);
  assert.deepEqual(prepared.args, { ...input, include_signature: false });
  assert.deepEqual(prepared.intentArgs, input, 'the original request identity survives dispatch-default normalization');
  assert.deepEqual(input, before, 'preparation cannot mutate caller-owned content');
  assert.equal(gmailSendRefusal('send_gmail_message', prepared.args), undefined);
  assert.ok(gmailSendRefusal('send_gmail_message', input), 'historical proposals without the no-signature control cannot dispatch');
});

test('Gmail refuses every server-resolved or unknown field, including false and null values', () => {
  for (const [field, value] of Object.entries({ forward_message_id: 'source', include_forwarded_attachments: false,
    reply_all: false, quote_original: false, thread_id: null, in_reply_to: 'target', references: 'chain',
    from_email: 'alias@example.com', from_name: 'Alias', body_format: 'plain', direction: 'auto',
    include_signature: true, surprise: 'unknown' })) {
    const prepared = prepareGmailSend('send_gmail_message', { ...message(), [field]: value });
    assert.equal(prepared.ok, false, field);
    assert.ok(gmailSendRefusal('send_gmail_message', { ...message(), include_signature: false, [field]: value }), field);
  }
});

test('Gmail accepts only complete inline base64 attachments, without coercion or hidden sources', () => {
  for (const value of [null, '[]', {}, [{ ...attachment(), url: 'https://example.com/changes' }],
    [{ ...attachment(), path: fileURLToPath(import.meta.url) }], [{ ...attachment(), _resolved_bytes: [1] }],
    [{ ...attachment(), content_id: 'hidden' }], [{ ...attachment(), surprise: true }],
    [{ ...attachment(), filename: 'bad\r\nname' }], [{ ...attachment(), mime_type: 'text/plain\r\nBcc: hidden' }],
    [{ ...attachment(), content: 'not base64!' }], [{ ...attachment(), content: '' }],
    [{ content: attachment().content }], [{ filename: 'missing.txt' }]]) {
    assert.equal(prepareGmailSend('send_gmail_message', { ...message(), attachments: value }).ok, false, JSON.stringify(value));
  }
  for (const field of ['to', 'subject', 'body', 'user_google_email']) {
    const args: Record<string, unknown> = message(); delete args[field];
    assert.equal(prepareGmailSend('send_gmail_message', args).ok, false, field);
  }
  for (const field of ['to', 'cc', 'bcc', 'subject', 'user_google_email']) {
    assert.equal(prepareGmailSend('send_gmail_message', { ...message(), [field]: 'visible\r\nBcc: hidden@example.com' }).ok, false, field);
  }
});

test('the Gmail rule does not alter a different connector tool', () => {
  const args = { thread_id: 'allowed-by-its-own-tool', url: 'https://example.com/' };
  assert.deepEqual(prepareGmailSend('draft_gmail_message', args), { ok: true, args });
  assert.equal(refusal('send_record_message', args, { transport: 'stdio', command: 'other', args: [] }), undefined);
});


test('Gmail refuses a blank subject before an upstream error can become UNKNOWN', () => {
  for (const subject of ['', '   ', '\t']) assert.equal(prepareGmailSend('send_gmail_message', { ...message(), subject }).ok, false);
});


test('the reviewed Gmail server pin refuses an upgrade or any newly added sending tool', () => {
  for (const changed of [{ ...launch, args: launch.args.map(a => a.replace('@2.3.0', '@2.4.0')) },
    { ...launch, command: 'other-server' }, { ...launch, env: {} }]) {
    for (const tool of ['send_gmail_message', 'draft_gmail_message', 'send_draft', 'new_unreviewed_tool']) {
      assert.equal(prepare(tool, message(), changed).ok, false);
      assert.ok(refusal(tool, { ...message(), include_signature: false }, changed));
    }
  }
  const draft = { ...launch, args: ['workspace-mcp@2.3.0', '--single-user', '--permissions', 'gmail:readonly+drafts', '--disabled-tools', 'send_gmail_message'], env: {} };
  assert.equal(prepare('search_gmail_messages', { query: 'reviewed' }, draft).ok, true, 'the existing read/draft preset remains usable');
  assert.equal(prepare('send_draft', message(), draft).ok, false);
  assert.equal(prepare('send_draft', message(), launch).ok, false);
  for (const changed of [{ transport: 'http' as const, url: 'https://example.com/new-server' },
    { transport: 'stdio' as const, command: 'new-gmail-server', args: [] }]) {
    assert.equal(prepare('new_send_tool', message(), changed, 'home:gmail-send').ok, false, 'the stable server identity cannot escape through a changed launch style');
  }
  assert.equal(prepare('send_gmail_message', { other: true }, { transport: 'stdio', command: 'other-server', args: [] }).ok, true,
    'the policy is scoped to the reviewed connector family, not a bare tool name');
});
