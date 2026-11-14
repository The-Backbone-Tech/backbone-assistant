// A fake Gmail MCP server over the sample mailbox's fixture, for the platform's MCP client to be
// built and tested against before any real mailbox is connected. Its tools mirror, by name, argument
// and annotation, the Gmail tools of the community server recommended for a personal Gmail account:
// taylorwilsdon/google_workspace_mcp (`workspace-mcp` 2.3.0, `gmail/gmail_tools.py`, read 2 Nov
// 2026). Like that server it answers in plain text, errors included; Gmail API errors arrive as
// `isError` results whose text carries Google's `HttpError <status>`. Behaviours are labelled
// [V] verified at the source, [I] inference.
//
// - search_gmail_messages pages with page_size (default 10 [V]) and an opaque page_token; when more
//   remain the text ends with the server's `page_token='…'` hint [V]. Spam and trash are left out
//   unless the query names them (Gmail search [V]). Newest first [V].
// - draft_gmail_message records the draft in the fake's state and answers `Draft created! Draft ID:` [V].
// - send_gmail_message never sends. It records what was asked and answers with an error that says
//   so; the state's `sent` list stays empty. The real tool needs gmail.send, which the recommended
//   preset never grants.
// - Scripted faults, by tool and call number: a 429 rate limit ([V] Gmail's `rateLimitExceeded`)
//   and a call that never answers.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { MailAddress, MailLabel, MailMessage } from '@backbone-next/platform/ports/mail';
import { readSeed, type Seed } from './fake.ts';

export const FAKE_GMAIL_NAME = 'backbone-fake-gmail';
export const FAKE_GMAIL_VERSION = '0.1.0';

/** The tools, by the real server's names. */
export const GMAIL_TOOLS = {
  search: 'search_gmail_messages',
  message: 'get_gmail_message_content',
  thread: 'get_gmail_thread_content',
  labels: 'list_gmail_labels',
  draft: 'draft_gmail_message',
  send: 'send_gmail_message',
} as const;
export type GmailTool = (typeof GMAIL_TOOLS)[keyof typeof GMAIL_TOOLS];

export type GmailFaultKind = 'rate-limit' | 'hang';
/** A scripted fault: `kind` on `tool` (every tool when absent), on its nth call (1-based; every call when absent). */
export interface GmailFault {
  kind: GmailFaultKind;
  tool?: string;
  nth?: number;
}

/**
 * Parse `kind[@tool][#nth]`, comma-separated, e.g. `rate-limit@search_gmail_messages#2,hang@get_gmail_thread_content`.
 */
export function parseFaults(spec: string | undefined): GmailFault[] {
  if (!spec?.trim()) return [];
  return spec.split(',').map((part) => {
    const m = /^\s*(rate-limit|hang)(?:@([a-z_]+))?(?:#(\d+))?\s*$/.exec(part);
    if (!m) throw new Error(`Unknown fault "${part}": use rate-limit|hang, optionally @tool and #nth.`);
    return { kind: m[1] as GmailFaultKind, ...(m[2] ? { tool: m[2] } : {}), ...(m[3] ? { nth: Number(m[3]) } : {}) };
  });
}

export interface FakeGmailOptions {
  /** The mailbox: the bundled fixture by default. */
  seed?: Seed;
  /** A JSON file the fake's state (drafts, send requests, calls) is written to; in memory when absent. */
  stateFile?: string;
  faults?: GmailFault[];
}

/** What the fake recorded. `sent` exists so a test can see it stays empty. */
export interface FakeGmailState {
  account: string;
  drafts: { id: string; threadId: string | null; to: string | null; cc: string | null; bcc: string | null; subject: string | null; body: string | null }[];
  sendRequests: { id: string; to: string | null; cc: string | null; bcc: string | null; subject: string | null; body: string | null; threadId: string | null }[];
  sent: unknown[];
  calls: { tool: string; n: number; fault: GmailFaultKind | null }[];
}

export function readFakeGmailState(file: string): FakeGmailState {
  return JSON.parse(readFileSync(file, 'utf8')) as FakeGmailState;
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const DRAFT = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const SEND = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

const EMAIL = z.string().describe("The user's Google email address. Required.");
const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], ...(isError ? { isError: true } : {}) });
const addr = (a: MailAddress) => (a.name ? `${a.name} <${a.address}>` : a.address);
const token = (query: string, offset: number) => Buffer.from(JSON.stringify({ q: createHash('sha256').update(query).digest('hex').slice(0, 12), o: offset })).toString('base64url');

/** A small subset of Gmail's search syntax: words, "from:", "to:", "subject:", "label:", "in:", "is:unread", "has:attachment". */
function matcher(query: string, labels: MailLabel[]) {
  const terms = query.match(/(?:[^\s"]+:)?"[^"]*"|\S+/g) ?? [];
  const named = (name: string) => labels.find((l) => l.id.toLowerCase() === name || l.name.toLowerCase() === name)?.id ?? name.toUpperCase();
  let scoped = false;
  const tests = terms.map((raw) => {
    const negate = raw.startsWith('-');
    const term = (negate ? raw.slice(1) : raw).replace(/"/g, '').toLowerCase();
    const [key, value] = term.includes(':') ? [term.slice(0, term.indexOf(':')), term.slice(term.indexOf(':') + 1)] : ['', term];
    let t: (m: MailMessage) => boolean;
    if (key === 'from') t = (m) => addr(m.from).toLowerCase().includes(value);
    else if (key === 'to') t = (m) => [...m.to, ...m.cc].some((a) => addr(a).toLowerCase().includes(value));
    else if (key === 'subject') t = (m) => m.subject.toLowerCase().includes(value);
    else if (key === 'label' || key === 'in') {
      const id = value === 'drafts' ? 'DRAFT' : named(value);
      if (id === 'SPAM' || id === 'TRASH' || value === 'anywhere') scoped = true;
      t = value === 'anywhere' ? () => true : (m) => m.labels.includes(id);
    } else if (key === 'is' && value === 'unread') t = (m) => m.labels.includes('UNREAD');
    else if (key === 'has' && value === 'attachment') t = (m) => m.attachments.length > 0;
    else t = (m) => `${addr(m.from)} ${m.subject} ${m.body}`.toLowerCase().includes(value);
    return negate ? (m: MailMessage) => !t(m) : t;
  });
  return (m: MailMessage) => (scoped || !m.labels.some((l) => l === 'SPAM' || l === 'TRASH')) && tests.every((t) => t(m));
}

/** A factory for the fake: one McpServer per connection, all sharing one mailbox and one state. */
export function createFakeGmail(options: FakeGmailOptions = {}) {
  const seed = options.seed ?? readSeed();
  const messages: MailMessage[] = seed.messages.map((m) => ({ ...structuredClone(m), version: '1' }));
  const byNewest = [...messages].sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  const faults = options.faults ?? [];
  const counts = new Map<string, number>();
  const state: FakeGmailState = options.stateFile && existsSync(options.stateFile)
    ? readFakeGmailState(options.stateFile)
    : { account: seed.account, drafts: [], sendRequests: [], sent: [], calls: [] };
  const save = () => {
    if (!options.stateFile) return;
    mkdirSync(dirname(options.stateFile), { recursive: true });
    const tmp = `${options.stateFile}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(tmp, options.stateFile);
  };
  save();

  /** Runs one call: counts it, plays its scripted fault, checks the account. */
  const handle = (tool: string, email: string, run: () => ReturnType<typeof text>) => {
    const n = (counts.get(tool) ?? 0) + 1;
    counts.set(tool, n);
    const fault = faults.find((f) => (f.tool ?? tool) === tool && (f.nth ?? n) === n)?.kind ?? null;
    state.calls.push({ tool, n, fault });
    save();
    if (fault === 'hang') return new Promise<never>(() => {});
    if (fault === 'rate-limit') {
      return Promise.resolve(text(
        `API error in ${tool}: <HttpError 429 when requesting https://gmail.googleapis.com/gmail/v1/users/me returned "User-rate limit exceeded.  Retry after 2026-10-26T08:41:00.000Z". Details: "[{'message': 'User-rate limit exceeded.  Retry after 2026-10-26T08:41:00.000Z', 'domain': 'usageLimits', 'reason': 'rateLimitExceeded'}]">`,
        true,
      ));
    }
    if (email.toLowerCase() !== seed.account.toLowerCase()) {
      return Promise.resolve(text(`API error in ${tool}: no credentials for '${email}'. This fake serves only ${seed.account}; nothing was read.`, true));
    }
    return Promise.resolve(run());
  };

  const formatMessage = (m: MailMessage) => [
    `Message ID: ${m.id}`,
    `Subject: ${m.subject}`,
    `From: ${addr(m.from)}`,
    `Date: ${m.date}`,
    ...(m.replyTo ? [`Reply-To: ${addr(m.replyTo)}`] : []),
    `To: ${m.to.map(addr).join(', ')}`,
    `Cc: ${m.cc.map(addr).join(', ')}`,
    `Labels: ${m.labels.join(', ')}`,
    '',
    '--- BODY ---',
    m.body,
    ...(m.attachments.length ? ['', '--- ATTACHMENTS ---', ...m.attachments.map((a, i) => `${i + 1}. ${JSON.stringify(a)}`)] : []),
  ].join('\n');

  return function createServer(): McpServer {
    const server = new McpServer({ name: FAKE_GMAIL_NAME, version: FAKE_GMAIL_VERSION });

    server.registerTool(GMAIL_TOOLS.search, {
      title: 'Search Gmail Messages',
      description: "Searches messages in a user's Gmail account based on a query. Returns both Message IDs and Thread IDs for each found message. Supports pagination via page_token parameter.",
      inputSchema: z.object({
        query: z.string().describe('The search query. Supports standard Gmail search operators.'),
        user_google_email: EMAIL,
        page_size: z.number().int().min(1).max(500).optional().describe('The maximum number of messages to return. Defaults to 10.'),
        page_token: z.string().optional().describe('Token for retrieving the next page of results. Use the next_page_token from a previous response.'),
        include_headers: z.boolean().optional().describe('If True, also include Subject, From, Date and label IDs per result.'),
      }),
      annotations: READ,
    }, ({ query, user_google_email, page_size, page_token, include_headers }) => handle(GMAIL_TOOLS.search, user_google_email, () => {
      const found = byNewest.filter(matcher(query, seed.labels));
      let offset = 0;
      if (page_token) {
        let decoded: { q?: string; o?: number } = {};
        try { decoded = JSON.parse(Buffer.from(page_token, 'base64url').toString('utf8')); } catch { /* invalid below */ }
        if (typeof decoded.o !== 'number' || decoded.q !== JSON.parse(Buffer.from(token(query, 0), 'base64url').toString('utf8')).q) {
          return text(`API error in ${GMAIL_TOOLS.search}: <HttpError 400 when requesting https://gmail.googleapis.com/gmail/v1/users/me/messages returned "Invalid pageToken">`, true);
        }
        offset = decoded.o;
      }
      const size = page_size ?? 10;
      const page = found.slice(offset, offset + size);
      if (!page.length) return text(`No messages found for query: '${query}'`);
      const next = offset + size < found.length ? token(query, offset + size) : null;
      const lines = [`Found ${page.length} messages matching '${query}':`, '', '📧 MESSAGES:'];
      page.forEach((m, i) => {
        lines.push(`  ${i + 1}. Message ID: ${m.id}`);
        if (include_headers) lines.push(`     Subject: ${m.subject}`, `     From: ${addr(m.from)}`, `     Date: ${m.date}`, `     Labels: ${m.labels.join(', ')}`);
        lines.push(`     Web Link: https://mail.google.com/mail/u/0/#all/${m.id}`, `     Thread ID: ${m.threadId}`, `     Thread Link: https://mail.google.com/mail/u/0/#all/${m.threadId}`, '');
      });
      if (next) lines.push('', `📄 PAGINATION: To get the next page, call ${GMAIL_TOOLS.search} again with page_token='${next}'`);
      return text(lines.join('\n'));
    }));

    server.registerTool(GMAIL_TOOLS.message, {
      title: 'Get Gmail Message Content',
      description: 'Retrieves the full content (subject, sender, recipients, plain text body) of a specific Gmail message.',
      inputSchema: z.object({
        message_id: z.string().describe('The unique ID of the Gmail message to retrieve.'),
        user_google_email: EMAIL,
        body_format: z.enum(['text', 'html', 'raw']).optional().describe("Body output format. 'text' (default) returns plaintext."),
      }),
      annotations: READ,
    }, ({ message_id, user_google_email }) => handle(GMAIL_TOOLS.message, user_google_email, () => {
      const m = messages.find((x) => x.id === message_id);
      if (!m) return text(`API error in ${GMAIL_TOOLS.message}: <HttpError 404 when requesting https://gmail.googleapis.com/gmail/v1/users/me/messages/${message_id} returned "Requested entity was not found.">`, true);
      return text(formatMessage(m));
    }));

    server.registerTool(GMAIL_TOOLS.thread, {
      title: 'Get Gmail Thread Content',
      description: 'Retrieves the complete content of a Gmail conversation thread, including all messages.',
      inputSchema: z.object({
        thread_id: z.string().describe('The unique ID of the Gmail thread to retrieve.'),
        user_google_email: EMAIL,
        body_format: z.enum(['text', 'html', 'raw']).optional().describe("Body output format. 'text' (default) returns plaintext."),
      }),
      annotations: READ,
    }, ({ thread_id, user_google_email }) => handle(GMAIL_TOOLS.thread, user_google_email, () => {
      const thread = messages.filter((m) => m.threadId === thread_id).sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
      if (!thread.length) return text(`API error in ${GMAIL_TOOLS.thread}: <HttpError 404 when requesting https://gmail.googleapis.com/gmail/v1/users/me/threads/${thread_id} returned "Requested entity was not found.">`, true);
      const lines = [`Thread ID: ${thread_id}`, `Subject: ${thread[0]!.subject}`, `Messages: ${thread.length}`, ''];
      thread.forEach((m, i) => {
        lines.push(`=== Message ${i + 1} ===`, `From: ${addr(m.from)}`, `Date: ${m.date}`, ...(m.replyTo ? [`Reply-To: ${addr(m.replyTo)}`] : []), `To: ${m.to.map(addr).join(', ')}`, `Cc: ${m.cc.map(addr).join(', ')}`);
        if (m.subject !== thread[0]!.subject) lines.push(`Subject: ${m.subject}`);
        lines.push('', m.body, '');
      });
      return text(lines.join('\n'));
    }));

    server.registerTool(GMAIL_TOOLS.labels, {
      title: 'List Gmail Labels',
      description: "Lists labels in the user's Gmail account.",
      inputSchema: z.object({
        user_google_email: EMAIL,
        prefix: z.string().optional().describe('Return only labels whose name starts with this exact (case-sensitive) string.'),
        compact: z.boolean().optional(),
        include_system: z.boolean().optional().describe('Include system labels (default true).'),
      }),
      annotations: READ,
    }, ({ user_google_email, prefix, include_system }) => handle(GMAIL_TOOLS.labels, user_google_email, () => {
      const labels = seed.labels.filter((l) => (!prefix || l.name.startsWith(prefix)) && (include_system !== false || !l.system));
      const lines = [`Found ${labels.length} labels:`, ''];
      const system = labels.filter((l) => l.system);
      const user = labels.filter((l) => !l.system);
      if (system.length) lines.push('📂 SYSTEM LABELS:', ...system.map((l) => `  • ${l.name} (ID: ${l.id})`), '');
      if (user.length) lines.push('🏷️  USER LABELS:', ...user.map((l) => `  • ${l.name} (ID: ${l.id})`));
      return text(lines.join('\n'));
    }));

    const compose = {
      user_google_email: EMAIL,
      to: z.string().optional().describe('Recipient email address.'),
      cc: z.string().optional().describe('CC email address.'),
      bcc: z.string().optional().describe('BCC email address.'),
      subject: z.string().optional().describe('Email subject.'),
      body: z.string().optional().describe('Email body.'),
      body_format: z.enum(['plain', 'html']).optional(),
      thread_id: z.string().optional().describe('Gmail thread ID to reply within.'),
    };

    server.registerTool(GMAIL_TOOLS.draft, {
      title: 'Draft Gmail Message',
      description: 'Creates a draft email in the user\'s Gmail account. Nothing is sent.',
      inputSchema: z.object(compose),
      annotations: DRAFT,
    }, (a) => handle(GMAIL_TOOLS.draft, a.user_google_email, () => {
      const id = `r-fake-draft-${state.drafts.length + 1}`;
      state.drafts.push({ id, threadId: a.thread_id ?? null, to: a.to ?? null, cc: a.cc ?? null, bcc: a.bcc ?? null, subject: a.subject ?? null, body: a.body ?? null });
      save();
      return text(`Draft created! Draft ID: ${id}`);
    }));

    server.registerTool(GMAIL_TOOLS.send, {
      title: 'Send Gmail Message',
      description: 'Sends an email using the user\'s Gmail account. (This fake never sends: it records the request.)',
      inputSchema: z.object(compose),
      annotations: SEND,
    }, (a) => handle(GMAIL_TOOLS.send, a.user_google_email, () => {
      const id = `fake-send-request-${state.sendRequests.length + 1}`;
      state.sendRequests.push({ id, to: a.to ?? null, cc: a.cc ?? null, bcc: a.bcc ?? null, subject: a.subject ?? null, body: a.body ?? null, threadId: a.thread_id ?? null });
      save();
      return text(`Not sent: this is the fake Gmail server, which never sends. The request was recorded as ${id}; no message left the mailbox.`, true);
    }));

    return server;
  };
}
