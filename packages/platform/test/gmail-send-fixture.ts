// Use the preset launch unchanged except for disposable PATH/log controls. The shim validates
// the pinned argv and env, then serves the upstream send schema without touching Google.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { workspaceMcpGmailSendPreset } from '@backbone-next/connector-mail';
import { connectorHost, type GmailCall } from './connector-pause-fixture.ts';

export const send = (body = 'Hello.', to = 'recipient@example.com'): GmailCall => ({ name: 'mcp__gmail-send__send_gmail_message',
  args: { user_google_email: 'person@example.com', to, subject: 'Hello', body, include_signature: false } });
export const draft = (): GmailCall => ({ name: 'mcp__gmail-send__draft_gmail_message', args: { ...send().args } });

export async function gmailHost(engine: 'harness-pi' | 'harness-codex', hang = false, extraTool?: string) {
  let deliveryLog = '';
  const fixture = await connectorHost(engine, hang, false, (person, log) => {
    deliveryLog = log + '.mail';
    const preset = workspaceMcpGmailSendPreset({ email: 'person@example.com', home: person });
    if (!('command' in preset.entry)) throw new Error('Gmail must use stdio.');
    assert.equal(preset.entry.command, 'uvx', 'the disposable shim must intercept every launch');
    const bin = join(person, 'bin'); mkdirSync(bin);
    const server = pathToFileURL(join(import.meta.dirname, 'fixtures/workspace-gmail-mcp.ts')).href;
    writeFileSync(join(bin, 'uvx'), `#!${process.execPath}\nimport(${JSON.stringify(server)});\n`, { mode: 0o700 });
    preset.entry.env = { ...preset.entry.env, PATH: bin + delimiter + (process.env.PATH ?? ''), GMAIL_TEST_LOG: log,
      ...(hang ? { GMAIL_TEST_HANG_FIRST: '1' } : {}), ...(extraTool ? { GMAIL_TEST_EXTRA_TOOL: extraTool } : {}) };
    return preset;
  });
  return Object.assign(fixture, { deliveries: () => existsSync(deliveryLog)
    ? readFileSync(deliveryLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>) : [] });
}
