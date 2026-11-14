// What matters now in a project: computed from the threads and material each time, so it cannot go
// stale and holds no text of its own. Unfinished work always comes first. Temporary output is an
// agent's working document nobody has touched and no latest turn still presents; retiring one
// hides it and keeps every version, and anything unresolved about a document keeps it visible.
import type { MaterialEntry, Thread, WorkNow } from '../api.ts';
import { isWithdrawn } from '../stub/material.ts';

/** Documents still in use from turns that read this source. Later derivations are not traced. */
export function mayCarry(threads: Pick<Thread, 'turns'>[], source: MaterialEntry, entries: MaterialEntry[]): string[] {
  const inUse = new Map(entries.filter((e) => !e.hidden && e.class !== 'original').map((e) => [e.id, e.name]));
  const read = threads.flatMap((t) => t.turns).filter((turn) => (turn.reads ? turn.reads.some((r) => r.id === source.id)
    : turn.work.steps.some((s) => s.kind === 'read' && s.label.startsWith(`Read ${source.name} v`))));
  return [...new Set(read.flatMap((turn) => turn.answer?.files.flatMap((f) => inUse.get(f.materialId) ?? []) ?? []))];
}

/** A person's work or an open question stands behind this document, so it cannot be set aside. */
export function hasOpenWork(threads: Pick<Thread, 'turns'>[], e: MaterialEntry, hasDraft: (id: string) => boolean): boolean {
  return !!e.kept || !!e.unsure || !!e.interruptedSave || hasDraft(e.id) || e.versions.some((v) => v.by === 'person')
    || threads.some((t) => t.turns.some((turn) => turn.effects.some((effect) => effect.outcome === 'UNKNOWN' && effect.target === e.name)));
}

/** What a turn is told about sources gone from its project, in plain words; undefined when none is. */
export function withdrawalNotice(threads: Pick<Thread, 'turns'>[], entries: MaterialEntry[]): string | undefined {
  const lines = entries.filter(isWithdrawn).map((e) => {
    const carriers = mayCarry(threads, e, entries);
    return `${e.name} was withdrawn by the person on ${e.withdrawals!.at(-1)!.at.slice(0, 10)}. It is gone from this project: do not use it or anything remembered from it.${carriers.length ? ` These documents may carry its content: ${carriers.join(', ')}.` : ''}`;
  });
  return lines.length ? `${lines.join('\n')}\nSay so if this affects the work.` : undefined;
}

const parentOf = (thread: Pick<Thread, 'summary'>) => (thread.summary.parentId ? { parentThreadId: thread.summary.parentId } : {});

export function workNow(threads: Pick<Thread, 'summary' | 'turns' | 'goal'>[], entries: MaterialEntry[], hasDraft: (id: string) => boolean): WorkNow {
  const live = threads.filter((t) => !t.summary.archived);
  const needsYou: WorkNow['needsYou'] = [];
  const unsettled = new Set<string>();
  // Archiving tidies a thread away; it settles nothing. Unresolved work is read from every thread.
  for (const thread of threads) {
    for (const turn of thread.turns) {
      for (const effect of turn.effects) {
        if (effect.outcome !== 'UNKNOWN') continue;
        unsettled.add(effect.target);
        needsYou.push({ kind: 'unknown', threadId: thread.summary.id, ...parentOf(thread), title: thread.summary.title, detail: effect.detail ?? `${effect.target}: the outcome is unknown and it will not be resent.` });
      }
    }
    const last = thread.turns.at(-1);
    if (!thread.summary.archived && last?.status === 'stopped' && !last.effects.some((e) => e.outcome === 'UNKNOWN')) {
      needsYou.push({ kind: 'stopped', threadId: thread.summary.id, ...parentOf(thread), title: thread.summary.title, detail: 'This work stopped before it finished.' });
    }
    if (!thread.summary.archived && last?.status === 'refused') {
      needsYou.push({ kind: 'stopped', threadId: thread.summary.id, ...parentOf(thread), title: thread.summary.title, detail: last.answer?.text || 'This work was refused.' });
    }
    for (const proposal of thread.goal?.proposals ?? []) {
      if (proposal.state === 'open') needsYou.push({ kind: 'goal', threadId: thread.summary.id, proposalId: proposal.id, title: thread.summary.title, detail: `An agent proposes this goal: ${proposal.text}` });
    }
  }
  for (const thread of threads) {
    if (thread.turns.some((turn) => turn.unclassified?.length)) needsYou.push({ kind: 'unsure', threadId: thread.summary.id, title: thread.summary.title, detail: 'Recovered work could not yet be checked against withdrawn sources. It may carry one; this will be tried again at the next start.' });
  }
  for (const entry of entries) {
    const unsure = { kind: 'unsure' as const, materialId: entry.id, version: entry.current, lifecycle: entry.lifecycle ?? 0, title: entry.name };
    if (entry.unsure?.interrupted) needsYou.push({ ...unsure, detail: 'This came from an interrupted turn and may be incomplete. Keep it once you have checked it.' });
    else if (entry.unsure) needsYou.push({ ...unsure, detail: `This may carry ${entry.unsure.name}, which was withdrawn, and it could not safely be held. Keep it once you have checked it.` });
    if (entry.folderConflict) needsYou.push({ ...unsure, detail: 'A different file is at this path in the project folder. It was left as it is, and the copy set aside is kept.' });
    if (entry.interruptedSave) needsYou.push({ kind: 'interrupted-save', materialId: entry.id, title: entry.name, detail: `A Save of v${entry.interruptedSave.version} did not finish; v${entry.current} is current.` });
    if (entry.held) needsYou.push({ kind: 'held', materialId: entry.id, version: entry.current, lifecycle: entry.lifecycle ?? 0, title: entry.name, detail: entry.recovery ? 'This saved piece was not imported. You can inspect or retire it; it cannot be used as an authorised output.' : entry.held.changed ? `${entry.held.name} changed after this was made, so it may be out of date. Later work cannot see it until you decide.` : `Made while ${entry.held.name} was being withdrawn, so it may carry its content. Later work cannot see it until you decide.` });
  }
  // Progress is one line per piece of work, the rest behind its thread; a stopped or refused turn
  // reports itself in `needsYou`, never as finished.
  const progress = live.flatMap((t) => {
    const last = t.turns.at(-1);
    const line = last?.status === 'done' ? last.answer?.text.split('\n').find((l) => l.trim()) : undefined;
    return line ? [{ threadId: t.summary.id, title: t.summary.title, line: line.trim().slice(0, 200), at: last!.work.endedAt ?? last!.user.at }] : [];
  }).sort((a, b) => b.at.localeCompare(a.at));
  const presented = new Set(live.flatMap((t) => t.turns.at(-1)?.answer?.files.map((f) => f.materialId) ?? []));
  const shown = entries.filter((e) => !e.hidden);
  const temporary = (e: MaterialEntry) => e.class === 'working' && !e.kept && !e.unsure && !e.folderConflict && e.versions.every((v) => v.by === 'agent')
    && !presented.has(e.id) && !unsettled.has(e.name) && !e.interruptedSave && !hasDraft(e.id);
  const row = (e: MaterialEntry) => ({ id: e.id, name: e.name, version: e.current, lifecycle: e.lifecycle ?? 0, by: e.versions.at(-1)!.by, at: e.versions.at(-1)!.at });
  return {
    running: threads.filter((t) => t.summary.running).map((t) => ({ threadId: t.summary.id, title: t.summary.title })),
    needsYou,
    progress,
    current: shown.filter((e) => !temporary(e)).map(row).sort((a, b) => Number(b.by === 'person') - Number(a.by === 'person')),
    temporary: shown.filter(temporary).map(row),
    retired: entries.filter((e) => e.hidden && !e.held && !isWithdrawn(e)).map(row),
    withdrawn: entries.filter(isWithdrawn).map((e) => ({ ...row(e), withdrawnAt: e.withdrawals!.at(-1)!.at, mayCarry: mayCarry(threads, e, entries) })),
  };
}
