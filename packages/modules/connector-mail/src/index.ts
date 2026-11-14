// connector-mail: the mail connector port's adapters. Today one, the sample mailbox (a fake
// provider seeded with a realistic inbox), which the app connects and the tests drive; the real
// adapters (Gmail API, Microsoft Graph, or the vendors' MCP servers once generally available) are a
// design note in the README until an account and an OAuth client exist. Every request is
// classified here, from the request itself; writes stay gated.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MailConnector, TriageTask } from '@backbone-next/platform/ports/mail';
import { FakeMailbox, FIXTURE_DIR } from './fake.ts';

export { classifyMailRequest } from './classify.ts';
export { FakeMailbox, FIXTURE_DIR, ProviderTimeout, ProviderUnknown, readSeed, SCOPES, type Fault, type FakeMailboxOptions, type Seed } from './fake.ts';
export { createFakeGmail, GMAIL_TOOLS, parseFaults, readFakeGmailState, type FakeGmailOptions, type FakeGmailState, type GmailFault } from './gmail-mcp.ts';
export { FAKE_GMAIL_BIN, fakeGmailPreset, GOOGLE_GMAIL_MCP_PRESET, serversJson, workspaceMcpGmailPreset, workspaceMcpGmailSendPreset, type GmailPreset, type McpServerEntry, type ToolOverride } from './gmail-preset.ts';

/** The sample mailbox's triage instructions; its categories match its labels. */
export function readTask(dir = FIXTURE_DIR): TriageTask {
  return JSON.parse(readFileSync(join(dir, 'task.json'), 'utf8')) as TriageTask;
}

/**
 * The composition's factory (called after the platform checked this module's digest). `sample` is
 * the only provider built: its state lives in the data home, and its writes are gated.
 */
export function createMailConnector(options: { home: string; provider?: string }): MailConnector {
  const provider = options.provider ?? 'sample';
  if (provider !== 'sample') {
    throw new Error(`No ${provider} adapter is built yet: a real mailbox needs an OAuth client and an account the owner creates (README, "The real adapters").`);
  }
  return new FakeMailbox({ stateFile: join(options.home, 'mailbox', 'sample.json') });
}
