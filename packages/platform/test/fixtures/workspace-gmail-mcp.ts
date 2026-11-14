// Disposable uvx stand-in: the production preset argv/env reach a real MCP stdio transport.
// Log raw request arguments, so schema coercion or dropping unknown fields cannot hide a dispatch.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { WORKSPACE_GMAIL_TOOLS } from './workspace-gmail-definition.ts';
assert.deepEqual(process.argv.slice(2), ['workspace-mcp@2.3.0', '--single-user', '--permissions', 'gmail:readonly+drafts+send']);
assert.equal(process.env.WORKSPACE_MCP_DISABLE_LOCAL_FILES, 'true');
assert.equal(process.env.USER_GOOGLE_EMAIL, 'person@example.com');
assert.ok(process.env.GOOGLE_CLIENT_SECRET_PATH?.endsWith('/client_secret.json'));
const log = process.env.GMAIL_TEST_LOG!;
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result: unknown = {};
  if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'local-workspace-gmail', version: '1' } };
  if (request.method === 'tools/list') result = { tools: [...WORKSPACE_GMAIL_TOOLS, ...(process.env.GMAIL_TEST_EXTRA_TOOL ? [{ ...WORKSPACE_GMAIL_TOOLS[0], name: process.env.GMAIL_TEST_EXTRA_TOOL }] : [])] };
  if (request.method === 'tools/call') {
    const tool = request.params.name, args = request.params.arguments;
    const first = !existsSync(log) || !readFileSync(log, 'utf8').includes('"tool":"send_gmail_message"');
    appendFileSync(log, JSON.stringify({ tool, args }) + '\n');
    // Model the dangerous default as an independent delivery observation, not just an echo.
    const mail = tool === 'send_gmail_message' ? {
      from: args.user_google_email, to: args.to, ...(args.cc === undefined ? {} : { cc: args.cc }), ...(args.bcc === undefined ? {} : { bcc: args.bcc }),
      subject: args.subject, body: args.body + (args.include_signature === false ? '' : '\nUnreviewed server signature'),
      ...(args.attachments === undefined ? {} : { attachments: args.attachments.map((file: Record<string, string>) => ({
        filename: file.filename, mime_type: file.mime_type ?? 'application/octet-stream', bytes: [...Buffer.from(file.content, 'base64')],
      })) }),
    } : undefined;
    if (mail) appendFileSync(log + '.mail', JSON.stringify(mail) + '\n');
    if (tool === 'send_gmail_message' && first && process.env.GMAIL_TEST_HANG_FIRST) continue;
    result = { content: [{ type: 'text', text: tool === 'send_gmail_message' ? 'Sent by local stand-in only.' : 'Local tool completed.' }] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
}
