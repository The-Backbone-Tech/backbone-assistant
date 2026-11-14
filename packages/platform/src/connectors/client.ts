// One session with one of the person's MCP servers, over stdio or streamable HTTP.
// It lists tools across every page and calls one with a deadline. A call's answer says how complete
// it is: only `complete` may be read as "nothing there"; more pages, a rate limit, a timeout or a
// failure are told as what they are, never as an absence.
import { createHash } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { secretValues } from './discover.ts';
import { delimiter } from 'node:path';
import { defaultToolEnv } from '../tools/places.ts';
import type { CatalogueEnvelope } from './catalogue-store.ts';
import { binaryDigest } from './catalogue-install.ts';

/**
 * An app started from the Finder has a short PATH: a server's command (uvx, npx, node) is looked for
 * in the folders tools are usually installed in too, after the PATH it has. A PATH in the server's
 * own config still wins.
 */
export const withToolFolders = (path: string | undefined) => [...new Set([...(path ?? '').split(delimiter).filter(Boolean), ...defaultToolEnv().bins])].join(delimiter);

export interface ServerLaunch {
  /** Native-only pin resolved from the sealed bundle; not accepted by config discovery. */
  executableDigest?: string;
  /** An opaque credential handle and account generation, never the credential's value. */
  catalogue?: CatalogueEnvelope;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  /** Read from the person's config when the server starts; never stored by the host. */
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

export interface ListedTool {
  /** Digest of the full advertised definition before redaction; raw server text is never retained. */
  definitionDigest?: string;
  definitionDigestVersion?: 1;
  /** Compatibility witness for full pins written before canonical key sorting. */
  previousDefinitionDigest?: string;
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

export type CallStatus = 'complete' | 'partial' | 'rate-limited' | 'timed-out' | 'failed';
export interface CallAnswer {
  /** This SDK call resolved with a tool result before our deadline, including isError results.
   * Rejected exceptions do not prove a remote response, regardless of class/code/message.
   * This is neither completeness, wire-byte provenance, proof that an effect did not run,
   * nor proof of model receipt. An observed isError is still an uncertain effect outcome. */
  observed: boolean;
  /** A tool error reports a deadline after possible delivery, even if the SDK reply arrived on time. */
  reportedTimeout?: true;
  status: CallStatus;
  /** Existing rendered/redacted answer text; unobserved failures also return an empty string. */
  text: string;
  /** Why it is not complete, in plain words. */
  detail?: string;
}

/** Calls and listings wait this long by default. */
export const CALL_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 20_000;
const MAX_PAGES = 50;
const MAX_TEXT = 200_000;

export const NOT_AN_ABSENCE: Record<Exclude<CallStatus, 'complete'>, string> = {
  partial: 'Only the first page came back; more results exist that were not read. This is not everything.',
  'rate-limited': 'The server is limiting requests (429). Nothing more was read; this says nothing about what exists.',
  'timed-out': 'The server did not answer in time. Nothing can be said about what exists.',
  failed: 'The call failed. Nothing can be said about what exists.',
};

const within = <T>(work: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([work, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new TimedOut(`${what} took longer than ${Math.round(ms / 1000)} s.`)), ms); })])
    .finally(() => clearTimeout(timer));
};
export class TimedOut extends Error {}

/** A variable or header whose name says it holds a credential: its value is hidden however short. */
const SECRET_NAME = /token|key|secret|pass|auth|cred|cookie|session|bearer|pin/i;
/** Below this, a value of an ordinary name is not hidden: hiding `1`, `on` or `plain` would garble every answer, and such a value is no secret. */
const SHORTEST_HIDDEN = 6;

/**
 * Hides every value the server's own config gave it (its variables and headers) from any text that
 * leaves the session: an error, a line it printed, an answer, its tools as listed. A server that
 * echoes its token must not hand it to the record, the screen or a model.
 */
export function redactor(launch: ServerLaunch): (text: string) => string {
  const values = [...Object.entries(launch.env ?? {}), ...Object.entries(launch.headers ?? {})]
    .flatMap(([name, v]) => [v, ...v.split(/\s+/)].filter((part) => part.length >= (SECRET_NAME.test(name) || part === launch.headers?.[name] ? 1 : SHORTEST_HIDDEN)))
    // And any credential in its address or arguments, however short.
    .concat(secretValues(launch))
    .sort((a, b) => b.length - a.length);
  return (text) => values.reduce((t, v) => t.split(v).join('[hidden]'), text);
}

/**
 * Every string value inside a listed tool, hidden the same way: a description or schema is text a
 * model reads too. Names (the tool's, a schema's keys) stay as they are, so the tool is still the
 * tool the server calls by that name.
 */
const hiddenIn = <T>(value: T, hide: (text: string) => string): T =>
  typeof value === 'string' ? hide(value) as T
    : Array.isArray(value) ? value.map((v) => hiddenIn(v, hide)) as T
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, hiddenIn(v, hide)])) as T
        : value;

/** JSON object key order carries no tool semantics; array order and every value do. */
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, v]) => [key, canonical(v)])) : value;
export const canonicalDefinitionDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export class McpSession {
  private readonly client: Client;
  private readonly stderr: () => string;
  private readonly hide: (text: string) => string;
  private constructor(client: Client, stderr: () => string, hide: (text: string) => string) {
    this.client = client;
    this.stderr = stderr;
    this.hide = hide;
  }

  static async open(launch: ServerLaunch, timeoutMs = CONNECT_TIMEOUT_MS): Promise<McpSession> {
    let errors = '';
    const hide = redactor(launch);
    // A server started here gets only the SDK's short list of safe variables, plus what the person's own config names: the app's own secrets stay out.
    const transport = launch.transport === 'http'
      // A redirect can repeat a POST after the first endpoint has already applied its effect.
      ? new StreamableHTTPClientTransport(new URL(launch.url!), { requestInit: { headers: launch.headers, redirect: 'error' } })
      : new StdioClientTransport({ command: launch.command!, args: launch.args ?? [], env: { ...getDefaultEnvironment(), PATH: withToolFolders(getDefaultEnvironment().PATH), ...(launch.env ?? {}) }, cwd: launch.cwd, stderr: 'pipe' });
    if (transport instanceof StdioClientTransport) {
      const start = transport.start.bind(transport);
      transport.start = () => {
        if (launch.executableDigest && (!launch.command || binaryDigest(launch.command) !== launch.executableDigest)) return Promise.reject(new Error('The pinned executable changed before start.'));
        return start();
      };
      transport.stderr?.on('data', (d: Buffer) => { errors = (errors + d.toString()).slice(-2_000); });
    }
    // One approved crossing is one tools/call, not the SDK's interactive or tool-version retry flow.
    // Pin the current compatibility profile; modern manual workflows need their own gateway qualification.
    const client = new Client({ name: 'backbone', version: '0.0.0' }, {
      inputRequired: { autoFulfill: false },
      versionNegotiation: { mode: 'legacy' },
    });
    try {
      await within(client.connect(transport), timeoutMs, 'Starting the server');
    } catch (error) {
      await client.close().catch(() => {});
      throw new Error(hide(`${(error as Error).message}${errors ? ` It said: ${errors.trim().split('\n').at(-1)}` : ''}`));
    }
    // Inspect the wire result before the compatibility schema strips modern result markers.
    // Text alongside a request for another phase is not evidence that this call completed.
    const receive = transport.onmessage;
    transport.onmessage = (...args) => {
      const [message] = args;
      if ('result' in message && message.result && typeof message.result === 'object') {
        const result = message.result;
        if ('task' in result || 'requestState' in result || 'inputRequests' in result || ('resultType' in result && result.resultType !== 'complete')) {
          // A task record, even with a completed status, is not this tool's terminal result.
          args[0] = { jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'The server returned an unsupported or unfinished result. Completion is unknown.' } };
          receive?.(...args);
          return;
        }
      }
      receive?.(...args);
    };
    return new McpSession(client, () => hide(errors), hide);
  }

  /** Every tool, across every page. A listing cut short throws: a partial list would read as tools that are not there. */
  async tools(timeoutMs = CALL_TIMEOUT_MS): Promise<ListedTool[]> {
    try { return await this.listed(timeoutMs); }
    catch (error) { throw new Error(this.hide((error as Error).message ?? String(error))); }
  }

  private async listed(timeoutMs: number): Promise<ListedTool[]> {
    const out: ListedTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const listed = await within(this.client.listTools(cursor ? { cursor } : {}), timeoutMs, 'Listing the tools');
      for (const t of listed.tools) {
        out.push({
          definitionDigest: canonicalDefinitionDigest(t),
          definitionDigestVersion: 1,
          previousDefinitionDigest: createHash('sha256').update(JSON.stringify(t)).digest('hex'),
          name: t.name,
          ...hiddenIn({
          ...(t.title ? { title: t.title } : {}),
          description: t.description ?? '',
          inputSchema: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
          annotations: { ...(t.annotations ?? {}) },
          }, this.hide),
        });
      }
      cursor = listed.nextCursor;
      if (!cursor) return out;
    }
    throw new Error(`The server listed more than ${MAX_PAGES} pages of tools; the listing was not finished.`);
  }

  async call(name: string, args: Record<string, unknown>, signal: AbortSignal, timeoutMs = CALL_TIMEOUT_MS): Promise<CallAnswer> {
    try {
      const result = await within(this.client.callTool({ name, arguments: args }, { signal, timeout: timeoutMs }), timeoutMs + 1_000, 'The call');
      const answer = answerOf(result as CallResult);
      return { ...answer, text: this.hide(answer.text), observed: true };
    } catch (error) {
      if (signal.aborted) return { observed: false, status: 'failed', text: '', detail: 'Stopped before a verified tool result was retained. The request may have been sent.' };
      const message = this.hide((error as Error).message ?? String(error));
      if (error instanceof TimedOut || /timed? ?out|timeout/i.test(message)) return { observed: false, status: 'timed-out', text: '', detail: NOT_AN_ABSENCE['timed-out'] };
      if (RATE_LIMITED.test(message)) return { observed: false, status: 'rate-limited', text: '', detail: NOT_AN_ABSENCE['rate-limited'] };
      return { observed: false, status: 'failed', text: '', detail: `${NOT_AN_ABSENCE.failed} (${message.slice(0, 300)})` };
    }
  }

  /** Native Google setup only. The ordinary call path redacts configured values, including the
   * public client ID inside an OAuth URL. Deliver this one validated URL directly to main's
   * browser handoff; neither raw server prose nor the URL enters a model, receipt or projection. */
  async startGoogleAuthorization(service: 'calendar' | 'drive', email: string, origin: string, open: (url: string) => Promise<void>, current: () => boolean): Promise<boolean> {
    if (!current()) return false;
    try {
      const result = await within(this.client.callTool({ name: 'start_google_auth', arguments: { service_name: service, user_google_email: email } }, { timeout: CALL_TIMEOUT_MS }), CALL_TIMEOUT_MS + 1000, 'Google sign-in');
      const answer = answerOf(result as CallResult);
      const target = answer.text.match(/https?:\/\/[^\s<>"\])]+/)?.[0];
      if (answer.status !== 'complete' || !target || !current()) return false;
      const url = new URL(target);
      if (url.origin !== origin || url.username || url.password || ['client_secret', 'access_token', 'refresh_token'].some(key => url.searchParams.has(key))) return false;
      await open(url.toString()); return true;
    } catch { return false; }
  }

  async close() {
    await this.client.close().catch(() => {});
  }

  get lastError() {
    return this.stderr();
  }
}

interface CallResult {
  content?: { type: string; text?: string; [k: string]: unknown }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const RATE_LIMITED = /\b429\b|rate.?limit|too many requests|quota exceeded|resource.?exhausted/i;
const REPORTED_TIMEOUT = /timed?[\s_-]*out|timeout|deadline[\s_-]*(?:exceeded|expired)/i;
/** The words servers use for "there is more": a next page token or cursor, or a flag. */
const MORE = ['nextPageToken', 'nextCursor', 'next_cursor', 'next_page_token', 'cursor'];

function moreRemain(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  if (o.hasMore === true || o.has_more === true || o.truncated === true) return true;
  return MORE.some((k) => typeof o[k] === 'string' && (o[k] as string).length > 0);
}

/** The same said in text, as servers that answer in prose do: `page_token='…'`, `nextPageToken: …`, "more results". */
const MORE_IN_TEXT = /\b(next[_ ]?page[_ ]?token|page[_ ]?token|next[_ ]?cursor)\b\s*[=:]\s*['"]?[A-Za-z0-9_-]{2,}|\bmore results (are )?available\b/i;

function answerOf(result: CallResult): Omit<CallAnswer, 'observed'> {
  const parts = (result.content ?? []).map((c) => (c.type === 'text' ? c.text ?? '' : `[${c.type} content not shown]`));
  let text = parts.join('\n');
  if (!text && result.structuredContent) text = JSON.stringify(result.structuredContent);
  // Inspect the complete error before display clipping/redaction can hide its timeout evidence.
  // This only narrows effect authority; it does not change observed-result or read semantics.
  const reportedTimeout = result.isError === true && REPORTED_TIMEOUT.test(text + (result.structuredContent ? `\n${JSON.stringify(result.structuredContent)}` : ''));
  const clipped = text.length > MAX_TEXT;
  if (clipped) text = text.slice(0, MAX_TEXT);
  if (result.isError) {
    const status = RATE_LIMITED.test(text) ? 'rate-limited' : 'failed';
    return { status, text, detail: NOT_AN_ABSENCE[status], ...(reportedTimeout ? { reportedTimeout: true } : {}) };
  }
  let parsed: unknown = result.structuredContent;
  if (parsed === undefined) {
    try { parsed = JSON.parse(parts.join('')); } catch { parsed = undefined; }
  }
  if (clipped) return { status: 'partial', text, detail: 'The answer was longer than a turn takes, so it was cut. This is not everything.' };
  // Either form saying more remain is enough: structured content never vouches for what the text says.
  if (moreRemain(parsed) || MORE_IN_TEXT.test(text)) return { status: 'partial', text, detail: NOT_AN_ABSENCE.partial };
  return { status: 'complete', text };
}
