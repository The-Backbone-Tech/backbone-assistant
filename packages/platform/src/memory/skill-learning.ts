// Skills that learn from use, on the files the person can open (docs/contracts/skills.md). Nothing here
// makes a skill active: a draft from a complex finished turn waits under skills/.proposed, and an edit
// proposed from the person's correction waits under skills/.edits with its diff, both for the
// person's OK. The curator deletes nothing: it moves the data home's own skills unused for 30 days to
// skills/.archive, where they stay restorable, and it only proposes merges. Every text is checked for
// a credential before it is written, and records its sources, so it leaves when one is withdrawn.
//
//   skills/.usage.json      by skill name: how often it was offered to a turn and used, and when
//   skills/.learning.json   the person's on/off setting, the day each project last drafted, the
//                           proposed and declined merges, the brief notes naming each skill, and
//                           the curator's last pass
// Every write and move goes through the anchored writers in safe-read.ts, inside skills/ only; a
// withdrawal's purge takes a skill's name out of all of these records and the brief.
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { MemorySource, Skill, SkillLearning, SkillMerge, Turn } from '../api.ts';
import { readJson } from '../stub/fsx.ts';
import { addSources, ARCHIVE, EDITS, found, ownSkills, shownSkill, skillExists, sourcesPath, writeRecord, type Found, type Sources } from './imports.ts';
import { holdsCredential } from './learn.ts';
import { moveUnder, removeUnder, skillsRoot, writeUnder } from './safe-read.ts';
import { terms, type SourceState } from './store.ts';
import { assertHomeWriteAdmission } from '../composition/home-lock.ts';
import { recordSkillEdit } from './skill-controls.ts';

/** A skill not offered to a turn and used, accepted or restored for this long is archived. */
export const UNUSED_MS = 30 * 24 * 60 * 60 * 1000;
/** Several tool steps: a turn with fewer is not complex enough to learn a procedure from. */
const MIN_STEPS = 3;
/** Near-duplicates share at least this many words, and this share of all their words. */
const MERGE_WORDS = 3;
const MERGE_SHARE = 0.6;

interface Usage { offered: number; used: number; lastOffered?: string; lastUsed?: string; /** Accepted or restored: unused time counts from here. */ since?: string }
interface Learning {
  auto: boolean;
  /** The local day each project last had a skill drafted on its own. */
  drafted: Record<string, string>;
  merges: SkillMerge[];
  /** Pairs the person declined, by merge id: never proposed again. */
  declined: string[];
  curatedAt: string | null;
  /** The local day the daily curator last ran. */
  curatedOn: string | null;
  /** Each brief note held for the person, by its key, with the skills (or `edit:<name>`) it names. */
  notes: { key: string; names: string[] }[];
}
/** What an edit was made against: it is accepted only onto that text. */
type Bases = Record<string, string>;

const usagePath = (home: string) => join(home, 'skills', '.usage.json');
const learningPath = (home: string) => join(home, 'skills', '.learning.json');
const basesPath = (home: string) => join(home, 'skills', '.edits.json');
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const pad = (n: number) => String(n).padStart(2, '0');
export const localDay = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

export function readLearning(home: string): Learning {
  return { auto: true, drafted: {}, merges: [], declined: [], curatedAt: null, curatedOn: null, notes: [], ...readJson<Partial<Learning>>(learningPath(home), {}) };
}
const writeLearning = (home: string, l: Learning) => writeRecord(home, '.learning.json', l);
/** Remember which skills a brief note names, so a withdrawal can take the note away with them. */
export function noted(home: string, key: string, names: string[]) {
  const l = readLearning(home);
  writeLearning(home, { ...l, notes: [...l.notes.filter((n) => n.key !== key), { key, names }] });
}
/**
 * The learning record as shown. Merge proposals are checked again on the way out: none naming words that
 * hold a credential, and none naming a skill that is not there intact (gone, or with a withdrawn source).
 * With no credentials to check against (`exact` null) no merge is shown.
 */
export function learningView(home: string, userHome: string | undefined, state: SourceState, exact: readonly string[] | null): SkillLearning {
  const l = readLearning(home);
  const present = new Set(exact ? found(home, userHome, state).filter((s) => s.state === 'active').map((s) => s.name) : []);
  const merges = exact ? l.merges.filter((m) => m.names.every((n) => present.has(n)) && ![...m.names, ...m.shared].some((t) => holdsCredential(t, exact))) : [];
  return { auto: l.auto, merges, curatedAt: l.curatedAt };
}
export function setAuto(home: string, auto: boolean) {
  writeLearning(home, { ...readLearning(home), auto });
}

/**
 * A turn complex enough to draft a skill from: it finished, took several tool steps, wrote at least one
 * document, and nothing in it failed, was refused, or came out UNKNOWN.
 */
export function complexTurn(turn: Turn): boolean {
  const steps = turn.work.steps.filter((s) => s.kind !== 'note').length;
  return turn.status === 'done' && !turn.failure && !turn.refusal && !turn.withheld && !turn.unknownSources
    && steps >= MIN_STEPS
    && turn.effects.some((e) => e.kind === 'write-working-copy' && e.outcome === 'DONE')
    && turn.effects.every((e) => e.outcome === 'DONE');
}

/** Whether a project may still have a skill drafted on its own today, and the person has not turned it off. */
export function mayDraft(home: string, projectId: string, now: number): boolean {
  const l = readLearning(home);
  return l.auto && l.drafted[projectId] !== localDay(now);
}
export function drafted(home: string, projectId: string, now: number) {
  const l = readLearning(home);
  writeLearning(home, { ...l, drafted: { ...l.drafted, [projectId]: localDay(now) } });
}
/**
 * Whether a turn shows it used a skill, not merely that it was offered: its finished steps or its answer
 * name the skill (as written, or with its dashes as spaces).
 */
export function usedIn(turn: Turn, name: string): boolean {
  if (turn.status !== 'done' || turn.failure) return false;
  const said = `${turn.work.steps.map((s) => s.label).join('\n')}\n${turn.answer?.text ?? ''}`.toLowerCase();
  const plain = name.toLowerCase().replace(/[-_]+/g, ' ');
  const word = (w: string) => new RegExp(`(^|[^\\p{L}\\p{N}-])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}-])`, 'u').test(said);
  return word(name.toLowerCase()) || (plain !== name.toLowerCase() && word(plain));
}

/**
 * A finished turn was offered these skills; each counts as used only where the turn shows it was (usedIn).
 * A skill of the data home's whose source has been withdrawn since is not recorded at all.
 */
export function recordUsage(home: string, turn: Turn, at: string, state: SourceState) {
  const sources = readJson<Sources>(sourcesPath(home), {});
  const withdrawn = new Set(ownSkills(home).filter((s) => (sources[basename(dirname(s.path))] ?? []).some((x) => state(x.id) === 'withdrawn')).map((s) => s.name));
  const names = (turn.memory?.skills ?? []).filter((n) => !withdrawn.has(n));
  if (!names.length) return;
  const all = readJson<Record<string, Usage>>(usagePath(home), {});
  for (const name of names) {
    const u = all[name] ?? { offered: 0, used: 0 };
    all[name] = { ...u, offered: u.offered + 1, lastOffered: at, ...(usedIn(turn, name) ? { used: u.used + 1, lastUsed: at } : {}) };
  }
  writeRecord(home, '.usage.json', all);
}
function markSince(home: string, name: string, at: string) {
  const all = readJson<Record<string, Usage>>(usagePath(home), {});
  all[name] = { ...(all[name] ?? { offered: 0, used: 0 }), since: at };
  writeRecord(home, '.usage.json', all);
}

/**
 * A withdrawal purged these skills (or edits, as `edit:<name>`): their names leave the usage record,
 * the merge proposals and the brief notes that name them. Returns the keys of the brief notes to drop.
 */
export function forgetPurged(home: string, keys: readonly string[], also: readonly string[] = []): string[] {
  if (!keys.length) return [];
  // The folder names a purge acts on, and every front-matter name those folders' skills give.
  const names = [...new Set([...keys.filter((k) => !k.startsWith('edit:')), ...also])];
  const usage = readJson<Record<string, Usage>>(usagePath(home), {});
  if (names.some((n) => n in usage)) { for (const n of names) delete usage[n]; writeRecord(home, '.usage.json', usage); }
  const l = readLearning(home);
  const notes = l.notes.filter((n) => n.names.some((x) => keys.includes(x) || names.includes(x.replace(/^edit:/, ''))));
  const merges = l.merges.filter((m) => m.names.some((x) => names.includes(x)));
  if (notes.length || merges.length) writeLearning(home, { ...l, notes: l.notes.filter((n) => !notes.includes(n)), merges: l.merges.filter((m) => !merges.includes(m)) });
  return notes.map((n) => n.key);
}

/** A line diff of two texts: the lines both share before and after the change, then what went and came. */
export function lineDiff(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const context = a.slice(Math.max(0, head - 2), head).map((l) => `  ${l}`);
  return [...context, ...a.slice(head, a.length - tail).map((l) => `- ${l}`), ...b.slice(head, b.length - tail).map((l) => `+ ${l}`)].join('\n');
}

const activeOwn = (home: string, userHome: string | undefined, state: SourceState) => found(home, userHome, state).filter((s) => s.origin === 'backbone' && s.state === 'active');

/**
 * The person corrected a turn that used one of the data home's accepted skills: propose the correction
 * as an edit to it, held under skills/.edits for their OK, made against the skill's text now. A second
 * correction before they decide joins the same edit. Refused if the edited text holds a credential.
 */
export function proposeEdit(home: string, userHome: string | undefined, state: SourceState, a: { name: string; corrections: string[]; threadId: string; sources: MemorySource[] }, exact: readonly string[]): Skill | null {
  // Callers hold the home lock, and propose only for a skill the corrected turn shows it used (usedIn).
  const skill = activeOwn(home, userHome, state).find((s) => s.name === a.name);
  if (!skill || a.sources.some((s) => state(s.id) === 'withdrawn')) return null;
  const folder = dirname(skill.path).slice(join(home, 'skills').length + 1);
  if (folder.includes('/')) return null;
  const pending = found(home, userHome, state).find((s) => s.state === 'edit' && s.name === a.name);
  const bases = readJson<Bases>(basesPath(home), {});
  // A pending edit made against a text the person has since changed is dropped, not built upon.
  const onto = pending && bases[folder] === digest(skill.text) ? pending.text : skill.text;
  const added = a.corrections.map((c) => `- ${c} (a correction in chat ${a.threadId})`);
  const text = /\n## Corrections\n/.test(onto)
    ? `${onto.replace(/\n*$/, '')}\n${added.join('\n')}\n`
    : `${onto.replace(/\n*$/, '')}\n\n## Corrections\n\n${added.join('\n')}\n`;
  if (holdsCredential(text, exact)) return null;
  // Its sources are on record before its words are on disk, and only ever added to.
  addSources(home, `edit:${folder}`, a.sources);
  writeRecord(home, '.edits.json', { ...bases, [folder]: digest(skill.text) });
  writeUnder(skillsRoot(home), [EDITS, folder], 'SKILL.md', text);
  return withDiff(home, userHome, state).find((s) => s.state === 'edit' && s.name === a.name) ?? null;
}

/** Every skill, with each proposed edit's diff against the skill it would change. */
export function withDiff(home: string, userHome: string | undefined, state: SourceState, exact: readonly string[] | null = null): Skill[] {
  const all = found(home, userHome, state);
  return all.flatMap((f): Skill[] => {
    // A plugin skill holding a credential shows none of its fields; with `exact` unknown, no plugin skill does.
    const s = shownSkill(f, exact);
    // A draft shows its whole text, so the person reads what they would accept.
    if (s.state === 'proposed') return [{ ...s, body: f.text }];
    if (s.state !== 'edit') return [s];
    const of = all.find((x) => x.origin === 'backbone' && x.state === 'active' && x.name === s.name);
    return of ? [{ ...s, edit: { of: of.name, diff: lineDiff(of.text, f.text) } }] : [];
  });
}

export type Decided = { ok: true; skill: Skill | null } | { ok: false; reason: 'NOT_FOUND' | 'INVALID' | 'STALE_BASE'; detail: string };

/** The person accepts or declines a proposed edit. Accepting writes it onto the skill, only if the skill is still the text it was made against. */
export function decideEdit(home: string, userHome: string | undefined, state: SourceState, edit: Found, verdict: 'accept' | 'decline', exact: readonly string[]): Decided {
  const folder = dirname(edit.path).slice(join(home, 'skills', EDITS).length + 1);
  const drop = () => {
    if (removeUnder(skillsRoot(home), [EDITS, folder]) === 'refused') throw new Error('That edit could not be removed safely; it stays.');
    const bases = readJson<Bases>(basesPath(home), {});
    delete bases[folder];
    writeRecord(home, '.edits.json', bases);
    const sources = readJson<Sources>(sourcesPath(home), {});
    delete sources[`edit:${folder}`];
    writeRecord(home, '.sources.json', sources);
  };
  if (verdict === 'decline') { drop(); return { ok: true, skill: null }; }
  const skill = activeOwn(home, userHome, state).find((s) => s.name === edit.name && dirname(s.path) === join(home, 'skills', folder));
  if (!skill) return { ok: false, reason: 'NOT_FOUND', detail: 'The skill that edit would change is gone.' };
  if (readJson<Bases>(basesPath(home), {})[folder] !== digest(skill.text)) return { ok: false, reason: 'STALE_BASE', detail: `${skill.name} changed since that edit was proposed. Nothing changed.` };
  if (holdsCredential(edit.text, exact)) return { ok: false, reason: 'INVALID', detail: 'That edit holds a credential, so it is not given to any engine.' };
  if (holdsCredential(skill.text, exact)) return { ok: false, reason: 'INVALID', detail: 'The earlier skill holds a credential, so no undo snapshot can be saved.' };
  recordSkillEdit(home, skill, edit.text, readJson<Sources>(sourcesPath(home), {})[`edit:${folder}`] ?? []);
  // The skill will carry the correction, so it takes on what that correction's turns were given first,
  // before its words change; only then does the edit's own record go.
  addSources(home, folder, readJson<Sources>(sourcesPath(home), {})[`edit:${folder}`] ?? []);
  const current = activeOwn(home, userHome, state).find(s => s.path === skill.path);
  if (!current || digest(current.text) !== digest(skill.text)) return { ok: false, reason: 'STALE_BASE', detail: 'The skill changed while the edit was prepared. Your edit was left unchanged.' };
  assertHomeWriteAdmission(home, dirname(skill.path));
  writeUnder(skillsRoot(home), [folder], 'SKILL.md', edit.text);
  drop();
  return { ok: true, skill: withDiff(home, userHome, state).find((s) => s.state === 'active' && s.path === skill.path) ?? null };
}

/** The person restores an archived skill: back where it was, and unused time counts from now. */
export function restoreSkill(home: string, userHome: string | undefined, state: SourceState, skill: Found, now: number): Decided {
  const folder = dirname(skill.path).slice(join(home, 'skills', ARCHIVE).length + 1);
  const to = join(home, 'skills', folder);
  if (skillExists(to)) return { ok: false, reason: 'INVALID', detail: `A skill named ${folder} is already active. Rename or remove it first.` };
  moveUnder(skillsRoot(home), [ARCHIVE, folder], [folder]);
  markSince(home, skill.name, new Date(now).toISOString());
  return { ok: true, skill: withDiff(home, userHome, state).find((s) => s.state === 'active' && s.path === join(to, 'SKILL.md')) ?? null };
}

/** Mark a skill accepted now, so unused time counts from its acceptance. */
export const accepted = (home: string, name: string, now: number) => markSince(home, name, new Date(now).toISOString());

export function declineMerge(home: string, id: string): boolean {
  const l = readLearning(home);
  if (!l.merges.some((m) => m.id === id)) return false;
  writeLearning(home, { ...l, merges: l.merges.filter((m) => m.id !== id), declined: [...new Set([...l.declined, id])] });
  return true;
}

const wordsOf = (s: Skill) => terms(`${s.name.replace(/[-_]/g, ' ')} ${s.description}`);
const mtime = (path: string) => { try { return lstatSync(path).mtimeMs; } catch { return 0; } };

/**
 * One pass of the curator. It archives each of the data home's own active skills not used, accepted or
 * restored in the last 30 days (by its record, else by when its file last changed), unless an edit to it
 * is waiting; and proposes merging any two active skills whose names and descriptions share most of
 * their words. It deletes nothing and merges nothing.
 */
export function curate(home: string, userHome: string | undefined, state: SourceState, now: number, exact: readonly string[], protectedFolders: ReadonlySet<string> = new Set()): { archived: string[]; merges: SkillMerge[]; proposed: SkillMerge[] } {
  const root = skillsRoot(home);
  const usage = readJson<Record<string, Usage>>(usagePath(home), {});
  const all = found(home, userHome, state);
  const archived: string[] = [];
  for (const s of all.filter((x) => x.origin === 'backbone' && x.state === 'active')) {
    const folder = dirname(s.path).slice(join(home, 'skills').length + 1);
    if (protectedFolders.has(folder) || folder.includes('/') || all.some((x) => x.state === 'edit' && x.name === s.name)) continue;
    const u = usage[s.name];
    const last = Math.max(Date.parse(u?.lastUsed ?? '') || 0, Date.parse(u?.since ?? '') || 0, mtime(s.path));
    if (now - last < UNUSED_MS) continue;
    if (skillExists(join(home, 'skills', ARCHIVE, folder))) continue;
    // Only inside skills/, through no link: a linked .archive or skill folder fails closed and moves nothing.
    try { moveUnder(root, [folder], [ARCHIVE, folder]); } catch { continue; }
    archived.push(s.name);
  }
  const l = readLearning(home);
  const active = found(home, userHome, state).filter((x) => x.state === 'active' && !(x.origin === 'backbone' && protectedFolders.has(dirname(x.path).slice(join(home, 'skills').length + 1))));
  const merges: SkillMerge[] = [];
  for (const [i, a] of active.entries()) {
    for (const b of active.slice(i + 1)) {
      const wa = wordsOf(a);
      const wb = wordsOf(b);
      const shared = wa.filter((w) => wb.includes(w));
      const union = new Set([...wa, ...wb]).size;
      if (a.name !== b.name && (shared.length < MERGE_WORDS || shared.length / union < MERGE_SHARE)) continue;
      // Names and words are stored and shown, so neither skill may hold a credential.
      if ([a.name, b.name, a.description, b.description, shared.join(' ')].some((t) => holdsCredential(t, exact))) continue;
      const id = createHash('sha256').update([a.path, b.path].sort().join('\0')).digest('hex').slice(0, 16);
      if (!l.declined.includes(id)) merges.push({ id, names: [a.name, b.name], shared });
    }
  }
  const proposed = merges.filter((m) => !l.merges.some((k) => k.id === m.id));
  writeLearning(home, { ...l, merges, curatedAt: new Date(now).toISOString(), curatedOn: localDay(now) });
  return { archived, merges, proposed };
}

/** Whether the daily curator has run today. */
export const curatedToday = (home: string, now: number) => readLearning(home).curatedOn === localDay(now);

