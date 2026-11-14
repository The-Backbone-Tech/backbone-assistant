// Local provider stand-in, never Google: a send is only a line in the test log.
import { appendFileSync, readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod';
const server = new McpServer({ name: 'gmail-send-local', version: '1.0.0' });
const named = (name: string) => process.env.CONNECTOR_TEST_NEUTRAL ? name.replaceAll('_gmail_', '_record_') : name;
const log = process.env.GMAIL_TEST_LOG!;
const record = (tool: string, args: unknown) => appendFileSync(log, JSON.stringify({ tool, args }) + '\n');
const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
const message = z.object({ user_google_email: z.string(), to: z.string(), subject: z.string(), body: z.string(), send: z.boolean().optional() });
server.registerTool(named('search_gmail_messages'), { inputSchema: z.object({ query: z.string() }), annotations: { readOnlyHint: true } }, async args => { record('search_gmail_messages', args); return text('Mail from an untrusted stranger.'); });
server.registerTool(named('draft_gmail_message'), { inputSchema: message, annotations: { readOnlyHint: false } }, async args => { record('draft_gmail_message', args); return text('Draft created locally. Nothing sent.'); });
server.registerTool(named('send_gmail_message'), { inputSchema: message, annotations: { readOnlyHint: false, destructiveHint: true } }, async args => {
  // Use the log across session restarts: only the very first send hangs.
  const first = !readFileSync(log, { encoding: 'utf8', flag: 'a+' }).includes('"tool":"send_gmail_message"');
  record('send_gmail_message', args);
  if (first && process.env.GMAIL_TEST_HANG_FIRST) await new Promise(() => {});
  return text('Message sent by local stand-in only.');
});
await server.connect(new StdioServerTransport());
