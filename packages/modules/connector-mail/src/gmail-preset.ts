// Gmail connector presets: server entries for <home>/connectors/servers.json (Claude's
// `mcpServers` shape) and suggested tool classifications. The Host does not automatically apply
// these tables. Sending names have an effect floor in the Host whatever the server says;
// other tools use the server's annotations with the person's override on top, and otherwise
// an unannotated tool is an effect. No preset carries a secret value: env
// holds names and paths, and the OAuth token stays in the connector program's own folder.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GMAIL_TOOLS } from './gmail-mcp.ts';

export type McpServerEntry = { command: string; args: string[]; env?: Record<string, string> } | { url: string };
export type ToolOverride = 'read' | 'effect';

export interface GmailPreset {
  /** The key under `mcpServers`. */
  name: string;
  entry: McpServerEntry;
  overrides: Record<string, ToolOverride>;
  /** Where the OAuth token lives, for the person; null when there is none. */
  token: string | null;
}

/** The fake's bin, runnable with `node <path>`. */
export const FAKE_GMAIL_BIN = fileURLToPath(new URL('./gmail-mcp-main.ts', import.meta.url));

/** The fake: no key, no account, no network. `state` and `faults` become its env (see src/gmail-mcp-main.ts). */
export function fakeGmailPreset(options: { node?: string; state?: string; faults?: string } = {}): GmailPreset {
  const env: Record<string, string> = {};
  if (options.state) env.BACKBONE_FAKE_GMAIL_STATE = options.state;
  if (options.faults) env.BACKBONE_FAKE_GMAIL_FAULTS = options.faults;
  return {
    name: 'gmail-fake',
    entry: { command: options.node ?? process.execPath, args: [FAKE_GMAIL_BIN], ...(Object.keys(env).length ? { env } : {}) },
    overrides: {
      [GMAIL_TOOLS.search]: 'read',
      [GMAIL_TOOLS.message]: 'read',
      [GMAIL_TOOLS.thread]: 'read',
      [GMAIL_TOOLS.labels]: 'read',
      [GMAIL_TOOLS.draft]: 'effect',
      [GMAIL_TOOLS.send]: 'effect',
    },
    token: null,
  };
}

/** The version of workspace-mcp the fake mirrors and the preset pins (taylorwilsdon/google_workspace_mcp, 2.3.0, docs synced 30 Oct 2026). */
export const WORKSPACE_MCP_VERSION = '2.3.0';

/**
 * A personal Gmail account, read and draft only, through workspace-mcp over stdio. Scopes:
 * gmail.readonly and gmail.compose (`--permissions gmail:readonly+drafts`: no organize, so no
 * gmail.modify; no send level, so no gmail.send); `send_gmail_message` is also switched off by name.
 * gmail.compose still lets a token send through the Gmail API, which is why drafting is an effect.
 */
export function workspaceMcpGmailPreset(options: { email: string; clientSecretPath?: string; home?: string }): GmailPreset {
  const home = options.home ?? homedir();
  return {
    name: 'gmail',
    entry: {
      command: 'uvx',
      args: [`workspace-mcp@${WORKSPACE_MCP_VERSION}`, '--single-user', '--permissions', 'gmail:readonly+drafts', '--disabled-tools', 'send_gmail_message'],
      env: {
        GOOGLE_CLIENT_SECRET_PATH: options.clientSecretPath ?? join(home, '.google_workspace_mcp', 'client_secret.json'),
        USER_GOOGLE_EMAIL: options.email,
      },
    },
    overrides: {
      search_gmail_messages: 'read',
      get_gmail_message_content: 'read',
      get_gmail_messages_content_batch: 'read',
      get_gmail_thread_content: 'read',
      get_gmail_threads_content_batch: 'read',
      list_gmail_labels: 'read',
      list_gmail_filters: 'read',
      // Writes a file under $HOME/.workspace-mcp/attachments: annotated not read-only upstream.
      get_gmail_attachment_content: 'effect',
      draft_gmail_message: 'effect',
      send_gmail_message: 'effect',
      modify_gmail_message_labels: 'effect',
      batch_modify_gmail_message_labels: 'effect',
      manage_gmail_label: 'effect',
      manage_gmail_filter: 'effect',
      start_google_auth: 'effect',
    },
    token: join(home, '.google_workspace_mcp', 'credentials'),
  };
}

/**
 * Opt-in read, draft and send on the same pinned connector. The person must re-consent
 * to gmail.send, then release individual calls or sign send_gmail_message in the Host.
 * The Host limits this send tool to explicit new-message content and inline base64 bytes,
 * fixes the signature default before display, and refuses indirect or unknown arguments.
 * Keep the read-and-draft preset above unchanged and the default.
 *
 * Alberto's source audit of tag v2.3.0, 10 November 2026, confirms this permission string.
 * Label/filter modifications need organize or full, absent here. Keep the existing effect
 * table as classification guidance; the Host does not automatically consume it.
 */
export function workspaceMcpGmailSendPreset(options: Parameters<typeof workspaceMcpGmailPreset>[0]): GmailPreset {
  const draft = workspaceMcpGmailPreset(options);
  if (!('command' in draft.entry)) throw new Error('The Gmail preset must use stdio.');
  return {
    ...draft,
    name: 'gmail-send',
    entry: {
      ...draft.entry,
      args: [`workspace-mcp@${WORKSPACE_MCP_VERSION}`, '--single-user', '--permissions', 'gmail:readonly+drafts+send'],
      env: {
        ...draft.entry.env,
        // Maintained upstream setting: a signed send must not attach files from this computer.
        WORKSPACE_MCP_DISABLE_LOCAL_FILES: 'true',
      },
    },
  };
}

/**
 * Google's own remote Gmail MCP server (gmailmcp.googleapis.com, Developer Preview in November 2026,
 * which asks for a Google Workspace account): the swap target once it is generally available.
 * Scopes gmail.readonly and gmail.compose; it has no send tool.
 */
export const GOOGLE_GMAIL_MCP_PRESET: GmailPreset = {
  name: 'gmail-google',
  entry: { url: 'https://gmailmcp.googleapis.com/mcp/v1' },
  overrides: {
    search_threads: 'read',
    get_thread: 'read',
    get_message: 'read',
    list_labels: 'read',
    list_drafts: 'read',
    create_draft: 'effect',
    label_message: 'effect',
    label_thread: 'effect',
    unlabel_message: 'effect',
    unlabel_thread: 'effect',
  },
  token: null,
};

/** The servers.json body for some presets: `{ mcpServers: { [name]: entry } }`. */
export function serversJson(...presets: GmailPreset[]): { mcpServers: Record<string, McpServerEntry> } {
  return { mcpServers: Object.fromEntries(presets.map((p) => [p.name, p.entry])) };
}
