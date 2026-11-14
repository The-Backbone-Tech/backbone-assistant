// Memories copied in from other agents, and the person's skills. An import is read-only and a copy:
// the source file is never changed, every line keeps the path it came from, and a line that holds a
// credential is left behind. Only markdown is read, through safe-read.ts: inside a named root at
// every level, through no link, from the handle that was checked. The named roots are Codex's
// memories folder, Claude's CLAUDE.md and its projects' memory folders, and a markdown file the
// person names, which may not lie in a place that holds credentials.
//
// Skills are SKILL.md folders, the open format Claude, Codex and others share: the data home's own,
// and the person's under .claude, .codex and .agents in their home folder. One found in those folders
// is listed as available and given to no turn until the person enables it; enabling pins its text,
// so a skill changed afterwards is available again until re-enabled. A skill drafted from a finished
// task waits under skills/.proposed for the person's OK; so does an edit to an accepted skill, under
// skills/.edits; an accepted skill unused for 30 days is archived to skills/.archive, restorable
// (memory/skill-learning.ts). A skill is reference material: it is given to an engine beside the
// person's words, and it can change no permission.
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { MemoryImportResult, MemorySource, Skill } from '../api.ts';
import { assertSafeMemory, MemoryScanRefused } from './scan.ts';
import { readJson } from '../stub/fsx.ts';
import { holdsCredential } from './learn.ts';
import { codexPluginInstalls, holds, isObject, manifestWords, parseJson, readInInstall, resolveDeclared } from './plugin-installs.ts';
import { anchoredRoot, foldersIn, inCredentialPlace, markdownIn, moveUnder, openRoot, readInside, removeUnder, skillsRoot, writeUnder, type Root } from './safe-read.ts';
import { slugOf, terms, type MemoryStore, type SourceState } from './store.ts';
import { recordSkillOrigin } from './skill-controls.ts';

const MAX_FILE = 256 * 1024;
const MAX_LINES = 500;
const MAX_SKILL_TEXT = 6_000;

/** The lines of a markdown file worth keeping: bullets and plain sentences; not headings, front matter or code. */
function linesOf(text: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  let fence = false;
  let front = text.startsWith('---\n');
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (front) { if (i > 0 && line === '---') front = false; continue; }
    if (line.startsWith('```')) { fence = !fence; continue; }
    if (fence || !line || line.startsWith('#') || line.startsWith('<!--') || /^[-*_]{3,}$/.test(line)) continue;
    const item = /^(?:[-*+]|\d+\.)\s+(.+)$/.exec(line)?.[1] ?? line;
    if (item.length > 2) out.push({ text: item.length > 500 ? `${item.slice(0, 497)}…` : item, line: i + 1 });
  }
  return out;
}

/** Each file to import, with the root it must stay inside. */
function sources(a: { from: 'codex' | 'claude' | 'file'; path?: string }, userHome: string | undefined): { root: Root; file: string }[] {
  if (a.from !== 'file' && !userHome) throw new Error(`No user home is named for this data home, so no ${a.from === 'codex' ? 'Codex' : 'Claude'} folder was read. Set BACKBONE_USER_HOME to the home folder to read, or import a file.`);
  if (a.from === 'codex') {
    const root = anchoredRoot(userHome!, ['.codex', 'memories']);
    return root ? markdownIn(root).map((file) => ({ root, file })) : [];
  }
  if (a.from === 'claude') {
    const claude = anchoredRoot(userHome!, ['.claude']);
    if (!claude) return [];
    const found = [{ root: claude, file: join(claude.path, 'CLAUDE.md') }];
    const projects = anchoredRoot(userHome!, ['.claude', 'projects']);
    for (const project of projects ? foldersIn(projects, projects.path) : []) {
      const memory = anchoredRoot(userHome!, ['.claude', 'projects', project, 'memory']);
      if (memory) found.push(...markdownIn(memory, memory.path, 0).map((file) => ({ root: memory, file })));
    }
    return found;
  }
  const path = a.path ?? '';
  if (!/\.md$/i.test(path)) throw new Error('Only markdown files can be imported, and not through a link.');
  // Credential places are the person's own, named or not: always kept out.
  if (inCredentialPlace(path, userHome ?? homedir())) throw new Error('That file is in a place that holds credentials; it is not read.');
  const root = openRoot(dirname(path));
  if (!root) throw new Error('Only markdown files can be imported, and not through a link.');
  return [{ root, file: path }];
}

/**
 * Memory lines from text already read (an export's file, held in memory once it was checked): the
 * same filtering, limits and provenance as a file import, without opening any path.
 */
export function importMemoryText(store: MemoryStore, text: string, source: string, state: SourceState, exact: readonly string[] = []): MemoryImportResult {
  if (Buffer.byteLength(text) > MAX_FILE) throw new Error('That memory file is too large to import.');
  const topic = 'imported-export';
  let added = 0;
  const skipped: NonNullable<MemoryImportResult['skipped']> = [];
  for (const [taken, item] of linesOf(text).entries()) {
    const line = item.text;
    if (taken >= MAX_LINES) break;
    if (holdsCredential(line, exact)) { skipped.push({ source, line: item.line, reason: 'credential' }); continue; }
    try {
      assertSafeMemory(line, topic);
      if (store.find(topic, line)) continue;
      if (store.add({ topic, text: line, origin: { kind: 'import', source }, sources: [] }, state)) added++;
    } catch (error) {
      if (!(error instanceof MemoryScanRefused)) throw error;
      skipped.push({ source, line: item.line, reason: error.kind });
    }
  }
  return { added, skipped };
}

export function importMemories(store: MemoryStore, a: { from: 'codex' | 'claude' | 'file'; path?: string }, userHome: string | undefined, state: SourceState, exact: readonly string[] = []): MemoryImportResult {
  const topic = a.from === 'file' ? `imported-${slugOf(basename(a.path ?? '', '.md'))}` : `imported-${a.from}`;
  const files = sources(a, userHome);
  let added = 0;
  const skipped: NonNullable<MemoryImportResult['skipped']> = [];
  let taken = 0;
  for (const { root, file } of files) {
    const text = readInside(root, file, MAX_FILE);
    if (text === null) {
      if (a.from === 'file') throw new Error('Only markdown files can be imported, and not through a link.');
      continue;
    }
    for (const item of linesOf(text)) {
      const line = item.text;
      if (taken++ >= MAX_LINES) return { added, skipped };
      if (holdsCredential(line, exact)) { skipped.push({ source: file, line: item.line, reason: 'credential' }); continue; }
      try {
        assertSafeMemory(line, topic);
        if (store.find(topic, line)) continue;
        if (store.add({ topic, text: line, origin: { kind: 'import', source: file }, sources: [] }, state)) added++;
      } catch (error) {
        if (!(error instanceof MemoryScanRefused)) throw error;
        skipped.push({ source: file, line: item.line, reason: error.kind });
      }
    }
  }
  return { added, skipped };
}

const idOf = (path: string) => createHash('sha256').update(path).digest('hex').slice(0, 16);
export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const enabledPath = (home: string) => join(home, 'skills', '.enabled.json');
/** A record beside the skills, written only into the anchored skills folder. */
export const writeRecord = (home: string, file: string, value: unknown) => writeUnder(skillsRoot(home), [], file, `${JSON.stringify(value, null, 2)}\n`);
/** Join sources to those recorded under a key: never replaced, only added to. */
export function addSources(home: string, key: string, more: readonly MemorySource[]) {
  const all = readJson<Sources>(sourcesPath(home), {});
  const prior = all[key] ?? [];
  const joined = [...prior, ...more.filter((s) => !prior.some((p) => p.id === s.id && p.version === s.version))];
  if (joined.length !== prior.length || !(key in all)) writeRecord(home, '.sources.json', { ...all, [key]: joined });
}
/** What each drafted skill was made from, by its folder's name (an edit's as `edit:<name>`): it leaves when one is withdrawn. */
export const sourcesPath = (home: string) => join(home, 'skills', '.sources.json');
type Enabled = Record<string, string>;
export type Sources = Record<string, MemorySource[]>;
export const ARCHIVE = '.archive';
export const EDITS = '.edits';
/** Where a data-home skill's sources are recorded: an edit's are its own, beside its skill's. */
const sourceKeys = (home: string, path: string) => {
  const name = basename(dirname(path));
  return dirname(dirname(path)) === join(home, 'skills', EDITS) ? [name, `edit:${name}`] : [name];
};

export function frontMatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  return Object.fromEntries((m?.[1] ?? '').split('\n').map((l) => /^([\w-]+):\s*(.*)$/.exec(l)).filter((x) => !!x).map((x) => [x[1], x[2].replace(/^["']|["']$/g, '')]));
}

/** A found skill with its text; a plugin's also with its manifests' words, checked for credentials and never shown. */
export interface Found extends Skill { text: string; manifest?: string }

function skillsIn(root: Root | null, origin: Skill['origin'], state: (path: string, text: string) => Skill['state'], from?: { plugin: string; manifest?: string }): Found[] {
  if (!root) return [];
  return foldersIn(root, root.path).filter((name) => !name.startsWith('.')).flatMap((name) => {
    const file = join(root.path, name, 'SKILL.md');
    const text = readInside(root, file, MAX_FILE);
    if (text === null) return [];
    const meta = frontMatter(text);
    return [{ id: idOf(file), name: meta.name || name, description: meta.description ?? '', path: file, origin, state: state(file, text), text, ...(from ? { plugin: from.plugin, ...(from.manifest ? { manifest: from.manifest } : {}) } : {}) }];
  });
}

/**
 * The Claude Code plugins the person enabled (`enabledPlugins` true in $HOME/.claude/settings.json),
 * at each install's folder as installed_plugins.json records it. Only a folder inside
 * $HOME/.claude/plugins/cache is given, anchored segment by segment as any skills folder is, so no
 * record and no link can point a reader elsewhere. The record's shape is not documented: anything
 * not as expected is skipped. Of settings.json only `enabledPlugins` is used.
 */
export function pluginInstalls(userHome: string): { id: string; root: Root; segments: string[] }[] {
  const claude = anchoredRoot(userHome, ['.claude']);
  const plugins = anchoredRoot(userHome, ['.claude', 'plugins']);
  const cache = anchoredRoot(userHome, ['.claude', 'plugins', 'cache']);
  if (!claude || !plugins || !cache) return [];
  const json = (root: Root, name: string): unknown => { try { return JSON.parse(readInside(root, join(root.path, name), MAX_FILE) ?? 'null'); } catch { return null; } };
  const enabled = (json(claude, 'settings.json') as { enabledPlugins?: Record<string, unknown> } | null)?.enabledPlugins ?? {};
  const installed = (json(plugins, 'installed_plugins.json') as { plugins?: Record<string, unknown> } | null)?.plugins ?? {};
  const out: { id: string; root: Root; segments: string[] }[] = [];
  for (const [id, on] of Object.entries(enabled)) {
    if (on !== true || !Object.hasOwn(installed, id)) continue;
    const records = Array.isArray(installed[id]) ? installed[id] as unknown[] : [installed[id]];
    for (const r of records) {
      const at = (r as { installPath?: unknown } | null)?.installPath;
      if (typeof at !== 'string') continue;
      const rel = relative(cache.path, at);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue;
      const segments = ['.claude', 'plugins', 'cache', ...rel.split(sep)];
      const root = anchoredRoot(userHome, segments);
      if (root) out.push({ id, root, segments });
    }
  }
  return out;
}

/**
 * The skills folders of the Claude Code and Codex plugins the person enabled, each with its plugin's id and
 * manifest words. A Codex plugin's are its root `skills/` folder, as Codex documents (portable packages
 * discover skills there), and the `skills` folder its compatibility manifest `.codex-plugin/plugin.json`
 * declares, read only when the root plugin.json has no `extensions["com.openai"]` object (that manifest
 * is then the fallback Codex reads) and only inside the plugin's own folder, through no link. Their
 * commands, agents and hooks are read by memory/plugin-parts.ts.
 */
function pluginSkillRoots(userHome: string): { root: Root; origin: 'claude' | 'codex'; plugin: string; manifest?: string }[] {
  const out: { root: Root; origin: 'claude' | 'codex'; plugin: string; manifest?: string }[] = [];
  for (const { id, segments } of pluginInstalls(userHome)) {
    const root = anchoredRoot(userHome, [...segments, 'skills']);
    if (root) out.push({ root, origin: 'claude', plugin: id, manifest: manifestWords(userHome, segments, 'claude') });
  }
  for (const { id, root: install, segments } of codexPluginInstalls(userHome)) {
    const manifest = manifestWords(userHome, segments, 'codex');
    const roots = [anchoredRoot(userHome, [...segments, 'skills'])];
    const portable = parseJson(readInInstall(userHome, segments, ['plugin.json']));
    const overlay = parseJson(readInInstall(userHome, segments, ['.codex-plugin', 'plugin.json']));
    const extension = isObject(portable) && isObject(portable.extensions) && isObject(portable.extensions['com.openai']);
    if (!extension && isObject(overlay) && overlay.skills !== undefined) {
      for (const value of Array.isArray(overlay.skills) ? overlay.skills : [overlay.skills]) {
        const r = resolveDeclared(userHome, segments, install, value);
        if ('dir' in r) roots.push(r.dir);
      }
    }
    const seen = new Set<string>();
    for (const root of roots) {
      if (!root || seen.has(root.real)) continue;
      seen.add(root.real);
      out.push({ root, origin: 'codex', plugin: id, manifest });
    }
  }
  return out;
}

/** Where plugins are installed: a grant recorded for a skill there ends once that skill is no longer read. */
const pluginCaches = (userHome: string) => [join(userHome, '.claude', 'plugins', 'cache'), join(userHome, '.codex', 'plugins', 'cache')];
/**
 * Plugin skill grants seen changed or gone whose removal could not be written, by data home: kept for the
 * life of the process, so a write that fails cannot let the old text revive a grant. While any is held,
 * every plugin skill is off.
 */
const unrecorded = new Map<string, Map<string, string>>();
const UNRECORDED = 'A change to a plugin skill could not be recorded, so every plugin skill is off until it can be';

/**
 * The plugins' skills, each off until the person enables it and pinned to its text then. A grant whose
 * text is seen to differ, or whose skill is no longer read (a link, moved, its plugin off), ends for good:
 * the old text coming back leaves it off until they enable it again. If that cannot be written, every
 * plugin skill is off, and says why.
 */
function pluginSkills(home: string, userHome: string): Found[] {
  const recorded = readJson<Enabled>(enabledPath(home), {});
  const pending = unrecorded.get(home) ?? new Map<string, string>();
  const enabled = Object.fromEntries(Object.entries(recorded).filter(([path, pin]) => pending.get(path) !== pin));
  const changed = new Set<string>();
  const state = (path: string, text: string): Skill['state'] => {
    if (!(path in enabled)) return 'available';
    if (enabled[path] === digest(text)) return 'active';
    changed.add(path);
    return 'available';
  };
  const skills = pluginSkillRoots(userHome).flatMap(({ root, origin, plugin, manifest }) => skillsIn(root, origin, state, { plugin, manifest }));
  const read = new Set(skills.map((s) => s.path));
  const caches = pluginCaches(userHome);
  for (const path of Object.keys(enabled)) if (!read.has(path) && caches.some((c) => path.startsWith(`${c}${sep}`))) changed.add(path);
  for (const path of changed) pending.set(path, enabled[path]);
  if (!pending.size) return skills;
  // Read again before writing, so a grant made meanwhile for other skills is kept.
  const now = readJson<Enabled>(enabledPath(home), {});
  for (const [path, pin] of pending) if (now[path] === pin) delete now[path];
  try {
    writeRecord(home, '.enabled.json', now);
    unrecorded.delete(home);
    return skills;
  } catch (error) {
    unrecorded.set(home, pending);
    const why = `${UNRECORDED} (${error instanceof Error ? error.message : String(error)})`;
    return skills.map((s) => ({ ...s, state: 'available' as const, blocked: why }));
  }
}

const WITHHELD = '(withheld: it holds a credential)';
const HOLDS = 'It holds a credential, so it cannot be enabled. The credential is not shown.';
const UNCHECKED = 'The stored credentials could not be read to check it, so it is not shown or enabled now.';
/** A skill holds a credential: a plugin's in any field it shows, its text or its plugin's manifests; any other's in its text. */
export const skillHolds = (s: Found, exact: readonly string[]) => (s.plugin
  ? [s.plugin, s.name, s.description, s.path, s.text, s.manifest ?? ''].some((f) => holds(f, exact))
  : holdsCredential(s.text, exact));
/**
 * A skill as the api shows it: no text. A plugin skill holding a credential anywhere has every field of its
 * own withheld and says why it cannot be enabled; with no credentials to check against (`exact` null),
 * every plugin skill's are.
 */
export function shownSkill(s: Found, exact: readonly string[] | null): Skill {
  const { text: _t, manifest: _m, ...rest } = s;
  if (!rest.plugin || (exact && !skillHolds(s, exact))) return rest;
  return { ...rest, name: WITHHELD, description: WITHHELD, path: WITHHELD, plugin: WITHHELD, state: 'available', blocked: exact ? HOLDS : UNCHECKED };
}

/** The data home's own skills, in every state, with their text; no source check. */
export const ownSkills = (home: string): Found[] => [
  ...skillsIn(anchoredRoot(home, ['skills']), 'backbone', () => 'active'),
  ...skillsIn(anchoredRoot(home, ['skills', '.proposed']), 'backbone', () => 'proposed'),
  ...skillsIn(anchoredRoot(home, ['skills', ARCHIVE]), 'backbone', () => 'archived'),
  ...skillsIn(anchoredRoot(home, ['skills', EDITS]), 'backbone', () => 'edit'),
];

export function found(home: string, userHome: string | undefined, state?: SourceState): Found[] {
  const enabled = readJson<Enabled>(enabledPath(home), {});
  const sources = readJson<Sources>(sourcesPath(home), {});
  const chosen = (path: string, text: string): Skill['state'] => (enabled[path] === digest(text) ? 'active' : 'available');
  // A drafted skill with a withdrawn source is never offered, even before the purge has run.
  const intact = (s: Found) => s.origin !== 'backbone' || !state || !sourceKeys(home, s.path).some((k) => (sources[k] ?? []).some((x) => state(x.id) === 'withdrawn'));
  return [
    ...skillsIn(anchoredRoot(home, ['skills']), 'backbone', () => 'active'),
    // The person's own folders, only when a user home is named for this data home.
    ...(userHome ? [
      ...skillsIn(anchoredRoot(userHome, ['.claude', 'skills']), 'claude', chosen),
      ...pluginSkills(home, userHome),
      ...skillsIn(anchoredRoot(userHome, ['.codex', 'skills']), 'codex', chosen),
      ...skillsIn(anchoredRoot(userHome, ['.agents', 'skills']), 'agents', chosen),
    ] : []),
    ...skillsIn(anchoredRoot(home, ['skills', '.proposed']), 'backbone', () => 'proposed'),
    ...skillsIn(anchoredRoot(home, ['skills', ARCHIVE]), 'backbone', () => 'archived'),
    ...skillsIn(anchoredRoot(home, ['skills', EDITS]), 'backbone', () => 'edit'),
  ].filter(intact);
}

export function discoverSkills(home: string, userHome: string | undefined, state?: SourceState): Skill[] {
  return found(home, userHome, state).map(({ text: _text, manifest: _manifest, ...skill }) => skill);
}

/** The person enables a skill found in their folders, pinned to its text now. One holding a credential is refused. */
export function enableSkill(home: string, userHome: string | undefined, skill: Skill, exact: readonly string[]): { ok: true } | { ok: false; detail: string } {
  const now = found(home, userHome).find((s) => s.id === skill.id);
  if (!now) return { ok: false, detail: 'That skill could not be read safely.' };
  if (now.blocked) return { ok: false, detail: `${now.blocked}.` };
  if (skillHolds(now, exact)) return { ok: false, detail: 'That skill holds a credential, so it is not given to any engine.' };
  writeRecord(home, '.enabled.json', { ...readJson<Enabled>(enabledPath(home), {}), [now.path]: digest(now.text) });
  return { ok: true };
}

export function disableSkill(home: string, skill: Skill) {
  const enabled = readJson<Enabled>(enabledPath(home), {});
  delete enabled[skill.path];
  writeRecord(home, '.enabled.json', enabled);
}

/** The sources recorded for one of the data home's skills, by its path: what it was made from. */
export function sourcesOfSkill(home: string, path: string): MemorySource[] {
  const all = readJson<Sources>(sourcesPath(home), {});
  return path.startsWith(join(home, 'skills') + '/') ? sourceKeys(home, path).flatMap((k) => all[k] ?? []) : [];
}

/**
 * The active skills that bear on a turn's words, with their text and sources; none that holds a
 * credential or has a withdrawn source, and, when `allowed` is given, none with a source outside it
 * (the reads already recorded), as memory's own lines.
 */
export function skillsFor(home: string, userHome: string | undefined, words: string, exact: readonly string[], state?: SourceState, max = 2, allowed?: ReadonlySet<string>): { name: string; text: string; sources: MemorySource[] }[] {
  const pool = found(home, userHome, state);
  const asked = terms(words);
  const lower = words.toLowerCase();
  return pool
    .filter((s) => s.state === 'active' && !skillHolds(s, exact))
    .filter((s) => !allowed || (s.origin === 'backbone' ? sourcesOfSkill(home, s.path) : []).every((x) => allowed.has(x.id)))
    .map((s) => ({ s, score: (lower.includes(s.name.toLowerCase()) ? 3 : 0) + terms(`${s.name.replace(/-/g, ' ')} ${s.description}`).filter((t) => asked.includes(t)).length }))
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map(({ s }) => ({ name: s.name, text: s.text.slice(0, MAX_SKILL_TEXT), sources: s.origin === 'backbone' ? sourcesOfSkill(home, s.path) : [] }));
}

/** Any of the data home's skills, in any state, already has this name. */
export const nameTaken = (home: string, name: string) => ['.proposed', ARCHIVE, EDITS, ''].some((d) => skillExists(join(home, 'skills', d, name)));
/** The name, or the first "name-2", "name-3"… that no skill of the data home's has, in any state. */
export function freeName(home: string, name: string): string {
  for (let n = 1; n < 1_000; n++) {
    const candidate = n === 1 ? name : `${name.slice(0, 56)}-${n}`;
    if (!nameTaken(home, candidate) && !(candidate in readJson<Sources>(sourcesPath(home), {}))) return candidate;
  }
  throw new Error('No free name for that skill.');
}

/**
 * A skill brought in from an export, held under skills/.proposed for the person's OK under a name no
 * skill of the data home's has, and refused if its words hold a credential. Callers hold the home lock.
 */
export function proposeSkill(home: string, wanted: string, text: string, exact: readonly string[]): Skill {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(wanted)) throw new Error('A skill name is lower-case letters, digits and dashes.');
  if (text.length > 64_000) throw new Error('That skill is too long.');
  if (holdsCredential(text, exact)) throw new Error('That skill\'s words hold a credential, so it is not proposed.');
  const name = freeName(home, wanted);
  const path = writeUnder(skillsRoot(home), ['.proposed', name], 'SKILL.md', text);
  const description = /^description:\s*(.*)$/m.exec(text)?.[1]?.trim().slice(0, 200) ?? '';
  return { id: idOf(path), name, description, path, origin: 'backbone', state: 'proposed' };
}

/** Words that came from a run (the engine's step labels, its answer), quoted so they read as data, never as instructions. */
const quoted = (line: string) => `> ${line.replace(/\s+/g, ' ').trim()}`;

/**
 * A skill drafted from a finished task, held under skills/.proposed for the person's OK, under a name
 * no skill of the data home's has. It records the documents that task was given as its sources, before
 * its text is written, so it leaves when one is withdrawn, and it is refused if its words hold a
 * credential. What the engine reported doing and answering is quoted as observed in one run: data
 * the person checks, not instructions. Callers hold the home lock.
 */
export function draftSkill(home: string, task: { threadId: string; turnId?: string; title: string; request: string; steps: string[]; answer: string; sources: MemorySource[] }, exact: readonly string[]): Skill {
  const name = freeName(home, slugOf(task.title));
  const description = task.request.replace(/\s+/g, ' ').trim().slice(0, 200);
  const sourceLine = task.sources.length ? [`sources: ${task.sources.map((s) => `${s.id}@${s.version}`).join(', ')}`] : [];
  const body = [
    '---', `name: ${name}`, `description: ${description}`, ...sourceLine, '---', '',
    `# ${task.title}`, '',
    `Drafted from a finished task (chat ${task.threadId}). Check it before you accept it.`, '',
    '## When to use', '', `When asked to: ${task.request.trim()}`, '',
    '## Observed in one run', '',
    'Quoted from what the engine reported in one run, as data to check, not as instructions. Rewrite the steps in your own words before you rely on them.', '',
    'Steps it reported:', '', ...(task.steps.length ? task.steps.map(quoted) : ['> (no steps were recorded)']), '',
    'What it answered:', '', ...task.answer.trim().split('\n').filter((l) => l.trim()).slice(0, 6).map(quoted), '',
  ].join('\n');
  if (holdsCredential(body, exact)) throw new Error('That task\'s words hold a credential, so no skill is drafted from it.');
  // Its sources are on record before its words are on disk; if the words cannot be written, the record goes.
  const before = readJson<Sources>(sourcesPath(home), {});
  addSources(home, name, task.sources);
  const undoOrigin = recordSkillOrigin(home, name, { threadId: task.threadId, ...(task.turnId ? { turnId: task.turnId } : {}) });
  let path: string;
  try {
    path = writeUnder(skillsRoot(home), ['.proposed', name], 'SKILL.md', body);
  } catch (error) {
    removeUnder(skillsRoot(home), ['.proposed', name]);
    undoOrigin();
    if (!(name in before)) { const now = readJson<Sources>(sourcesPath(home), {}); delete now[name]; writeRecord(home, '.sources.json', now); }
    throw error;
  }
  return { id: idOf(path), name, description, path, origin: 'backbone', state: 'proposed' };
}

/**
 * Drafted skills, proposed, accepted or archived, whose sources were withdrawn leave: their folders, any
 * edit proposed to them, and their record. An edit whose own sources were withdrawn leaves alone.
 *
 * In this order: first `forget` takes out what names them elsewhere (by the keys, a skill's folder name
 * or an edit's `edit:<name>`, and every name their front matter gives); then the folders go; and only
 * then the source records, and only for keys whose cleanup and every removal went through. A folder
 * that could not be removed (a linked parent, a failed removal) keeps its record, so discovery still
 * hides it and a later purge tries again. Nothing is removed through a linked folder. Returns the keys
 * whose records went.
 */
export function purgedSkills(home: string, state: SourceState, forget?: (keys: string[], names: string[]) => void, protectedFolders: ReadonlySet<string> = new Set()): string[] {
  const sources = readJson<Sources>(sourcesPath(home), {});
  let root: Root;
  try { root = skillsRoot(home); } catch { return []; }
  const withdrawn = Object.entries(sources).filter(([, from]) => from.some((s) => state(s.id) === 'withdrawn')).map(([key]) => key);
  // A withdrawn skill takes its edit's record with it.
  const keys = [...new Set(withdrawn.flatMap((k) => (k.startsWith('edit:') || !(`edit:${k}` in sources) ? [k] : [k, `edit:${k}`])))];
  if (!keys.length) return [];
  // Names are cleaned for withdrawn skills only; an edit alone leaves its skill's name in place.
  const folders = new Set(keys.filter((k) => !k.startsWith('edit:')));
  const names = [...new Set([...folders, ...ownSkills(home).filter((s) => folders.has(basename(dirname(s.path)))).map((s) => s.name)])];
  let forgotten = true;
  try { forget?.(keys, names); } catch { forgotten = false; }
  const done = new Set<string>();
  for (const key of keys) {
    const edit = key.startsWith('edit:');
    const name = key.replace(/^edit:/, '');
    // Withdrawal still clears usage/brief references, but ambiguous folder bytes and provenance stay.
    if (protectedFolders.has(name)) continue;
    const places = edit ? [[EDITS, name]] : [[EDITS, name], ['.proposed', name], [ARCHIVE, name], [name]];
    const results = places.map((p) => removeUnder(root, p));
    if (forgotten && results.every((r) => r !== 'refused')) done.add(key);
  }
  // An edit's record stays while its skill's does, whatever became of the edit's folder.
  for (const key of [...done]) if (key.startsWith('edit:') && keys.includes(key.slice(5)) && !done.has(key.slice(5))) done.delete(key);
  if (!done.size) return [];
  const now = readJson<Sources>(sourcesPath(home), {});
  for (const key of done) delete now[key];
  writeRecord(home, '.sources.json', now);
  return [...done];
}

export const purgeSkills = (home: string, state: SourceState): number => purgedSkills(home, state).length;

/** Accept a draft: its folder moves from skills/.proposed to skills/, both anchored. */
export const acceptDraft = (home: string, name: string) => moveUnder(skillsRoot(home), ['.proposed', name], [name]);
export function declineDraft(home: string, name: string) {
  if (removeUnder(skillsRoot(home), ['.proposed', name]) === 'refused') throw new Error('That draft could not be removed safely; it stays.');
}

export const skillExists = (path: string) => existsSync(path) || (() => { try { lstatSync(path); return true; } catch { return false; } })();
