// What a withdrawal means for turns: the read set each turn keeps on disk is compared with the record
// of withdrawals, so a turn that had a source counts even if it was restored or the process died.
import type { FileLink, MaterialEntry, Turn } from '../api.ts';
import type { MaterialStore } from '../stub/material.ts';
import { isWithdrawn } from '../stub/material.ts';

/**
 * The one test at every final boundary, delivery and commit alike: the sources this turn read that have
 * been withdrawn since, restored or not. Commits call it inside the home lock, where withdrawals happen.
 */
export function taintedReads(turn: Pick<Turn, 'reads'>, load: (id: string) => MaterialEntry | null) {
  return (turn.reads ?? []).filter((read) => (load(read.id)?.withdrawals?.length ?? 0) > read.withdrawals);
}

/**
 * Whether a turn's sources are not all known, so its words may carry any source of the project. That is
 * a turn with no read set, one marked `unknownSources`, and one recorded before every harness bound its
 * reads at read time: it shows read steps with no direct source identity, and inherited or told context
 * alone cannot account for that activity. A merge's sources are its plan's, checked by taintedReads.
 * Every path that carries a turn's words on (replay, a child's report, a merge, a skill) asks this.
 */
export function unbound(turn: Pick<Turn, 'reads' | 'unknownSources' | 'merge' | 'work'>): boolean {
  if (!turn.reads || turn.unknownSources) return true;
  return !turn.merge && !!turn.work?.steps?.some((step) => step.kind === 'read') && !turn.reads.some((read) => !read.inherited && !read.told);
}

/**
 * The earlier conversation a turn may be given, and what it thereby inherits. An answer may quote what
 * its turn read or was given, so it is left out while any of that is withdrawn. A turn whose sources are
 * not all known may depend on anything: it, and whatever inherits it, stays out once any source has been
 * withdrawn. `only` limits the answers to those an earlier call let through (`answered`), so a check
 * repeated later, as the model input is sent, can only leave more out.
 */
export function replay(turns: Turn[], material: Pick<MaterialStore, 'load' | 'list'>, projectId: string, only?: ReadonlySet<string>) {
  const history: { role: 'user' | 'assistant'; text: string }[] = [];
  const inherited = new Map<string, NonNullable<Turn['reads']>[number]>();
  const answered = new Set<string>();
  const everWithdrawn = () => material.list(projectId, true).some((e) => e.withdrawals?.length);
  const gone = (id: string) => { const e = material.load(id); return !!e && isWithdrawn(e); };
  let unknown = false;
  for (const turn of turns) {
    // An agent's brief is told through the chokepoint, under its own record; it is never history.
    // What the person added while it ran is theirs too, once confirmed. Unconfirmed words are never resent, here either.
    // A peer's words (message_card) are not the person's and are never history; the turn's answer carries their sources.
    const added = (turn.steers ?? []).filter((steer) => steer.state === 'delivered' && !steer.peer).map((steer) => steer.text);
    // Words the host wrote into a turn's text from sources (a goal run's finding) leave with them.
    const textGone = !!turn.textSources && taintedReads({ reads: turn.textSources }, (id) => material.load(id)).length > 0;
    const asked = [...(turn.brief !== 'agent' && !textGone ? [turn.user.text] : []), ...added];
    if (asked.length) history.push({ role: 'user', text: asked.join('\n\n') });
    if (!turn.answer?.text || turn.withheld || (only && !only.has(turn.id))) continue;
    const unknowable = unbound(turn);
    // Judged by source version, direct and told alike: a restore brings no pre-withdrawal words back.
    if ((unknowable && everWithdrawn()) || turn.reads?.some((read) => gone(read.id)) || taintedReads(turn, (id) => material.load(id)).length) continue;
    history.push({ role: 'assistant', text: turn.answer.text });
    answered.add(turn.id);
    unknown ||= unknowable;
    for (const read of turn.reads ?? []) inherited.set(read.told ? `${read.id}\0told\0${read.version}\0${read.withdrawals}` : read.id, { ...read, inherited: true });
  }
  // Anything could have reached it, so every source now here is a dependency, and the one test covers it.
  if (unknown) for (const e of material.list(projectId, true)) inherited.set(e.id, { id: e.id, name: e.name, version: e.current, inherited: true, withdrawals: e.withdrawals?.length ?? 0 });
  return { history, inherited: [...inherited.values()], unknown, answered };
}

type TextSource = NonNullable<Turn['textSources']>[number];
/** Sources by source version, deduplicated: what the host's words in a turn's text came from. */
export const textSourcesOf = (reads: readonly TextSource[]): TextSource[] =>
  [...new Map(reads.map(({ id, name, version, withdrawals }) => [`${id}\0${version}\0${withdrawals}`, { id, name, version, withdrawals }])).values()];

/**
 * Words the host writes into a turn's own text (a goal, a goal check's finding) carry their sources:
 * on the turn, and among its told reads, so the send-time gate and replay judge them as told words.
 * Call it as the turn is admitted, before it is reserved.
 */
export function carryTextSources(turn: Turn, sources: readonly TextSource[]): void {
  if (!sources.length) return;
  turn.textSources = textSourcesOf(sources);
  for (const s of turn.textSources) if (!turn.reads?.some((r) => r.told && r.id === s.id && r.version === s.version && r.withdrawals === s.withdrawals)) (turn.reads ??= []).push({ ...s, inherited: true, told: true });
}

export function withdrawnNote(sources: string[], held: string[]): string {
  return `${[...new Set(sources)].join(', ')} was withdrawn while this turn worked.${held.length ? ` Later work cannot see what this turn made from then on until you decide: ${held.join(', ')}.` : ''}`;
}

/**
 * A turn that died cannot have held its own writes. Of the versions it verifiably landed, a new agent
 * document written after the withdrawal is held now. One it cannot safely hide, or that has moved on
 * since, is put to the person. Call it inside the home lock.
 * A document from before the withdrawal is ordinary earlier work, which `mayCarry` names. Safe to repeat.
 */
export function holdRecovered(turn: Turn, material: MaterialStore, files: FileLink[], hasOpenWork: (entry: MaterialEntry) => boolean): void {
  const tainted = taintedReads(turn, (id) => material.load(id));
  if (!tainted.length) return;
  turn.withheld = true;
  const since = tainted.map((read) => material.load(read.id)!.withdrawals![read.withdrawals]!.at).sort()[0]!;
  const held: string[] = [];
  for (const file of files) {
    const entry = material.load(file.materialId);
    const version = entry?.versions.find((v) => v.n === file.version);
    if (!entry || !version) continue;
    if (entry.held) { held.push(entry.name); continue; }
    if (version.by !== 'agent' || version.at < since) continue;
    const source = { id: tainted[0]!.id, name: tainted[0]!.name };
    if (entry.current === file.version && entry.current === 1 && entry.class === 'working' && !entry.hidden && !hasOpenWork(entry)) {
      material.mark(entry.id, { hidden: true, held: source });
      held.push(entry.name);
    } else if (!entry.unsure) material.mark(entry.id, { hidden: entry.hidden, unsure: source });
  }
  const note = withdrawnNote(tainted.map((read) => read.name), held);
  if (!turn.answer?.text.startsWith(note)) turn.answer = { files: turn.answer?.files ?? [], text: [note, turn.answer?.text].filter(Boolean).join('\n\n') };
}

/** Classification that fails stays on the turn for the next start, and in the view until it succeeds. */
export async function classifyRecovered(turn: Turn, material: MaterialStore, files: FileLink[], hasOpenWork: (entry: MaterialEntry) => boolean, locked: (run: () => Promise<void>) => Promise<void>): Promise<void> {
  try {
    await locked(async () => holdRecovered(turn, material, files, hasOpenWork));
    delete turn.unclassified;
  } catch { turn.unclassified = files; }
}
