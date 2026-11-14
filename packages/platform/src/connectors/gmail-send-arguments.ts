import { basename } from 'node:path';
import type { ServerLaunch } from './client.ts';
// workspace-mcp v2.3.0 can resolve recipients, quoted mail, signatures and files at send time.
// A permission for displayed JSON cannot authorize that unseen content. Keep this tool to a
// new plain-text message with explicit recipients and inline bytes; never silently drop fields.
const SEND = 'send_gmail_message';
// Independently reviewed pin: changing the preset version must NOT silently widen this rule.
const LAUNCH_ARGS = ['workspace-mcp@2.3.0', '--single-user', '--permissions', 'gmail:readonly+drafts+send'];
const TOOLS = new Set(['send_gmail_message', 'draft_gmail_message', 'search_gmail_messages',
  'get_gmail_message_content', 'get_gmail_messages_content_batch', 'get_gmail_thread_content',
  'get_gmail_threads_content_batch', 'list_gmail_labels', 'list_gmail_filters', 'get_gmail_attachment_content']);

function policy(launch: ServerLaunch | undefined, tool: string, serverId?: string): 'other' | 'send' | 'known' | 'refuse' {
  const args = launch?.args ?? [], permission = args[args.indexOf('--permissions') + 1];
  const named = serverId?.endsWith(':gmail-send') === true;
  if (!named && !(args.some(a => /^workspace-mcp(?:@|$)/.test(a)) && permission?.includes('gmail:'))) return 'other';
  // The unchanged default read/draft preset does not activate this send contract.
  const draftArgs = ['workspace-mcp@2.3.0', '--single-user', '--permissions', 'gmail:readonly+drafts', '--disabled-tools', SEND];
  if (!named && launch?.transport === 'stdio' && basename(launch.command ?? '') === 'uvx'
    && JSON.stringify(args) === JSON.stringify(draftArgs) && TOOLS.has(tool) && tool !== SEND) return 'other';
  if (launch?.transport !== 'stdio' || basename(launch.command ?? '') !== 'uvx'
    || JSON.stringify(args) !== JSON.stringify(LAUNCH_ARGS) || launch.env?.WORKSPACE_MCP_DISABLE_LOCAL_FILES !== 'true'
    || !TOOLS.has(tool)) return 'refuse';
  return tool === SEND ? 'send' : 'known';
}

// Canonical field order plus the fixed control represent one message intent, including old records.
export function gmailIntentJson(args: Record<string, unknown>): string {
  const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered)
    : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
  return JSON.stringify(ordered({ ...args, include_signature: false }));
}
const FIELDS = new Set(['user_google_email', 'to', 'cc', 'bcc', 'subject', 'body', 'attachments', 'include_signature']);
const ATTACHMENT_FIELDS = new Set(['filename', 'content', 'mime_type']);
const REFUSAL = 'Gmail sends require explicit to, cc, bcc, subject, body and inline base64 attachments only. Forwarding, replies, signatures, remote or local attachment sources and unknown fields are refused. Nothing was sent.';
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const header = (v: unknown): v is string => typeof v === 'string' && !/[\r\n\0]/.test(v);
const mime = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;

function attachment(v: unknown): boolean {
  if (!object(v) || Object.keys(v).some(key => !ATTACHMENT_FIELDS.has(key))) return false;
  if (!header(v.filename) || !v.filename.trim() || typeof v.content !== 'string' || !v.content) return false;
  // Python's decoder accepts some malformed input. Accept one unambiguous encoding of bytes.
  if (Buffer.from(v.content, 'base64').toString('base64') !== v.content) return false;
  return v.mime_type === undefined || typeof v.mime_type === 'string' && mime.test(v.mime_type);
}

function explicitMessage(args: Record<string, unknown>): boolean {
  if (!object(args) || Object.keys(args).some(key => !FIELDS.has(key))) return false;
  // user_google_email is the upstream required routing identity, visible in the statement.
  if (!header(args.user_google_email) || !args.user_google_email.trim() || !header(args.to) || !args.to.trim()
    || !header(args.subject) || !args.subject.trim() || typeof args.body !== 'string') return false;
  if (['cc', 'bcc'].some(key => args[key] !== undefined && !header(args[key]))) return false;
  if ('include_signature' in args && args.include_signature !== false) return false;
  return !('attachments' in args) || Array.isArray(args.attachments) && args.attachments.every(attachment);
}

/** Normalize only before proposal, so the person and Core see the actual dispatch arguments. */
export function prepareGmailSend(tool: string, args: Record<string, unknown>, launch?: ServerLaunch, serverId?: string):
  { ok: true; args: Record<string, unknown>; intentArgs?: Record<string, unknown> } | { ok: false; detail: string } {
  const scope = policy(launch, tool, serverId);
  if (scope === 'refuse') return { ok: false, detail: 'This Gmail send connection or tool is not the reviewed version. Nothing was sent.' };
  if (scope !== 'send') return { ok: true, args };
  if (!explicitMessage(args)) return { ok: false, detail: REFUSAL };
  // Upstream defaults this to true. Fix it before hashing/display, never after permission.
  return { ok: true, args: JSON.parse(gmailIntentJson(args)), intentArgs: args };
}

/** Historical held calls need the same controls; never retrofit their immutable statement. */
export function gmailSendRefusal(tool: string, args: Record<string, unknown>, launch?: ServerLaunch, serverId?: string): string | undefined {
  const prepared = prepareGmailSend(tool, args, launch, serverId);
  return !prepared.ok ? prepared.detail : policy(launch, tool, serverId) === 'send' && args.include_signature !== false ? REFUSAL : undefined;
}
