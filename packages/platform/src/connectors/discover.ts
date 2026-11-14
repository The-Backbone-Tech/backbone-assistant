// Where a person's MCP servers are: the configs of the AI tools they already use, read by the host
// and never by an engine, plus Backbone's own list in the data home. Each server keeps a stable id
// (where it was found, and its name there) and a fingerprint of how it starts: its transport,
// command, arguments, address and the *names* of its variables. Variable values are secrets more
// often than not, so they are never stored or shown: they are read again from the config each time
// the server starts. The app's own door entries are left out, so the host never calls itself.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml } from '@decimalturn/toml-patch';
import { parseJsonc } from '../tools/jsonc.ts';
import { ENTRY } from '../tools/mechanisms.ts';
import { homeOf, place, type ToolEnv } from '../tools/places.ts';
import { pluginInstalls } from '../memory/imports.ts';
import { codexPluginInstalls, codexPluginsTable, isObject, manifestWords } from '../memory/plugin-installs.ts';
import { readInside } from '../memory/safe-read.ts';
import type { ServerLaunch } from './client.ts';
import { catalogueEnvelope } from './catalogue-store.ts';

export type ServerSource = 'home' | 'claude-code' | 'claude-plugin' | 'claude-desktop' | 'codex' | 'codex-plugin' | 'cursor';
export const SOURCE_NAMES: Record<ServerSource, string> = { home: 'This app\'s own list', 'claude-code': 'Claude Code', 'claude-plugin': 'A Claude Code plugin', 'claude-desktop': 'Claude Desktop', codex: 'Codex', 'codex-plugin': 'A Codex plugin', cursor: 'Cursor' };
/** The sources that are plugins: third-party text, so a credential anywhere in one blocks its server. */
export const PLUGIN_SOURCES: readonly ServerSource[] = ['claude-plugin', 'codex-plugin'];

export interface FoundServer {
  id: string;
  name: string;
  source: ServerSource;
  /** Where it was read, for the person. */
  config: string;
  transport: 'stdio' | 'http';
  /** What the person is shown: the command and arguments, or the address. Never a variable's value. */
  shown: string;
  envNames: string[];
  fingerprint: string;
}

/** The app's own list of servers, in its data home, in Claude's `mcpServers` shape. */
export const ownServers = (home: string) => join(home, 'connectors', 'servers.json');

interface RawEntry { command?: unknown; args?: unknown; env?: unknown; cwd?: unknown; url?: unknown; type?: unknown; headers?: unknown; enabled?: unknown; disabled?: unknown; backboneCatalogue?: unknown }
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const record = (v: unknown): Record<string, string> => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'))
  : {});

function launchOf(raw: RawEntry): ServerLaunch | null {
  // An address's env is kept only so a cache-moving variable in it is seen; nothing reaches the server with it.
  if (typeof raw.url === 'string' && raw.url) { const env = record(raw.env); return { transport: 'http', url: raw.url, headers: record(raw.headers), ...(Object.keys(env).length ? { env } : {}) }; }
  if (typeof raw.command === 'string' && raw.command) return { transport: 'stdio', command: raw.command, args: strings(raw.args), env: record(raw.env), ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}) };
  return null;
}

const SECRET_FLAG = /^--?[\w-]*(token|key|secret|password|passwd|pass|auth|bearer|credential|cookie|session)[\w-]*(=|$)/i;
const SECRET_SHAPE = /(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[abprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{32,})/;
/**
 * What the person is shown, and the core records, of how a server starts: an address without its
 * user, password or query values, and arguments with any credential-looking value masked. The real
 * values are only ever read from the config when the server starts.
 */
export function shownOf(launch: ServerLaunch): string {
  if (launch.transport === 'http') {
    try {
      const u = new URL(launch.url!);
      if (u.username || u.password) { u.username = '***'; u.password = ''; }
      for (const k of [...u.searchParams.keys()]) u.searchParams.set(k, '***');
      u.pathname = u.pathname.split('/').map((seg) => (SECRET_SHAPE.test(decodeURIComponent(seg)) ? '***' : seg)).join('/');
      u.hash = '';
      return u.toString().replace(/%2A%2A%2A/g, '***');
    } catch { return '(an address that could not be read)'; }
  }
  const args = launch.args ?? [];
  const masked = args.map((a, i) => {
    if (SECRET_FLAG.test(a) && a.includes('=')) return `${a.slice(0, a.indexOf('=') + 1)}***`;
    if (i > 0 && SECRET_FLAG.test(args[i - 1]) && !args[i - 1].includes('=')) return '***';
    return a.replace(SECRET_SHAPE, '***');
  });
  return [launch.command, ...masked].join(' ');
}

/** The credential-looking values in how a server starts (its address and arguments), which a session hides from all it says. */
export function secretValues(launch: ServerLaunch): string[] {
  const out: string[] = [];
  if (launch.transport === 'http') {
    try {
      const u = new URL(launch.url!);
      // Each in both forms, decoded and as written in the address: a server may echo either.
      const both = (v: string) => { out.push(v); try { const d = decodeURIComponent(v); if (d !== v) out.push(d); } catch { /* kept as written */ } };
      if (u.password) both(u.password);
      if (u.username) both(u.username);
      for (const [k, v] of new URLSearchParams(u.search)) if (v) { out.push(v); out.push(encodeURIComponent(v)); void k; }
      for (const seg of u.pathname.split('/')) { let d = seg; try { d = decodeURIComponent(seg); } catch { /* as written */ } if (SECRET_SHAPE.test(d)) both(seg); }
    } catch { /* an address that cannot be read hides nothing more */ }
  }
  const args = launch.args ?? [];
  args.forEach((a, i) => {
    if (SECRET_FLAG.test(a) && a.includes('=')) out.push(a.slice(a.indexOf('=') + 1));
    else if (i > 0 && SECRET_FLAG.test(args[i - 1]) && !args[i - 1].includes('=')) out.push(a);
    else { const m = SECRET_SHAPE.exec(a); if (m) out.push(m[0]); }
  });
  return out.filter((v) => v.length > 0);
}

/** How it starts, without any value of a variable or header. */
export function fingerprintOf(launch: ServerLaunch): string {
  const shape = { transport: launch.transport, command: launch.command ?? null, args: launch.args ?? [], cwd: launch.cwd ?? null, url: launch.url ?? null,
    env: Object.keys(launch.env ?? {}).sort(), headers: Object.keys(launch.headers ?? {}).sort(), ...(launch.catalogue ? { catalogue: launch.catalogue } : {}) };
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex');
}

const isOurDoor = (name: string, launch: ServerLaunch) => name === ENTRY || name.startsWith(`${ENTRY}-`) || (launch.args ?? []).some((a) => /backbone-mcp|surfaces\/mcp\/src\/main\.ts/.test(a)) || /backbone-mcp$/.test(launch.command ?? '');

function entries(source: ServerSource, file: string): [string, RawEntry][] {
  if (!existsSync(file)) return [];
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return []; }
  let servers: unknown;
  try {
    if (source === 'codex') servers = (parseToml(text) as { mcp_servers?: unknown }).mcp_servers;
    else servers = (parseJsonc(text) as { mcpServers?: unknown } | null)?.mcpServers;
  } catch {
    return [];
  }
  if (!servers || typeof servers !== 'object') return [];
  return Object.entries(servers as Record<string, RawEntry>).filter(([, v]) => v && typeof v === 'object' && v.enabled !== false && v.disabled !== true);
}

export interface Discovered {
  server: FoundServer;
  launch: ServerLaunch;
  /**
   * A plugin's server: the plugin's install folder, which it may name, and its words, checked for
   * credentials and never shown. `literal` is scanned as written: its assembled name, the install and
   * config paths, every key of its entry and its plugin's manifests. `values` are its entry's string
   * values (command, arguments, variables, address), where a `${VAR}` reference names a variable.
   */
  plugin?: PluginWords;
}

const CLAUDE_ROOT = /\$\{CLAUDE_PLUGIN_ROOT\}/g;
/** Codex sets PLUGIN_ROOT, and CLAUDE_PLUGIN_ROOT for compatibility, for a plugin's commands. */
const CODEX_ROOT = /\$\{(?:CLAUDE_)?PLUGIN_ROOT\}/g;
/** `${CLAUDE_PLUGIN_ROOT}` (and for Codex `${PLUGIN_ROOT}`) is the plugin's install folder, where its agent substitutes it. */
function rooted(raw: RawEntry, root: string, pattern = CLAUDE_ROOT): RawEntry {
  const fill = (v: unknown) => (typeof v === 'string' ? v.replace(pattern, root) : v);
  const fillAll = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, fill(x)])) : v);
  return { ...raw, command: fill(raw.command), args: Array.isArray(raw.args) ? raw.args.map(fill) : raw.args, env: fillAll(raw.env), cwd: fill(raw.cwd), url: fill(raw.url), headers: fillAll(raw.headers) };
}

export interface PluginWords { root: string; literal: string[]; values: string[] }
type PluginEntry = { name: string; file: string; raw: RawEntry; plugin: PluginWords };
/** Every key of a parsed value, and every string value, apart. */
function keysAndValues(v: unknown, keys: string[] = [], values: string[] = []): { keys: string[]; values: string[] } {
  if (typeof v === 'string') values.push(v);
  else if (Array.isArray(v)) v.forEach((x) => keysAndValues(x, keys, values));
  else if (isObject(v)) for (const [k, x] of Object.entries(v)) { keys.push(k); keysAndValues(x, keys, values); }
  return { keys, values };
}
/** What a plugin server is checked by: everything its plugin wrote that is shown or used, and where it lies. */
function wordsOf(shownName: string, key: string, raw: unknown, root: string, file: string, manifest: string): PluginWords {
  const { keys, values } = keysAndValues(raw);
  return { root, literal: [shownName, key, root, file, manifest, ...keys], values };
}
/** `mcpServers` in a parsed config, or, where `bare`, the config itself as the map. */
function serversIn(text: string | null, bare: boolean): Record<string, RawEntry> {
  if (!text) return {};
  let parsed: unknown;
  try { parsed = parseJsonc(text); } catch { return {}; }
  const wrapped = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
  const map = wrapped !== undefined ? wrapped : bare ? parsed : undefined;
  return isObject(map) ? map as Record<string, RawEntry> : {};
}
const on = (raw: unknown): raw is RawEntry => isObject(raw) && raw.enabled !== false && raw.disabled !== true;

/**
 * The MCP servers of the Claude Code plugins the person enabled: `.mcp.json` at the install folder
 * (an `mcpServers` map, or the bare map: the docs show both) and an inline `mcpServers` object in
 * `.claude-plugin/plugin.json`, read only inside the install folder (memory/imports.ts pluginInstalls).
 */
function pluginEntries(t: ToolEnv): PluginEntry[] {
  const out: PluginEntry[] = [];
  const user = homeOf(t);
  for (const { id, root, segments } of pluginInstalls(user)) {
    const manifest = manifestWords(user, segments, 'claude') ?? '';
    for (const file of [join(root.path, '.mcp.json'), join(root.path, '.claude-plugin', 'plugin.json')]) {
      const text = readInside(root, file, 1_000_000);
      for (const [name, raw] of Object.entries(serversIn(text, !file.endsWith('plugin.json')))) {
        if (!on(raw)) continue;
        out.push({ name: `${id}/${name}`, file, raw: rooted(raw, root.path), plugin: wordsOf(`${id}/${name}`, name, raw, root.path, file, manifest) });
      }
    }
  }
  return out;
}

/**
 * The MCP servers of the Codex plugins the person enabled, where Codex documents them
 * (developers.openai.com/codex/plugins/build, read 5 November 2026): root `mcp.json` (the portable
 * format, wrapped in `mcpServers`) and `.mcp.json` (the compatibility format, wrapped or bare), read only
 * inside the install folder (memory/plugin-installs.ts), the portable one first when both name a server.
 * `${PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_ROOT}` are the install folder. A server Codex's plugin policy turns
 * off (`[plugins."<plugin>".mcp_servers.<server>] enabled = false`, under the bare plugin name as the docs
 * show it, or under `<plugin>@<marketplace>`) is not read. Where several version folders are present
 * each is read, and the version names the server.
 */
function codexPluginEntries(t: ToolEnv): PluginEntry[] {
  const user = homeOf(t);
  const table = codexPluginsTable(user);
  const installs = codexPluginInstalls(user);
  const policy = (plugin: string, server: string) => [plugin, plugin.slice(0, plugin.lastIndexOf('@'))].some((key) => {
    const servers = isObject(table[key]) ? (table[key] as Record<string, unknown>).mcp_servers : undefined;
    return isObject(servers) && isObject(servers[server]) && (servers[server] as Record<string, unknown>).enabled === false;
  });
  const out: PluginEntry[] = [];
  for (const { id, root, segments } of installs) {
    const versions = installs.filter((i) => i.id === id).length;
    const manifest = manifestWords(user, segments, 'codex') ?? '';
    const seen = new Set<string>();
    for (const [file, bare] of [[join(root.path, 'mcp.json'), false], [join(root.path, '.mcp.json'), true]] as const) {
      const text = readInside(root, file, 1_000_000);
      for (const [name, raw] of Object.entries(serversIn(text, bare))) {
        if (seen.has(name) || !on(raw) || policy(id, name)) continue;
        seen.add(name);
        const shown = versions > 1 ? `${id}/${segments.at(-1)}/${name}` : `${id}/${name}`;
        out.push({ name: shown, file, raw: rooted(raw, root.path, CODEX_ROOT), plugin: wordsOf(shown, name, raw, root.path, file, manifest) });
      }
    }
  }
  return out;
}

/** Every server the person has, as their configs say now. A config that cannot be read is skipped, not guessed. */
export function discover(home: string, t: ToolEnv, sources: ServerSource[] = ['home', 'claude-code', 'claude-plugin', 'claude-desktop', 'codex', 'codex-plugin', 'cursor']): Discovered[] {
  const out: Discovered[] = [];
  for (const source of sources) {
    const found: { name: string; raw: RawEntry; file: string; plugin?: PluginEntry['plugin'] }[] = source === 'claude-plugin' ? pluginEntries(t)
      : source === 'codex-plugin' ? codexPluginEntries(t)
      : entries(source, source === 'home' ? ownServers(home) : place(source, t).config).map(([name, raw]) => ({ name, raw, file: source === 'home' ? ownServers(home) : place(source, t).config }));
    for (const { name, raw, file, plugin } of found) {
      const launch = launchOf(raw);
      if (!launch || isOurDoor(name, launch)) continue;
      if (source === 'home' && catalogueEnvelope(raw.backboneCatalogue)) launch.catalogue = raw.backboneCatalogue;
      // A Codex plugin's server is known by a hash of its name, so an id never repeats words a plugin wrote.
      const id = source === 'codex-plugin' ? `${source}:${createHash('sha256').update(name).digest('hex').slice(0, 16)}` : `${source}:${name}`;
      out.push({
        launch,
        ...(plugin ? { plugin } : {}),
        server: {
          id,
          name,
          source,
          config: file,
          transport: launch.transport,
          shown: shownOf(launch),
          envNames: Object.keys(launch.env ?? {}).sort(),
          fingerprint: fingerprintOf(launch),
        },
      });
    }
  }
  return out;
}

/** The server as it starts now, read again from its config: its variables' values are never kept. */
export function launchFor(home: string, t: ToolEnv, id: string): Discovered | null {
  const source = id.slice(0, id.indexOf(':')) as ServerSource;
  if (!(source in SOURCE_NAMES)) return null;
  return discover(home, t, [source]).find((d) => d.server.id === id) ?? null;
}
