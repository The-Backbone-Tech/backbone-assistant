// Search every conversation with MiniSearch's full-text relevance ranking. Every query word must
// occur in the same conversation, even when the words are spread across turns or the title.
import MiniSearch from 'minisearch';
import type { ThreadHit } from '../api.ts';
import type { StoredThread } from './thread-journal.ts';

const AROUND = 60;
const normalize = (term: string) => term.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const tokenize = (text: string) => text.match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
interface Place extends ThreadHit { id: number; text: string; updatedAt: string }

function snippet(text: string, at: number): string {
  const start = Math.max(0, at - AROUND);
  const end = Math.min(text.length, at + AROUND);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}

export function searchThreads(threads: Iterable<StoredThread>, query: string): ThreadHit[] {
  const terms = [...new Set(tokenize(query).map(normalize).filter(Boolean))];
  if (!terms.length) return [];
  // Build from the current Host snapshot: edits, deletion and a different home cannot leave a stale
  // index behind. This is derived, in-memory state; searching writes nothing to the person's home.
  const places: Place[] = [];
  for (const t of threads) {
    const fields: { field: ThreadHit['field']; text: string; turnId?: string }[] = [
      { field: 'title', text: t.summary.title },
      ...[...t.turns, ...t.sideTurns].flatMap((turn) => [{ field: 'words' as const, text: turn.user.text, turnId: turn.id }, { field: 'answer' as const, text: turn.answer?.text ?? '', turnId: turn.id }]),
    ];
    for (const p of fields) {
      if (p.text) places.push({ ...p, id: places.length, threadId: t.summary.id, title: t.summary.title, snippet: '', updatedAt: t.summary.updatedAt });
    }
  }
  const index = new MiniSearch<Place>({ fields: ['text'], tokenize, processTerm: normalize });
  index.addAll(places);
  const matches = index.search(terms.join(' '), { prefix: (_term, i, all) => i === all.length - 1 });
  const found = new Map<string, Set<string>>();
  for (const match of matches) {
    const id = places[match.id].threadId;
    const words = found.get(id) ?? new Set<string>();
    for (const word of match.queryTerms) words.add(word);
    found.set(id, words);
  }
  return matches.filter(m => found.get(places[m.id].threadId)?.size === terms.length)
    .sort((a, b) => b.queryTerms.length - a.queryTerms.length || b.score - a.score || places[b.id].updatedAt.localeCompare(places[a.id].updatedAt) || a.id - b.id)
    .map(m => {
      const { id: _id, text, updatedAt: _at, ...hit } = places[m.id];
      const at = [...text.matchAll(/[\p{L}\p{N}\p{M}]+/gu)].find(word => m.terms.includes(normalize(word[0])))?.index ?? 0;
      return { ...hit, snippet: snippet(text, at) };
    });
}
