// The scripted model's memory consolidation, for tests and journeys: it answers the judge's request
// (memory/judge.ts) by fixed word rules. Lines of one topic whose word stems overlap by 75% or more
// are merged, the longer kept; a proposal that shares two or more stems with a line by the person,
// without saying the same, is held as a conflict; any other proposal is kept. It proves the plumbing
// (the engine route, the answer's checks, what is kept and what waits), not judgement.
import { JUDGE_MARK } from '../memory/judge.ts';
import { tokens } from '../memory/rank.ts';
import type { Message, Step } from './scripted-model.ts';

const text = (m: Message) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((c) => c.text ?? '').join(''));
interface Shown { id: string; topic: string; by: 'person' | 'engine'; text: string }

/** The judge's request in `messages`, if the last person message is one. */
export const isJudgeRequest = (messages: Message[]) => text(messages[messages.findLastIndex((m) => m.role === 'user')] ?? { role: 'user' }).includes(JUDGE_MARK);

export function judgeStep(messages: Message[]): Step {
  const asked = text(messages[messages.findLastIndex((m) => m.role === 'user')]);
  const data = JSON.parse(asked.slice(asked.lastIndexOf('\n{\n') + 1)) as { lines: Shown[]; proposed: Shown[] };
  const stems = (s: string) => new Set(tokens(s));
  const overlap = (a: string, b: string) => { const x = stems(a), y = stems(b); const both = [...x].filter((w) => y.has(w)).length; return { both, jaccard: both / (x.size + y.size - both || 1) }; };
  const changes: Record<string, unknown>[] = [];
  const used = new Set<string>();
  for (const a of data.lines) for (const b of data.lines) {
    if (a.id >= b.id || a.topic !== b.topic || used.has(a.id) || used.has(b.id) || overlap(a.text, b.text).jaccard < 0.75) continue;
    changes.push({ op: 'merge', lines: [a.id, b.id], text: b.text.length > a.text.length ? b.text : a.text, why: 'They say the same.' });
    used.add(a.id); used.add(b.id);
  }
  for (const p of data.proposed) {
    const conflicts = data.lines.filter((l) => l.by === 'person' && overlap(l.text, p.text).both >= 2 && overlap(l.text, p.text).jaccard < 0.75).map((l) => l.id);
    changes.push(conflicts.length ? { op: 'hold', proposal: p.id, conflicts, why: 'It may change what the person said.' } : { op: 'keep', proposal: p.id, why: 'New and consistent.' });
  }
  return { text: JSON.stringify({ changes }) };
}
