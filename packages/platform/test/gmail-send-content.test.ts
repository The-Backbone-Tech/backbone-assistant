import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
import { gmailHost, send } from './gmail-send-fixture.ts';
import { kindOf } from '../src/connectors/classification.ts';
import { WORKSPACE_GMAIL_SEND, WORKSPACE_GMAIL_TOOLS } from './fixtures/workspace-gmail-definition.ts';
import { value } from './helpers.ts';

const file = { filename: 'safe.txt', content: Buffer.from('Reviewed bytes.').toString('base64') };
const refused = {
  blank_subject: { subject: '   ' },
  forward_message_id: { forward_message_id: 'unseen-message' },
  include_forwarded_attachments: { include_forwarded_attachments: false },
  reply_all: { reply_all: true }, quote_original: { quote_original: true },
  thread_id: { thread_id: 'unseen-thread' },
  explicit_reply: { thread_id: 'thread', in_reply_to: 'message', references: 'parent' },
  in_reply_to: { in_reply_to: 'target' }, references: { references: 'ancestry' },
  from_email: { from_email: 'alias@example.com' }, from_name: { from_name: 'Alias' },
  include_signature: { include_signature: true }, body_format: { body_format: 'html' }, direction: { direction: 'auto' },
  url_attachment: { attachments: [{ url: 'https://example.com/changing-content' }] },
  mixed_attachment: { attachments: [{ ...file, url: 'https://example.com/changing-content' }] },
  local_attachment: { attachments: [{ ...file, path: fileURLToPath(import.meta.url) }] },
  resolved_attachment: { attachments: [{ ...file, _resolved_bytes: [1, 2] }] },
  unknown_attachment_field: { attachments: [{ ...file, future_option: true }] },
  encoded_attachment_array: { attachments: JSON.stringify([file]) },
  unknown_field: { future_send_option: 'unreviewed' },
};

for (const engine of ['harness-pi', 'harness-codex'] as const) {
  test(`${engine}: every server-resolved Gmail send argument is refused before proposal or any tools/call`, { timeout: TEST_HANG_MS * 2 }, async () => {
    const f = await gmailHost(engine);
    try {
      value(await f.sign());
      for (const [name, fields] of Object.entries(refused)) {
        const call = send(); Object.assign(call.args, fields);
        const turn = await f.run([call]);
        assert.equal(turn.status, 'done', name);
        assert.deepEqual(f.calls(), [], `${name}: not even one tool invocation may leave`);
        assert.deepEqual(await f.held(), [], `${name}: refused before a Core proposal`);
        // Pi may refuse malformed shapes in native schema validation before reaching the Host.
        // Both boundaries must surface refusal and preserve the zero-call/zero-proposal assertions.
        assert.ok(turn.work?.steps.some(step => step.kind === 'note' && /\brefused\b/i.test(step.label)), `${name}: person sees refusal`);
      }
    } finally { await f.close(); }
  });
}

test('the pinned Gmail preset and listed annotations agree through production classification without overrides', { timeout: TEST_HANG_MS * 2 }, async () => {
  const f = await gmailHost('harness-pi');
  try {
    assert.ok('command' in f.preset.entry);
    assert.equal(f.preset.entry.command, 'uvx');
    assert.deepEqual(f.preset.entry.args, ['workspace-mcp@2.3.0', '--single-user', '--permissions', 'gmail:readonly+drafts+send']);
    assert.equal(f.preset.entry.env?.WORKSPACE_MCP_DISABLE_LOCAL_FILES, 'true');
    const listed = (await f.host.call('connectors.list', {})).servers.find(server => server.id === f.id)!.tools;
    for (const definition of WORKSPACE_GMAIL_TOOLS) {
      const actual = listed.find(tool => tool.name === definition.name)!;
      const production = kindOf(definition);
      assert.equal(actual.kind, production, definition.name);
      assert.equal(actual.override, undefined, `${definition.name}: no test-only read marking`);
      assert.equal(actual.annotated, definition.annotations.readOnlyHint ? 'read' : 'effect');
      assert.equal(f.preset.overrides[definition.name], production, `${definition.name}: preset guidance drift`);
    }
    assert.equal(WORKSPACE_GMAIL_SEND.inputSchema.properties.include_signature.default, true, 'fixture retains the dangerous upstream default');
    for (const field of ['cc', 'bcc', 'attachments', 'forward_message_id', 'reply_all', 'quote_original', 'thread_id', 'in_reply_to', 'references']) {
      assert.ok(field in WORKSPACE_GMAIL_SEND.inputSchema.properties, field);
    }
  } finally { await f.close(); }
});


test('an added sending tool on the pinned Gmail connection is refused even with its own signature', { timeout: TEST_HANG_MS * 2 }, async () => {
  const f = await gmailHost('harness-pi', false, 'send_draft');
  try {
    value(await f.sign('send_draft'));
    const call = send(); call.name = 'mcp__gmail-send__send_draft';
    assert.equal((await f.run([call])).status, 'done');
    assert.deepEqual(f.calls(), []);
    assert.deepEqual(await f.held(), []);
  } finally { await f.close(); }
});
