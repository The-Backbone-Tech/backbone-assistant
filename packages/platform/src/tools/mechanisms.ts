// How each tool's entry is read, written and removed: through the tool's own command where it has
// one (Claude Code, Codex), a careful merge of one key where it does not (Cursor), and Claude's own
// install dialog for Claude Desktop, whose config file is never written. Every entry starts the
// door inside the app and names only the data home in its environment. The entry's name is
// `backbone-door`, or the next free `backbone-door-<n>` beside an entry someone else made, which is
// never touched.
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import type { AiToolId } from '../api.ts';
import { sha256, writeAtomic } from '../stub/fsx.ts';
import { parse as parseToml, patch as patchToml } from '@decimalturn/toml-patch';
import { JsoncError, parseJsonc, removeMember, setMember, valueAt } from './jsonc.ts';
import { doorBundle } from './mcpb.ts';
import { findCommand, homeOf, type ToolEnv, type ToolPlace } from './places.ts';

export const ENTRY = 'backbone-door';
/** Our entry's name, distinctive as Docker's MCP_DOCKER is, so a `backbone` entry a person wrote by hand never meets it; then `backbone-door-2`, … while the name before is taken. */
export const entryName = (n: number) => (n === 1 ? ENTRY : `${ENTRY}-${n}`);

export interface Entry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** The tool's settings could not be read; nothing is changed. */
export class Unreadable extends Error {}
/** The tool's own mechanism did not do what was asked. */
export class MechanismFailed extends Error {}

/** How a settings file compares with its save point once our entry is gone. */
export type Check = 'identical' | 'tool-state-only' | 'changed-since' | 'ours-remains';

export interface WriteContext {
  t: ToolEnv;
  place: ToolPlace;
  /** The entry's name in the tool's settings. */
  name: string;
  entry: Entry;
  /** For Codex: `prompt` when the person asked to approve each call, otherwise the least-prompting mode. */
  askEachCall: boolean;
  /** Where this tool's files go in the data home (Claude Desktop's bundle). */
  dir: string;
  label: string;
  version: string;
  grant: string;
}

export interface Mechanism {
  /** The entry with this name as it stands now, read-only: null when there is none. */
  read(place: ToolPlace, t: ToolEnv, name: string): Promise<Entry | null>;
  /** Add the entry; returns the hash of what the tool's file holds afterwards, when this app wrote it. */
  add(ctx: WriteContext): Promise<{ written?: string; bundle?: string }>;
  /** Remove the entry. `original` is the file as the save point holds it, and `written` the hash of what this app wrote. */
  remove(ctx: { t: ToolEnv; place: ToolPlace; name: string; original?: Buffer | null; written?: string; bundle?: string }): Promise<void>;
  /** Compare the file's text now with its save point, our entry aside. */
  check(before: Buffer | null, now: Buffer | null, name: string): Check;
}

interface Ran {
  code: number;
  out: string;
  /** Standard output alone, for a command that answers in JSON (warnings go to stderr). */
  stdout: string;
}

/** Run the tool's own command, with its folder first on PATH so a `#!/usr/bin/env node` script finds its node. */
function run(t: ToolEnv, command: string, args: string[]): Promise<Ran> {
  const PATH = [dirname(command), ...(t.env.PATH ?? '').split(delimiter), ...t.bins].filter(Boolean).join(delimiter);
  return new Promise((resolve) => {
    execFile(command, args, { env: { ...t.env, PATH }, cwd: homeOf(t), timeout: 60_000, encoding: 'utf8', maxBuffer: 4 << 20 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, out: `${stdout}${stderr}`.trim().slice(0, 2_000), stdout });
    });
  });
}

const readBytes = (path: string): Buffer | null => (existsSync(path) ? readFileSync(path) : null);

/** Write a tool's file whole, keeping its permissions. */
function writeKeepingMode(path: string, text: string) {
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o644;
  writeAtomic(path, text);
  chmodSync(path, mode);
}

const asEntry = (v: unknown): Entry | null => {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  return { command: String(o.command ?? ''), args: Array.isArray(o.args) ? o.args.map(String) : [], env: (o.env && typeof o.env === 'object' ? o.env : {}) as Record<string, string> };
};

function needCommand(place: ToolPlace): string {
  if (!place.command) throw new MechanismFailed(`${place.name}'s own command was not found on this computer, so its settings were not changed.`);
  return place.command;
}

const without = (o: Record<string, unknown> | undefined, key: string) => {
  const { [key]: _drop, ...rest } = o ?? {};
  return rest;
};
/** Key order aside, the same value. */
const canonical = (v: unknown): unknown =>
  v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]))
    : Array.isArray(v) ? v.map(canonical) : v;
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---- Claude Code: `claude mcp add -s user` and `claude mcp remove -s user` --------------------------

const claudeCode: Mechanism = {
  async read(place, _t, name) {
    const bytes = readBytes(place.config);
    if (!bytes || !bytes.toString('utf8').trim()) return null;
    try {
      const settings = JSON.parse(bytes.toString('utf8')) as { mcpServers?: Record<string, unknown> };
      return asEntry(settings.mcpServers?.[name]);
    } catch {
      throw new Unreadable(`Claude Code's settings file could not be read (${place.config}).`);
    }
  },
  async add({ t, place, name, entry }) {
    const env = Object.entries(entry.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const r = await run(t, needCommand(place), ['mcp', 'add', '-s', 'user', name, ...env, '--', entry.command, ...entry.args]);
    if (r.code !== 0) throw new MechanismFailed(`Claude Code did not add the entry: ${r.out}`);
    return {};
  },
  async remove({ t, place, name }) {
    const r = await run(t, needCommand(place), ['mcp', 'remove', '-s', 'user', name]);
    if (r.code !== 0 && (await claudeCode.read(place, t, name))) throw new MechanismFailed(`Claude Code did not remove the entry: ${r.out}`);
  },
  check(before, now, name) {
    if ((!before && !now) || (before && now && before.equals(now))) return 'identical';
    try {
      const b = before ? (JSON.parse(before.toString('utf8')) as Record<string, unknown>) : {};
      const n = now ? (JSON.parse(now.toString('utf8')) as Record<string, unknown>) : {};
      const servers = (o: Record<string, unknown>) => o.mcpServers as Record<string, unknown> | undefined;
      if (servers(n)?.[name] !== undefined && servers(b)?.[name] === undefined) return 'ours-remains';
      if (!same(without(servers(b), name), without(servers(n), name))) return 'changed-since';
      // Claude Code keeps its own state in the same file and rewrites it as it runs.
      return 'tool-state-only';
    } catch {
      return 'changed-since';
    }
  },
};

// ---- Codex: `codex mcp add` and `codex mcp remove` -------------------------------------------------

/** Tests only compare texts with it; the app itself compares parsed TOML. */
const tableOf = (name: string) => new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:"${escape(name)}"|${escape(name)})\\s*(?:\\]|\\.)`);
/** The file's text with the tables of the server `name` (`[mcp_servers.<name>]` and its sub-tables) left out. */
export function withoutCodexEntry(text: string, name: string = ENTRY): string {
  const mine = tableOf(name);
  const out: string[] = [];
  let ours = false;
  for (const line of text.split('\n')) {
    if (/^\s*\[/.test(line)) ours = mine.test(line);
    if (!ours) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

const codex: Mechanism = {
  async read(place, t, name) {
    if (!existsSync(place.config)) return null;
    const r = await run(t, needCommand(place), ['mcp', 'get', name, '--json']);
    if (r.code === 0) {
      try {
        const got = JSON.parse(r.stdout) as { transport?: unknown };
        return asEntry(got.transport) ?? { command: '', args: [], env: {} };
      } catch {
        throw new Unreadable('Codex answered in a way this app does not understand; nothing was changed.');
      }
    }
    if (/No MCP server named/i.test(r.out)) return null;
    throw new Unreadable(`Codex could not read its settings (${place.config}): ${r.out}`);
  },
  async add({ t, place, name, entry, askEachCall }) {
    const command = needCommand(place);
    const env = Object.entries(entry.env).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
    const r = await run(t, command, ['mcp', 'add', name, ...env, '--', entry.command, ...entry.args]);
    if (r.code !== 0) throw new MechanismFailed(`Codex did not add the entry: ${r.out}`);
    // `codex mcp add` has no option for the approval mode (Codex 0.162.1 refuses it as a -c override
    // at add time), so it is set in the table Codex just wrote with a TOML-aware, format-preserving
    // edit (toml-patch: parse, change one key, patch the text), then read back by parsing. The door
    // already checks every call against the person's permission: Codex asks again only when they chose that.
    const mode = askEachCall ? 'prompt' : 'approve';
    const text = readFileSync(place.config, 'utf8');
    const value = parseToml(text) as { mcp_servers?: Record<string, Record<string, unknown>> };
    const table = value.mcp_servers?.[name];
    if (!table) throw new MechanismFailed('Codex wrote its entry in a form this app does not recognise.');
    table.default_tools_approval_mode = mode;
    const next = patchToml(text, value);
    if ((parseToml(next) as typeof value).mcp_servers?.[name]?.default_tools_approval_mode !== mode) throw new MechanismFailed('The approval mode did not read back as it was set.');
    writeKeepingMode(place.config, next);
    const back = await codex.read(place, t, name);
    if (!back || back.command !== entry.command) throw new MechanismFailed('Codex did not read the entry back as it was written.');
    return {};
  },
  async remove({ t, place, name }) {
    const r = await run(t, needCommand(place), ['mcp', 'remove', name]);
    if (r.code !== 0) throw new MechanismFailed(`Codex did not remove the entry: ${r.out}`);
  },
  check(before, now, name) {
    if ((!before && !now) || (before && now && before.equals(now))) return 'identical';
    // Compared as TOML, not as lines: a multiline string can hold anything.
    try {
      const servers = (b: Buffer | null) => (parseToml(b?.toString('utf8') ?? '') as { mcp_servers?: Record<string, unknown> }).mcp_servers ?? {};
      const value = (b: Buffer | null) => parseToml(b?.toString('utf8') ?? '') as Record<string, unknown>;
      if (servers(now)[name] !== undefined && servers(before)[name] === undefined) return 'ours-remains';
      const strip = (v: Record<string, unknown>) => ({ ...v, mcp_servers: without(v.mcp_servers as Record<string, unknown> | undefined, name) });
      return same(strip(value(before)), strip(value(now))) ? 'tool-state-only' : 'changed-since';
    } catch {
      return 'changed-since';
    }
  },
};

// ---- Cursor: a careful merge of one key in $HOME/.cursor/mcp.json ----------------------------------------

function cursorText(path: string): string | null {
  const bytes = readBytes(path);
  return bytes ? bytes.toString('utf8') : null;
}
const unreadable = (error: unknown) => new Unreadable(`Cursor's settings file could not be read (${error instanceof JsoncError ? error.message : 'not JSON'}), so it was left as it is.`);

const cursor: Mechanism = {
  async read(place, _t, name) {
    const text = cursorText(place.config);
    if (text === null || !text.trim()) return null;
    try {
      return asEntry(valueAt(parseJsonc(text), ['mcpServers', name]));
    } catch (error) {
      throw unreadable(error);
    }
  },
  async add({ place, name, entry }) {
    const text = cursorText(place.config);
    const base = text?.trim() ? text : '{}\n';
    let next: string;
    try {
      next = setMember(base, ['mcpServers'], name, { command: entry.command, args: entry.args, env: entry.env });
    } catch (error) {
      throw unreadable(error);
    }
    writeKeepingMode(place.config, next);
    return { written: sha256(next) };
  },
  async remove({ place, name, original, written }) {
    const text = cursorText(place.config);
    if (text === null) return;
    // Untouched since we wrote it: put back exactly what was there.
    if (written && sha256(text) === written && original !== undefined) {
      if (original === null) rmSync(place.config, { force: true });
      else writeKeepingMode(place.config, original.toString('utf8'));
      return;
    }
    try {
      writeKeepingMode(place.config, removeMember(text, ['mcpServers'], name));
    } catch {
      throw new Unreadable('Cursor\'s settings file was changed since and can no longer be read, so the entry was left in place.');
    }
  },
  check(before, now, name) {
    if ((!before && !now) || (before && now && before.equals(now))) return 'identical';
    try {
      const value = (b: Buffer | null) => (b && b.toString('utf8').trim() ? (parseJsonc(b.toString('utf8')) as Record<string, unknown>) : {});
      const servers = (o: Record<string, unknown>) => o.mcpServers as Record<string, unknown> | undefined;
      if (servers(value(now))?.[name] !== undefined && servers(value(before))?.[name] === undefined) return 'ours-remains';
      return 'changed-since';
    } catch {
      return 'changed-since';
    }
  },
};

// ---- Claude Desktop: a bundle opened in Claude, whose own dialog installs it ---------------------------

const claudeDesktop: Mechanism = {
  async read(place, _t, name) {
    const bytes = readBytes(place.config);
    if (!bytes) return null;
    try {
      return asEntry((JSON.parse(bytes.toString('utf8')) as { mcpServers?: Record<string, unknown> }).mcpServers?.[name]);
    } catch {
      throw new Unreadable(`Claude's settings file could not be read (${place.config}).`);
    }
  },
  async add({ t, place, name, dir, label, version, grant, entry }) {
    const bundle = join(dir, `${name}-${grant}.mcpb`);
    writeAtomic(bundle, doorBundle({ name, label, version, door: entry.command, grant, home: entry.env.BACKBONE_HOME }));
    const open = findCommand('open', t, ['/usr/bin/open']);
    if (!open) throw new MechanismFailed('This computer has no command to open the bundle with.');
    const r = await run(t, open, place.app ? ['-a', place.app, bundle] : [bundle]);
    if (r.code !== 0) throw new MechanismFailed(`Claude did not open the bundle: ${r.out}`);
    return { bundle };
  },
  async remove({ bundle }) {
    if (bundle) rmSync(bundle, { force: true });
  },
  check(before, now) {
    return (!before && !now) || (before && now && before.equals(now)) ? 'identical' : 'changed-since';
  },
};

export const MECHANISMS: Record<AiToolId, Mechanism> = { 'claude-code': claudeCode, codex, cursor, 'claude-desktop': claudeDesktop };
