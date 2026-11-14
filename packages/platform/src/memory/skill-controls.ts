// Person-owned skill revisions. History is durable before a replacement or archival move, so an
// interruption loses neither text. Hash checks preserve subsequent edits made in any editor.
import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { MemorySource, Skill } from '../api.ts';
import type { SkillChange } from '../api-memory.ts';
import { assertHomeWriteAdmission } from '../composition/home-lock.ts';
import { addSources, ARCHIVE, digest, found, frontMatter, skillHolds, sourcesOfSkill, skillExists, writeRecord, type Found } from './imports.ts';
import { holdsCredential } from './learn.ts';
import { anchoredRoot, moveUnder, readInside, removeUnder, skillsRoot, writeUnder } from './safe-read.ts';
import type { SourceState } from './store.ts';

type SourceTurn = { threadId: string; turnId?: string };
type History = SkillChange & { folder: string; before: string; after: string; sources: MemorySource[] };
const HISTORY = '.history.json';
const ORIGINS = '.origins.json';
const MAX_HISTORY = 50;
const read = <T>(home: string, file: string, fallback: T): T => {
  const root = anchoredRoot(home, ['skills']);
  if (!root) return fallback;
  const text = readInside(root, join(root.path, file), 16 * 1024 * 1024);
  if (text === null) {
    if (skillExists(join(root.path, file))) throw new SkillControlError('INVALID', 'The skill recovery record could not be read safely; it was left unchanged.');
    return fallback;
  }
  try {
    const value = JSON.parse(text);
    const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
    const valid = file === HISTORY ? Array.isArray(value) && value.every(r => object(r) && typeof r.id === 'string' && typeof r.name === 'string' && typeof r.folder === 'string'
      && !r.folder.includes('/') && !r.folder.startsWith('.') && typeof r.at === 'string' && ['edit', 'remove'].includes(String(r.op)) && typeof r.before === 'string' && typeof r.after === 'string'
      && Array.isArray(r.sources) && r.sources.every(s => object(s) && typeof s.id === 'string' && typeof s.name === 'string' && typeof s.version === 'number'))
      : object(value) && Object.values(value).every(v => Array.isArray(v) && v.every(s => object(s) && typeof s.threadId === 'string' && (s.turnId === undefined || typeof s.turnId === 'string')));
    if (!valid) throw new Error('shape');
    return value as T;
  } catch { throw new SkillControlError('INVALID', 'The skill recovery record needs repair before it can be changed.'); }
};
const write = (home: string, file: string, value: unknown) => { assertHomeWriteAdmission(home, join(home, 'skills')); writeRecord(home, file, value); };
const history = (home: string) => read<History[]>(home, HISTORY, []);
const alive = (r: History, state: SourceState) => !r.sources.some(s => state(s.id) === 'withdrawn');
const clean = (r: History, values: readonly string[]) => ![r.name, r.before, r.folder, ...r.sources.flatMap(s => [s.id, s.name])].some(text => holdsCredential(text, values));
const folderOf = (s: Skill) => basename(dirname(s.path));

export class SkillControlError extends Error {
  reason: 'INVALID' | 'NOT_FOUND' | 'STALE_BASE';
  constructor(reason: SkillControlError['reason'], detail: string) { super(detail); this.reason = reason; }
}

/** Provenance is kept separately from editable Markdown, so editing cannot remove the source link. */
export function recordSkillOrigin(home: string, folder: string, origin: SourceTurn) {
  const origins = read<Record<string, SourceTurn[]>>(home, ORIGINS, {});
  write(home, ORIGINS, { ...origins, [folder]: [...(origins[folder] ?? []), origin] });
  return () => {
    const current = read<Record<string, SourceTurn[]>>(home, ORIGINS, {});
    if (folder in origins) current[folder] = origins[folder]; else delete current[folder];
    write(home, ORIGINS, current);
  };
}

/** Only safe data-home skills expose editable words and a compare-and-save revision. */
export function controlledSkill(home: string, skill: Skill, values: readonly string[] | null, pool?: Found[], origins?: Record<string, SourceTurn[]>): Skill {
  if (skill.origin !== 'backbone') return skill;
  if (!values) return { ...skill, body: undefined, edit: undefined, revision: undefined, sourceTurns: undefined };
  const current = (pool ?? found(home, undefined)).find(s => s.id === skill.id);
  if (!current || skillHolds(current, values)) return { ...skill, name: '(withheld)', description: '', body: undefined, edit: undefined, revision: undefined, sourceTurns: undefined, blocked: 'Its words hold a credential and cannot be shown or edited.' };
  const sourceTurns = (origins ?? read<Record<string, SourceTurn[]>>(home, ORIGINS, {}))[folderOf(current)] ?? [];
  return { ...skill, body: current.text, revision: digest(current.text), sourceTurns };
}

/** An accepted edit's earlier text and dependencies are saved before the active file changes. */
export function recordSkillEdit(home: string, skill: Found, next: string, more: MemorySource[] = []) {
  const sources = [...sourcesOfSkill(home, skill.path), ...more];
  const prior = history(home);
  // A retry after staging but before replacing reuses its undo instead of growing duplicate records.
  if (prior.some(r => r.folder === folderOf(skill) && r.op === 'edit' && r.before === skill.text && r.after === digest(next))) return;
  write(home, HISTORY, [...prior, { id: randomUUID(), name: skill.name, folder: folderOf(skill), at: new Date().toISOString(), op: 'edit', before: skill.text, after: digest(next), sources }].slice(-MAX_HISTORY));
}

export function putSkill(home: string, state: SourceState, values: readonly string[], a: { id: string; base: string; text: string }): Skill {
  const skill = own(home, state, a.id, a.base);
  if (!a.text.trim() || a.text.length > 64_000) throw new SkillControlError('INVALID', 'Keep the skill between 1 and 64,000 characters.');
  if (holdsCredential(a.text, values) || skillHolds(skill, values)) throw new SkillControlError('INVALID', 'A credential cannot be saved in a skill or its undo.');
  const meta = frontMatter(a.text);
  if (meta.name !== skill.name || !meta.description?.trim()) throw new SkillControlError('INVALID', 'Keep the skill name and a description in its front matter.');
  const folder = folderOf(skill);
  if (skill.state === 'active' && a.text !== skill.text) recordSkillEdit(home, skill, a.text);
  // Staging is durable I/O: recheck what an outside editor may have changed during it.
  own(home, state, a.id, a.base);
  assertHomeWriteAdmission(home, dirname(skill.path));
  writeUnder(skillsRoot(home), skill.state === 'active' ? [folder] : ['.proposed', folder], 'SKILL.md', a.text);
  const updated = found(home, undefined, state).find(s => s.id === a.id)!;
  const { text: _text, ...shown } = updated;
  return controlledSkill(home, shown, values);
}

function own(home: string, state: SourceState, id: string, base: string): Found {
  const skill = found(home, undefined, state).find(s => s.id === id && (s.state === 'active' || s.state === 'proposed'));
  if (!skill) throw new SkillControlError('NOT_FOUND', 'That editable skill is gone.');
  if (digest(skill.text) !== base) throw new SkillControlError('STALE_BASE', 'The skill changed since you opened it. Your edit is kept; reopen the current text before saving.');
  return skill;
}

/** Removal uses the existing archive: no bundle files are deleted, and undo restores that folder. */
export function removeSkill(home: string, state: SourceState, values: readonly string[], a: { id: string; base: string }) {
  const skill = own(home, state, a.id, a.base);
  if (skill.state !== 'active') throw new SkillControlError('INVALID', 'Decline a draft or remove an accepted skill.');
  if (skillHolds(skill, values)) throw new SkillControlError('INVALID', 'A skill holding a credential cannot be copied into undo.');
  const folder = folderOf(skill), prior = history(home);
  if (!prior.some(r => r.folder === folder && r.op === 'remove' && r.after === digest(skill.text))) {
    write(home, HISTORY, [...prior, { id: randomUUID(), name: skill.name, folder, at: new Date().toISOString(), op: 'remove', before: skill.text, after: digest(skill.text), sources: sourcesOfSkill(home, skill.path) }].slice(-MAX_HISTORY));
  }
  own(home, state, a.id, a.base);
  assertHomeWriteAdmission(home, dirname(skill.path));
  moveUnder(skillsRoot(home), [folder], [ARCHIVE, folder]);
}

export function skillChanges(home: string, state: SourceState, values: readonly string[] | null, pool?: Found[]): SkillChange[] {
  if (!values) return [];
  const all = pool ?? found(home, undefined, state);
  return history(home).filter(r => alive(r, state) && clean(r, values) && all.some(s => s.path === join(home, 'skills', ...(r.op === 'remove' ? [ARCHIVE] : []), r.folder, 'SKILL.md') && digest(s.text) === r.after)).map(({ id, name, at, op }) => ({ id, name, at, op }));
}

export function undoSkill(home: string, state: SourceState, values: readonly string[], id: string, onRestored?: (name: string) => void) {
  const all = history(home), change = all.find(r => r.id === id && alive(r, state));
  if (!change) throw new SkillControlError('NOT_FOUND', 'That skill change is gone or its source was withdrawn.');
  if (!clean(change, values)) throw new SkillControlError('INVALID', 'The earlier skill holds a credential now and cannot be restored.');
  const path = join(home, 'skills', ...(change.op === 'remove' ? [ARCHIVE] : []), change.folder, 'SKILL.md');
  const current = found(home, undefined, state).find(s => s.path === path);
  const restored = found(home, undefined, state).find(s => s.path === join(home, 'skills', change.folder, 'SKILL.md'));
  // A retry after restoring but before clearing history acknowledges exactly that restored text.
  if (current && digest(current.text) === change.after) {
    if (skillHolds(current, values)) throw new SkillControlError('INVALID', 'The current skill holds a credential and cannot be restored.');
    assertHomeWriteAdmission(home, dirname(path));
    if (change.op === 'remove') {
      if (restored) throw new SkillControlError('STALE_BASE', 'Another skill occupies that folder; it was left unchanged.');
      moveUnder(skillsRoot(home), [ARCHIVE, change.folder], [change.folder]);
    } else {
      // Keep all dependencies, including those introduced by the edited version, on the restored skill.
      addSources(home, change.folder, change.sources);
      const fresh = found(home, undefined, state).find(s => s.path === path);
      if (!fresh || digest(fresh.text) !== change.after) throw new SkillControlError('STALE_BASE', 'The skill changed while undo was prepared; your edit was left unchanged.');
      assertHomeWriteAdmission(home, dirname(path));
      writeUnder(skillsRoot(home), [change.folder], 'SKILL.md', change.before);
    }
  } else if (!restored || restored.text !== change.before) {
    throw new SkillControlError('STALE_BASE', 'The skill changed since this action. Your later edit was left unchanged.');
  }
  // Reuse Restore's unused-time grace before dropping recovery, including on an interrupted retry.
  if (change.op === 'remove') onRestored?.(change.name);
  write(home, HISTORY, all.filter(r => r.id !== id));
}

/** A damaged optional record cannot make the Memory page or unrelated skills unavailable. */
export function skillControlsView(home: string, state: SourceState, values: readonly string[] | null, visible: Skill[]) {
  let damaged = false;
  const observe = <T>(fn: () => T, fallback: T): T => {
    try { return fn(); } catch { damaged = true; return fallback; }
  };
  const origins = observe(() => read<Record<string, SourceTurn[]>>(home, ORIGINS, {}), {});
  const pool = found(home, undefined, state);
  return { skills: visible.map(s => controlledSkill(home, s, values, pool, origins)),
    skillChanges: observe(() => skillChanges(home, state, values, pool), []),
    ...(damaged ? { skillNotice: 'Some skill recovery records or source links could not be read. Other memory and skills remain available; damaged records need repair before they can be changed.' } : {}) };
}

/** Withdrawal outranks recovery: unreadable snapshot records cannot hold back removable skill folders. */
export function purgeSkillHistory(home: string, state: SourceState, folders: string[] = []) {
  let pending = false;
  const disposableRead = <T>(file: string, fallback: T): T => {
    try { return read<T>(home, file, fallback); } catch {
      const root = anchoredRoot(home, ['skills']);
      if (!root) { pending = true; return fallback; }
      // Remove the record or terminal link, never an unexpected directory or a link target.
      try {
        if (lstatSync(join(root.path, file)).isDirectory()) { pending = true; return fallback; }
        assertHomeWriteAdmission(home, root.path);
        if (removeUnder(root, [file]) === 'refused') pending = true;
      } catch { pending = true; }
      return fallback;
    }
  };
  const all = disposableRead<History[]>(HISTORY, []), kept = all.filter(r => alive(r, state) && !folders.includes(r.folder));
  try { if (kept.length !== all.length) write(home, HISTORY, kept); } catch { pending = true; }
  if (folders.length) {
    const origins = disposableRead<Record<string, SourceTurn[]>>(ORIGINS, {});
    for (const folder of folders) delete origins[folder];
    // A failed cleanup is reported after the independent folder purge, never ahead of it.
    try { if (skillExists(join(home, 'skills', ORIGINS))) write(home, ORIGINS, origins); } catch { pending = true; }
  }
  return { pending };
}
