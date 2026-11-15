// Claude Code subagent Markdown: YAML front matter and an instruction body.
// Only supported fields are accepted; a role can never grant authority or run hooks.
import { basename, join } from 'node:path';
import { lstatSync, opendirSync } from 'node:fs';
import { parseDocument } from 'yaml';
import type { AgentRole, RefusalReason } from '../api.ts';
import { assertHomeWriteAdmission } from '../composition/home-lock.ts';
import { digest, sourcesPath } from './imports.ts';
import { holds } from './plugin-installs.ts';
import { anchoredRoot, plainUnder, readInside, writeUnder, removeUnder, type Root } from './safe-read.ts';

const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_TEXT = 32_000;
export const ROLE_TOOLS = ['Read', 'Glob', 'Write', 'Bash', 'memory_search', 'propose_memory', 'connectors'] as const;
export class AgentRoleError extends Error {
  readonly reason: RefusalReason;
  constructor(reason: RefusalReason, message: string) { super(message); this.reason = reason; }
}
const invalid = () => new AgentRoleError('INVALID', 'Use a named agent with a description, instructions, an optional model and supported tools. No permissions, hooks or other fields are supported.');

export function parseAgentRole(text: string, exact: readonly string[]): AgentRole {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_TEXT || holds(text, exact)) throw invalid();
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) throw invalid();
  const doc = parseDocument(match[1], { uniqueKeys: true });
  if (doc.errors.length) throw invalid();
  let meta;
  try { meta = doc.toJS({ maxAliasCount: 0 }); } catch { throw invalid(); }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta) || Object.keys(meta).some(key => !['name', 'description', 'model', 'tools'].includes(key))) throw invalid();
  if (typeof meta.name !== 'string' || !NAME.test(meta.name) || typeof meta.description !== 'string' || !meta.description.trim() || meta.description.length > 500 || !match[2].trim()) throw invalid();
  if (meta.model !== undefined && (typeof meta.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(meta.model))) throw invalid();
  const tools = typeof meta.tools === 'string' ? meta.tools.split(',').map((s: string) => s.trim()).filter(Boolean) : meta.tools;
  if (tools !== undefined && (!Array.isArray(tools) || tools.some(tool => typeof tool !== 'string' || !(ROLE_TOOLS as readonly string[]).includes(tool)))) throw invalid();
  const role: AgentRole = { name: meta.name, description: meta.description.trim(), model: meta.model ?? 'inherit', ...(tools === undefined ? {} : { tools: [...new Set<string>(tools)] }), instructions: match[2].trim(), markdown: text, digest: digest(text) };
  // YAML escapes and assembled display fields must be checked as well as the source.
  if (Object.values(role).some(value => holds(typeof value === 'string' ? value : JSON.stringify(value), exact))) throw invalid();
  return role;
}

const ROLE_FOLDER = '.agent-roles';
const MAX_FILES = 64;

// Bound traversal and parsing. Matching names that cannot be read safely still require classification.
function roleFiles(root: Root): { paths: string[]; more: boolean } {
  const paths: string[] = [];
  const dir = opendirSync(root.path);
  try {
    for (let i = 0; i < MAX_FILES; i++) {
      const entry = dir.readSync();
      if (!entry) return { paths, more: false };
      if (/^[a-z][a-z0-9-]{0,63}\.md$/.test(entry.name)) paths.push(join(root.path, entry.name));
    }
    return { paths, more: dir.readSync() !== null };
  } finally { dir.closeSync(); }
}
function roleAt(root: Root, path: string, exact: readonly string[], text?: string): AgentRole | null {
  try {
    const role = parseAgentRole(text ?? readInside(root, path, MAX_TEXT, true) ?? '', exact);
    return path === join(root.path, `${role.name}.md`) ? role : null;
  } catch { return null; }
}
function writableRoles(home: string): Root {
  const base = anchoredRoot(home, []);
  if (!base) throw new AgentRoleError('NOT_AVAILABLE', 'The data folder could not be opened safely.');
  assertHomeWriteAdmission(home, home);
  plainUnder(base, [ROLE_FOLDER], true);
  const root = anchoredRoot(home, [ROLE_FOLDER]);
  if (!root) throw new AgentRoleError('NOT_AVAILABLE', 'The roles folder could not be opened safely.');
  return root;
}

const MIGRATED = 'role-migration-v1\n';
function migrationSeen(home: string, name: string): boolean {
  const root = anchoredRoot(home, [ROLE_FOLDER]);
  if (!root) {
    if (lstatSync(join(home, ROLE_FOLDER), { throwIfNoEntry: false })) throw new AgentRoleError('NOT_AVAILABLE', 'The role migration records could not be opened safely.');
    return false;
  }
  if (lstatSync(join(root.path, '.legacy'), { throwIfNoEntry: false }) && !anchoredRoot(home, [ROLE_FOLDER, '.legacy'])) throw new AgentRoleError('NOT_AVAILABLE', 'The role migration records could not be opened safely.');
  const path = join(root.path, '.legacy', `${name}.migrated`);
  const text = readInside(root, path, 64, true);
  if (lstatSync(path, { throwIfNoEntry: false }) && text !== MIGRATED) throw new AgentRoleError('NOT_AVAILABLE', 'A role migration record changed; nothing was replaced.');
  return text === MIGRATED;
}

const OWNED = 'person-role-v1\n';
function ownedVersion(home: string, role: AgentRole): boolean {
  const root = anchoredRoot(home, [ROLE_FOLDER]);
  return !!root && readInside(root, join(root.path, '.legacy', `${role.name}-${role.digest}.owned`), 64, true) === OWNED;
}
function recordOwned(home: string, root: Root, role: AgentRole): void {
  const file = `${role.name}-${role.digest}.owned`, path = join(root.path, '.legacy', file);
  const current = readInside(root, path, 64, true);
  if (lstatSync(path, { throwIfNoEntry: false }) && current !== OWNED) throw new AgentRoleError('NOT_AVAILABLE', 'A role ownership record changed; nothing was replaced.');
  if (current !== OWNED) { assertHomeWriteAdmission(home, root.path); writeUnder(root, ['.legacy'], file, OWNED); }
}
function legacySkill(home: string, legacy: Root): boolean {
  if (lstatSync(join(legacy.path, 'SKILL.md'), { throwIfNoEntry: false })) return true;
  const skills = anchoredRoot(home, ['skills']);
  if (!skills) return true;
  const path = sourcesPath(home), text = readInside(skills, path, 1_000_000, true);
  if (text === null) return !!lstatSync(path, { throwIfNoEntry: false });
  try { const records = JSON.parse(text); return !records || typeof records !== 'object' || Array.isArray(records) || Object.hasOwn(records, 'agents'); }
  catch { return true; }
}

/** Under the home lock. Copy and verify before removing only a validated legacy role file.
 * Different destination content wins; the legacy bytes remain in a deterministic recovery file.
 * A false result protects only skills/agents from destructive maintenance until review. */
export function migrateAgentRoles(home: string, exact: readonly string[] | null = null): boolean {
  const legacy = anchoredRoot(home, ['skills', 'agents']);
  if (!legacy) return true;
  const batch = roleFiles(legacy);
  const hasSkill = legacySkill(home, legacy);
  let classified = true;
  for (const path of batch.paths) {
    const text = readInside(legacy, path, MAX_TEXT, true);
    if (text === null) { classified = false; continue; }
    const role = roleAt(legacy, path, [], text);
    if (!role) {
      // An edited role may no longer parse. Never mistake unreadable bytes or role-shaped
      // front matter for an ordinary skill reference and approve their destruction.
      const header = /^\uFEFF?\s*---[ \t]*\r?\n([\s\S]*?)(?:\r?\n---[ \t]*(?:\r?\n|$)|$)/.exec(text)?.[1];
      if (migrationSeen(home, basename(path, '.md')) || header && /(?:^|[\n{,-])\s*['"]?(?:name|model|tools)['"]?\s*:/i.test(header)) classified = false;
      continue;
    }
    // A shared skill folder does not prove that a parseable file is an independently owned
    // role. Never activate or back up its text outside the skill's provenance automatically.
    if (hasSkill) {
      if (!ownedVersion(home, role)) classified = false;
      else if (!migrationSeen(home, role.name)) {
        const root = writableRoles(home);
        assertHomeWriteAdmission(home, root.path);
        writeUnder(root, ['.legacy'], `${role.name}.migrated`, MIGRATED);
      }
      continue;
    }
    // Structural parsing alone never admits a copy. Check decoded fields with current credentials.
    if (!exact || !roleAt(legacy, path, exact, text)) { classified = false; continue; }
    const seen = migrationSeen(home, role.name);
    const root = writableRoles(home);
    const file = `${role.name}.md`, target = join(root.path, file);
    const recovery = `${role.name}-${role.digest.replace(/^sha256:/, '')}.md`;
    const recoveryPath = join(root.path, '.legacy', recovery);
    const copied = readInside(root, recoveryPath, MAX_TEXT, true) === role.markdown;
    if (lstatSync(recoveryPath, { throwIfNoEntry: false }) && !copied) throw new AgentRoleError('NOT_AVAILABLE', 'A migration recovery file changed; nothing was replaced.');
    const current = readInside(root, target, MAX_TEXT, true);
    const conflict = !!lstatSync(target, { throwIfNoEntry: false }) && current !== role.markdown;
    if (!lstatSync(target, { throwIfNoEntry: false }) && !copied && !seen) {
      assertHomeWriteAdmission(home, root.path);
      writeUnder(root, [], file, role.markdown);
    }
    // Later legacy edits become recovery copies, not replacements for the canonical role.
    if ((conflict || seen) && !copied) {
      assertHomeWriteAdmission(home, root.path);
      writeUnder(root, ['.legacy'], recovery, role.markdown);
    }
    if (readInside(root, target, MAX_TEXT, true) !== role.markdown && readInside(root, recoveryPath, MAX_TEXT, true) !== role.markdown) throw new AgentRoleError('NOT_AVAILABLE', 'The migrated role copy could not be verified.');
    if (readInside(legacy, path, MAX_TEXT, true) !== role.markdown) throw new AgentRoleError('STALE_BASE', 'A role changed during migration; both locations were kept.');
    recordOwned(home, root, role);
    if (!seen) {
      assertHomeWriteAdmission(home, root.path);
      writeUnder(root, ['.legacy'], `${role.name}.migrated`, MIGRATED);
      if (!migrationSeen(home, role.name)) throw new AgentRoleError('NOT_AVAILABLE', 'The role migration record could not be verified.');
    }
    if (!hasSkill) {
      assertHomeWriteAdmission(home, legacy.path);
      if (removeUnder(legacy, [file]) === 'refused') throw new AgentRoleError('NOT_AVAILABLE', 'The legacy role could not be removed safely; its copied definition was kept.');
    }
  }
  return classified && !batch.more;
}

export function readAgentRoleListing(home: string, exact: readonly string[]): { roles: AgentRole[]; truncated: boolean } {
  const root = anchoredRoot(home, [ROLE_FOLDER]);
  if (!root) {
    if (lstatSync(join(home, ROLE_FOLDER), { throwIfNoEntry: false })) throw new AgentRoleError('NOT_AVAILABLE', 'The roles folder could not be opened safely.');
    return { roles: [], truncated: false };
  }
  const batch = roleFiles(root);
  return { roles: batch.paths.flatMap(path => { const role = roleAt(root, path, exact); return role ? [role] : []; }).sort((a, b) => a.name.localeCompare(b.name)), truncated: batch.more };
}

export function readAgentRoles(home: string, exact: readonly string[]): AgentRole[] {
  try { return readAgentRoleListing(home, exact).roles; } catch { return []; }
}

/** Admission reads only the role requested, even when the directory exceeds the listing cap. */
export function readAgentRole(home: string, name: string, exact: readonly string[]): AgentRole | null {
  if (typeof name !== 'string' || !NAME.test(name)) return null;
  const root = anchoredRoot(home, [ROLE_FOLDER]);
  return root ? roleAt(root, join(root.path, `${name}.md`), exact) : null;
}

function checkBase(home: string, name: string, base: string | null) {
  if (typeof name !== 'string' || !NAME.test(name)) throw invalid();
  const root = anchoredRoot(home, [ROLE_FOLDER]);
  if (!root && lstatSync(join(home, ROLE_FOLDER), { throwIfNoEntry: false })) throw new AgentRoleError('NOT_AVAILABLE', 'The roles folder could not be read safely.');
  const current = root ? readInside(root, join(root.path, `${name}.md`), MAX_TEXT, true) : null;
  if (root && current === null && lstatSync(join(root.path, `${name}.md`), { throwIfNoEntry: false })) throw new AgentRoleError('NOT_AVAILABLE', 'The existing role could not be read safely. Nothing was replaced; inspect its file before saving.');
  if ((current === null ? null : digest(current)) !== base) throw new AgentRoleError('STALE_BASE', 'This role changed. Reload it before saving or deleting; your edits were kept.');
}

/** Caller holds the home lock. Compare and synchronous durable write have no wait between them. */
export function saveAgentRole(home: string, name: string, markdown: string, base: string | null, exact: readonly string[]): AgentRole {
  migrateAgentRoles(home, exact);
  const role = parseAgentRole(markdown, exact);
  if (role.name !== name) throw invalid();
  checkBase(home, name, base);
  const root = writableRoles(home);
  assertHomeWriteAdmission(home, root.path);
  writeUnder(root, [], `${name}.md`, markdown);
  recordOwned(home, root, role);
  const legacy = anchoredRoot(home, ['skills', 'agents']);
  if (legacy && readInside(legacy, join(legacy.path, `${name}.md`), MAX_TEXT, true) === markdown && !migrationSeen(home, name)) {
    assertHomeWriteAdmission(home, root.path);
    writeUnder(root, ['.legacy'], `${name}.migrated`, MIGRATED);
  }
  return role;
}

export function deleteAgentRole(home: string, name: string, base: string, exact: readonly string[] | null = null): void {
  migrateAgentRoles(home, exact);
  if (typeof base !== 'string' || !base) throw new AgentRoleError('INVALID', 'Reload this role before deleting it.');
  checkBase(home, name, base);
  const root = anchoredRoot(home, [ROLE_FOLDER]);
  if (!root) throw new AgentRoleError('NOT_FOUND', 'This role is missing. Reload it.');
  assertHomeWriteAdmission(home, root.path);
  if (removeUnder(root, [`${name}.md`]) === 'refused') throw new AgentRoleError('NOT_AVAILABLE', 'This role could not be removed safely.');
}
