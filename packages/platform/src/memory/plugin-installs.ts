// Where Codex's own plugins are installed, and the checks every plugin reader shares: a path a manifest
// declares stays inside the plugin's own folder through no link, and a credential is found in a
// manifest's raw words and in every key and string decoded from it. Used by plugin skills
// (memory/imports.ts), plugin commands, agents and hooks (memory/plugin-parts.ts) and plugin MCP servers
// (connectors/discover.ts).
//
// Codex documents its plugins at developers.openai.com/codex/plugins/build (read 5 November 2026):
// installed under $HOME/.codex/plugins/cache/<marketplace>/<plugin>/<version>/ and enabled by
// `[plugins."<plugin>@<marketplace>"] enabled = true` in $HOME/.codex/config.toml. A repository's own
// `.codex/config.toml` can also enable a plugin for that project, loaded only when Codex trusts the
// project; Backbone's plugin discovery is per person, not per project, so that layer is not read
// (docs/contracts/skills.md).
import { lstatSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { parse as parseToml } from '@decimalturn/toml-patch';
import { holdsCredential } from './learn.ts';
import { anchoredRoot, foldersIn, readInside, type Root } from './safe-read.ts';

const MAX_CONFIG = 1024 * 1024;
const MAX_MANIFEST = 256 * 1024;
/** A folder name taken from a record or a config key: no separator, and not `.` or `..`. */
export const SEGMENT = /^(?!\.{1,2}$)[\w.-]{1,128}$/;
export const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** Every key and string in a parsed JSON value, decoded, so a credential written with escapes is found. */
export const leaves = (v: unknown): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(leaves) : isObject(v) ? Object.entries(v).flatMap(([k, x]) => [k, ...leaves(x)]) : []);
const inside = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/** An enabled plugin's install folder, anchored segment by segment under the person's home. */
export interface PluginInstall { id: string; root: Root; segments: string[] }

/** The `plugins` table of $HOME/.codex/config.toml, or nothing. Of config.toml only this table is used. */
export function codexPluginsTable(userHome: string): Record<string, unknown> {
  const codex = anchoredRoot(userHome, ['.codex']);
  if (!codex) return {};
  try {
    const plugins = (parseToml(readInside(codex, join(codex.path, 'config.toml'), MAX_CONFIG) ?? '') as { plugins?: unknown }).plugins;
    return isObject(plugins) ? plugins : {};
  } catch { return {}; }
}

/**
 * Codex's own plugins the person enabled in $HOME/.codex/config.toml, at each version folder under
 * $HOME/.codex/plugins/cache/<marketplace>/<plugin>/. Codex does not document which of several versions
 * it uses, so each present is read. A name that is not a plain folder name, and a link, are skipped.
 */
export function codexPluginInstalls(userHome: string): PluginInstall[] {
  if (!anchoredRoot(userHome, ['.codex', 'plugins', 'cache'])) return [];
  const out: PluginInstall[] = [];
  for (const [id, entry] of Object.entries(codexPluginsTable(userHome))) {
    if (!isObject(entry) || entry.enabled !== true) continue;
    const at = id.lastIndexOf('@');
    const [name, market] = [id.slice(0, at), id.slice(at + 1)];
    if (at < 1 || !SEGMENT.test(name) || !SEGMENT.test(market)) continue;
    const folder = anchoredRoot(userHome, ['.codex', 'plugins', 'cache', market, name]);
    if (!folder) continue;
    for (const version of foldersIn(folder, folder.path)) {
      if (version.startsWith('.') || !SEGMENT.test(version)) continue;
      const segments = ['.codex', 'plugins', 'cache', market, name, version];
      const root = anchoredRoot(userHome, segments);
      if (root) out.push({ id, root, segments });
    }
  }
  return out;
}

/** Where a declared path leads: a folder or a file inside the plugin, anchored; or why it is refused. */
export type Resolved = { dir: Root } | { file: string; at: Root } | { refused: string };
/**
 * A path a manifest declares: it must start with `./`, hold no `..`, go through no link (one pointing back
 * inside is not followed either) and resolve, after realpath, inside the plugin's own folder.
 */
export function resolveDeclared(userHome: string, segments: string[], root: Root, value: unknown): Resolved {
  if (typeof value !== 'string' || !value) return { refused: 'is not a path' };
  if (!value.startsWith('./')) return { refused: 'does not start with ./ inside the plugin folder' };
  const parts = value.slice(2).split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..' || p.includes('\\') || p.includes('\0'))) return { refused: 'leads outside the plugin folder' };
  let at = root.path;
  for (const part of parts) {
    at = join(at, part);
    let link: boolean;
    try { link = lstatSync(at).isSymbolicLink(); } catch { return { refused: 'is not there' }; }
    if (link) return { refused: 'goes through a link, which is not followed' };
  }
  let real: string;
  try { real = realpathSync(at); } catch { return { refused: 'is not there' }; }
  if (!inside(real, root.real)) return { refused: 'leads outside the plugin folder' };
  const stat = lstatSync(at);
  if (stat.isDirectory()) { const dir = anchoredRoot(userHome, [...segments, ...parts]); return dir ? { dir } : { refused: 'could not be read safely' }; }
  if (!stat.isFile() || !parts.length) return { refused: 'is not a file or a folder' };
  const parent = anchoredRoot(userHome, [...segments, ...parts.slice(0, -1)]);
  return parent ? { file: at, at: parent } : { refused: 'could not be read safely' };
}

/** A file inside an install, by its path from the install folder, read from the checked handle; or null. */
export function readInInstall(userHome: string, segments: string[], rel: string[], max = MAX_MANIFEST): string | null {
  const at = anchoredRoot(userHome, [...segments, ...rel.slice(0, -1)]);
  return at ? readInside(at, join(at.path, rel.at(-1)!), max) : null;
}
export const parseJson = (text: string | null): unknown => { try { return text === null ? null : JSON.parse(text); } catch { return null; } };

/** The manifests a plugin of this origin may carry, by path from its install folder. */
export const MANIFESTS: Record<'claude' | 'codex', string[][]> = { claude: [['.claude-plugin', 'plugin.json']], codex: [['plugin.json'], ['.codex-plugin', 'plugin.json']] };
/** Its manifests' words, raw and as every decoded key and string, for a credential check; never shown. */
export function manifestWords(userHome: string, segments: string[], origin: 'claude' | 'codex'): string | undefined {
  return MANIFESTS[origin].map((rel) => readInInstall(userHome, segments, rel)).flatMap((text) => (text === null ? [] : [text, ...leaves(parseJson(text))])).join('\n') || undefined;
}

/** Without whitespace or the separators a list is written with, so a credential split across them is found. */
const compact = (text: string) => text.replace(/[\s,;|]+/g, '');
/**
 * A credential in these words: a stored value or a credential's shape, as written, and a stored value
 * with whitespace and `,` `;` `|` taken out of both (only stored values: a shape found in words run
 * together would be a false alarm). Encoded forms are not decoded (docs/contracts/skills.md).
 */
export function holds(text: string, exact: readonly string[]): boolean {
  return holdsCredential(text, exact) || holdsStored(text, exact);
}
/** A stored value in these words, with whitespace and `,` `;` `|` taken out of both: for words joined from several fields, where a shape would be a false alarm. */
export function holdsStored(text: string, exact: readonly string[]): boolean {
  const joined = compact(text);
  return exact.some((v) => { const c = compact(v); return c.length > 0 && joined.includes(c); });
}
