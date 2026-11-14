// Source-transcribed from workspace-mcp v2.3.0, gmail/gmail_tools.py, read 12 Nov 2026:
// https://github.com/taylorwilsdon/google_workspace_mcp/blob/v2.3.0/gmail/gmail_tools.py
// All send parameters, types, defaults and annotations are retained. This is a local stand-in,
// not a live FastMCP listing or evidence that Python, OAuth or Gmail ran.
const nullableString = () => ({ anyOf: [{ type: 'string' }, { type: 'null' }], default: null });
export const WORKSPACE_GMAIL_SEND = {
  name: 'send_gmail_message', title: 'Send Gmail Message', description: 'Send a new message, reply or forward through Gmail.',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  inputSchema: {
    type: 'object', required: ['user_google_email'],
    properties: {
      user_google_email: { type: 'string' }, to: nullableString(), subject: nullableString(), body: nullableString(),
      body_format: { type: 'string', enum: ['plain', 'html'], default: 'plain' },
      forward_message_id: nullableString(), include_forwarded_attachments: { type: 'boolean', default: true },
      cc: nullableString(), bcc: nullableString(), from_name: nullableString(), from_email: nullableString(),
      thread_id: nullableString(), in_reply_to: nullableString(), references: nullableString(),
      attachments: { anyOf: [{ type: 'array', items: { type: 'object', additionalProperties: true } }, { type: 'null' }], default: null },
      include_signature: { type: 'boolean', default: true }, direction: { type: 'string', enum: ['auto', 'ltr', 'rtl'], default: 'auto' },
      quote_original: { type: 'boolean', default: false }, reply_all: { type: 'boolean', default: false },
    },
  },
};
export const WORKSPACE_GMAIL_TOOLS = [
  WORKSPACE_GMAIL_SEND,
  { name: 'draft_gmail_message', description: 'Create a draft without delivery.',
    inputSchema: WORKSPACE_GMAIL_SEND.inputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
  { name: 'search_gmail_messages', description: 'Search messages.',
    inputSchema: { type: 'object', required: ['user_google_email', 'query'], properties: { user_google_email: { type: 'string' }, query: { type: 'string' } } },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
];
