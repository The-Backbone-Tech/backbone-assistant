import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { execFileSync } from 'node:child_process';
import { workspaceMcpGmailPreset, workspaceMcpGmailSendPreset } from '../src/index.ts';

test('sending is a separate opt-in preset on the same pinned connector; the default stays read and draft', () => {
  const home = mkdtempSync(join(tmpdir(), 'gmail-preset-'));
  after(() => rmSync(home, { recursive: true, force: true }));
  const options = { email: 'person@example.com', home };
  const draft = workspaceMcpGmailPreset(options);
  const send = workspaceMcpGmailSendPreset(options);
  assert.equal(draft.name, 'gmail');
  assert.equal(send.name, 'gmail-send');
  assert.ok('command' in draft.entry && 'command' in send.entry);
  assert.deepEqual(draft.entry.args, ['workspace-mcp@2.3.0', '--single-user', '--permissions', 'gmail:readonly+drafts', '--disabled-tools', 'send_gmail_message']);
  assert.deepEqual(send.entry.args, ['workspace-mcp@2.3.0', '--single-user', '--permissions', 'gmail:readonly+drafts+send']);
  assert.equal(send.entry.command, draft.entry.command);
  assert.deepEqual(send.entry.env, { ...draft.entry.env, WORKSPACE_MCP_DISABLE_LOCAL_FILES: 'true' });
  assert.equal(draft.entry.env?.WORKSPACE_MCP_DISABLE_LOCAL_FILES, undefined);
  assert.equal(send.token, draft.token);
  assert.deepEqual(send.overrides, draft.overrides);
  for (const name of ['draft_gmail_message', 'send_gmail_message', 'modify_gmail_message_labels', 'batch_modify_gmail_message_labels', 'manage_gmail_label', 'manage_gmail_filter']) {
    assert.equal(send.overrides[name], 'effect', name);
  }
});

// Exercise the account-free print path shown in the how-to, not a live connector launch.
test('the printed send preset disables local files without changing the printed default launch', () => {
  const home = mkdtempSync(join(tmpdir(), 'gmail-print-'));
  after(() => rmSync(home, { recursive: true, force: true }));
  const url = new URL('../src/gmail-preset.ts', import.meta.url).href;
  const script = `import { serversJson, workspaceMcpGmailPreset, workspaceMcpGmailSendPreset } from ${JSON.stringify(url)};
    const options = { email: 'person@example.com', home: ${JSON.stringify(home)} };
    console.log(JSON.stringify(serversJson(workspaceMcpGmailPreset(options), workspaceMcpGmailSendPreset(options))));`;
  const printed = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }));
  const env = { GOOGLE_CLIENT_SECRET_PATH: join(home, '.google_workspace_mcp', 'client_secret.json'), USER_GOOGLE_EMAIL: 'person@example.com' };
  assert.deepEqual(printed.mcpServers.gmail.env, env);
  assert.deepEqual(printed.mcpServers['gmail-send'].env, { ...env, WORKSPACE_MCP_DISABLE_LOCAL_FILES: 'true' });
  assert.deepEqual(printed.mcpServers.gmail.args, ['workspace-mcp@2.3.0', '--single-user', '--permissions', 'gmail:readonly+drafts', '--disabled-tools', 'send_gmail_message']);
});
