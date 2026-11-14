// The fake Gmail MCP server, driven by the official MCP client over stdio exactly as the platform's
// client will launch it: from the preset's servers.json entry. Its tools carry the real server's names
// and annotations; search pages; a thread reads whole; a scripted 429 and a call that never answers
// come back as such; a draft is recorded and a send is recorded but never sent.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fakeGmailPreset, readFakeGmailState, readSeed, serversJson, workspaceMcpGmailPreset } from '../src/index.ts';

const dirs: string[] = [];
const clients: Client[] = [];
after(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
});
const seed = readSeed();
const me = seed.account;

type Result = { isError?: boolean; content: { type: string; text?: string }[] };
const textOf = (r: Result) => r.content.map((c) => c.text ?? '').join('\n');

async function start(faults?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'backbone-fake-gmail-'));
  dirs.push(dir);
  const state = join(dir, 'state.json');
  const preset = fakeGmailPreset({ state, faults });
  const entry = serversJson(preset).mcpServers[preset.name];
  assert.ok(entry && 'command' in entry);
  const transport = new StdioClientTransport({ command: entry.command, args: entry.args, env: { PATH: process.env.PATH ?? '', ...entry.env }, stderr: 'pipe' });
  const client = new Client({ name: 'fake-gmail-test', version: '0.0.0' });
  await client.connect(transport);
  clients.push(client);
  const call = async (name: string, args: Record<string, unknown>, timeout?: number) =>
    (await client.callTool({ name, arguments: { user_google_email: me, ...args } }, timeout ? { timeout } : undefined)) as Result;
  return { client, call, state: () => readFakeGmailState(state), preset };
}

test('lists the real tool names, with read, draft and send annotated as the real server does', async () => {
  const { client, preset } = await start();
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations ?? {}]));
  assert.deepEqual(Object.keys(byName).sort(), ['draft_gmail_message', 'get_gmail_message_content', 'get_gmail_thread_content', 'list_gmail_labels', 'search_gmail_messages', 'send_gmail_message']);
  for (const name of ['search_gmail_messages', 'get_gmail_message_content', 'get_gmail_thread_content', 'list_gmail_labels']) {
    assert.equal(byName[name]!.readOnlyHint, true, name);
    assert.notEqual(byName[name]!.destructiveHint, true, name);
  }
  assert.equal(byName.draft_gmail_message!.readOnlyHint, false);
  assert.equal(byName.draft_gmail_message!.destructiveHint, false);
  assert.equal(byName.send_gmail_message!.readOnlyHint, false);
  assert.equal(byName.send_gmail_message!.destructiveHint, true);
  // The preset keeps drafting and sending effects whatever a server says, and every tool is classified.
  assert.equal(preset.overrides.send_gmail_message, 'effect');
  assert.equal(preset.overrides.draft_gmail_message, 'effect');
  assert.deepEqual(Object.keys(preset.overrides).sort(), Object.keys(byName).sort());
});

test('search pages with a next page token until the last page, and the pages cover the mailbox once', async () => {
  const { call } = await start();
  const seen: string[] = [];
  let token: string | undefined;
  let pages = 0;
  do {
    const r = await call('search_gmail_messages', { query: '', page_size: 10, ...(token ? { page_token: token } : {}) });
    assert.notEqual(r.isError, true, textOf(r));
    const text = textOf(r);
    seen.push(...[...text.matchAll(/Message ID: (\S+)/g)].map((m) => m[1]!));
    token = /page_token='([^']+)'/.exec(text)?.[1];
    pages++;
  } while (token && pages < 20);
  const visible = seed.messages.filter((m) => !m.labels.includes('SPAM') && !m.labels.includes('TRASH'));
  assert.equal(pages, Math.ceil(visible.length / 10));
  assert.equal(new Set(seen).size, visible.length);
  assert.equal(seen.length, visible.length);
  // A token from another query is refused, as Gmail refuses it.
  const first = textOf(await call('search_gmail_messages', { query: '', page_size: 10 }));
  const other = /page_token='([^']+)'/.exec(first)![1];
  const refused = await call('search_gmail_messages', { query: 'is:unread', page_token: other });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /HttpError 400/);
});

test('search narrows with Gmail operators; reads a thread whole, a message, and the labels', async () => {
  const { call } = await start();
  const billing = textOf(await call('search_gmail_messages', { query: 'subject:INV-2291', include_headers: true }));
  assert.match(billing, /Message ID: m01/);
  assert.match(billing, /Subject: Charged twice for INV-2291/);
  const threadId = 't-m11';
  const thread = textOf(await call('get_gmail_thread_content', { thread_id: threadId }));
  assert.match(thread, new RegExp(`Thread ID: ${threadId}`));
  assert.match(thread, /Messages: 3/);
  assert.equal([...thread.matchAll(/=== Message \d+ ===/g)].length, 3);
  const message = textOf(await call('get_gmail_message_content', { message_id: 'm01' }));
  assert.match(message, /From: Dana Whitfield <dana.whitfield@harborlight.example>/);
  assert.match(message, /two debits of EUR 1,840.00/);
  const labels = textOf(await call('list_gmail_labels', {}));
  assert.match(labels, /Billing \(ID: Label_billing\)/);
  assert.match(labels, /Inbox \(ID: INBOX\)/);
  const missing = await call('get_gmail_thread_content', { thread_id: 'no-such-thread' });
  assert.equal(missing.isError, true);
  assert.match(textOf(missing), /HttpError 404/);
});

test('a scripted 429 comes back as Gmail rate limit, on the call it names only', async () => {
  const { call, state } = await start('rate-limit@search_gmail_messages#2');
  assert.notEqual((await call('search_gmail_messages', { query: '' })).isError, true);
  const limited = await call('search_gmail_messages', { query: '' });
  assert.equal(limited.isError, true);
  assert.match(textOf(limited), /HttpError 429/);
  assert.match(textOf(limited), /rateLimitExceeded/);
  assert.notEqual((await call('search_gmail_messages', { query: '' })).isError, true);
  assert.deepEqual(state().calls.map((c) => c.fault), [null, 'rate-limit', null]);
});

test('a scripted hang never answers: the client times out, and the server still serves the next call', async () => {
  const { call } = await start('hang@get_gmail_thread_content#1');
  await assert.rejects(call('get_gmail_thread_content', { thread_id: 't-m11' }, 300), (e: Error) => /timed? ?out/i.test(e.message));
  const again = await call('get_gmail_thread_content', { thread_id: 't-m11' });
  assert.notEqual(again.isError, true);
});

test('a draft is recorded; a send is recorded as asked and never sent', async () => {
  const { call, state } = await start();
  const draft = await call('draft_gmail_message', { to: 'dana.whitfield@harborlight.example', subject: 'Re: Charged twice for INV-2291', body: 'Looking into it.', thread_id: 't-m01' });
  assert.notEqual(draft.isError, true);
  assert.match(textOf(draft), /^Draft created! Draft ID: \S+/);
  const send = await call('send_gmail_message', { to: 'dana.whitfield@harborlight.example', subject: 'Refund', body: 'Refunded.' });
  assert.equal(send.isError, true);
  assert.match(textOf(send), /never sends/);
  const s = state();
  assert.equal(s.drafts.length, 1);
  assert.equal(s.drafts[0]!.subject, 'Re: Charged twice for INV-2291');
  assert.equal(s.sendRequests.length, 1);
  assert.equal(s.sendRequests[0]!.to, 'dana.whitfield@harborlight.example');
  assert.deepEqual(s.sent, []);
});

test('another account is refused, and the real preset grants no send scope and holds no secret', async () => {
  const { client } = await start();
  const r = (await client.callTool({ name: 'search_gmail_messages', arguments: { user_google_email: 'someone@else.example', query: '' } })) as Result;
  assert.equal(r.isError, true);
  const real = workspaceMcpGmailPreset({ email: 'person@example.com', home: join(tmpdir(), 'person') });
  assert.ok('command' in real.entry);
  const args = real.entry.args.join(' ');
  assert.match(args, /--permissions gmail:readonly\+drafts/);
  assert.doesNotMatch(args, /gmail:(send|full|organize)/);
  assert.match(args, /--disabled-tools send_gmail_message/);
  assert.deepEqual(Object.keys(real.entry.env ?? {}).sort(), ['GOOGLE_CLIENT_SECRET_PATH', 'USER_GOOGLE_EMAIL']);
  assert.equal(real.overrides.send_gmail_message, 'effect');
  assert.equal(real.overrides.draft_gmail_message, 'effect');
});
