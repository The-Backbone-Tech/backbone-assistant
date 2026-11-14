// How remembered lines are ranked against a turn's words: BM25 over light word stems, with a near
// miss (one letter added, dropped, changed or swapped, in words of five letters or more) counted at
// half weight, so "invoce" still finds "invoice". When the person's own loopback embeddings route
// gave similarities (memory/embeddings.ts), they are merged in: a line can then be found by meaning
// with no word in common. Pure functions: nothing here reads or writes the home.
import type { MemoryEntry, MemoryTrust } from '../api.ts';

const TRUST_ORDER: Record<MemoryTrust, number> = { personal: 0, imported: 1, untrusted: 2 };

/** Keep the weakest contributing provenance. Unknown persisted marks fail closed. */
export function weakestTrust(...tiers: MemoryTrust[]): MemoryTrust {
  return tiers.reduce<MemoryTrust>((weakest, tier) =>
    !Object.hasOwn(TRUST_ORDER, tier) ? 'untrusted' : TRUST_ORDER[tier] > TRUST_ORDER[weakest] ? tier : weakest, 'personal');
}

/** Ownership for editing is not provenance: imports and model words remain reference material. */
export function memoryTrust(entry: Pick<MemoryEntry, 'origin' | 'sources' | 'trust'>): MemoryTrust {
  const kind = entry.origin.kind;
  const inferred = entry.sources.length || /^https?:\/\//i.test(entry.origin.source ?? '') ? 'untrusted'
    : kind === 'import' ? 'imported' : kind === 'person' || kind === 'turn' ? 'personal'
    : kind === 'merge' ? entry.trust ?? 'untrusted' : 'untrusted';
  return weakestTrust(inferred, entry.trust ?? inferred);
}

/** Applied only among equally relevant lines; provenance never makes unrelated words relevant. */
export function compareMemoryTrust(a: MemoryEntry, b: MemoryEntry): number {
  return TRUST_ORDER[memoryTrust(a)] - TRUST_ORDER[memoryTrust(b)];
}

export const STOP = new Set('the and for are but not you your with this that from have has had was were will would can could should what when where which who how why our out about into over than then them they their there these those its it’s also just like does did do any all some more most other such only own same very after before again here once'.split(' '));

/** A word's light stem: plurals, -ing, -ed and -ly folded, so "paying", "pays" and "pay" meet. */
export function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && /(ss|sh|ch|x|z)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('ly')) w = w.slice(0, -2);
  return w;
}

/** The stems of a text's words, in order, without stop words or words of fewer than three letters. */
export function tokens(text: string): string[] {
  return text.toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w)).map(stem);
}

/** Whether two words are one edit apart (Damerau: an added, dropped, changed or swapped letter). */
export function nearMiss(a: string, b: string): boolean {
  if (a === b || Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  return long.slice(i + 1) === short.slice(i);
}

const K1 = 1.2;
const B = 0.75;
/** How much a near miss counts against an exact stem. */
const NEAR = 0.5;
/** How much meaning counts against words, when both are known; words still decide among equals. */
const MEANING = 0.6;
/** Below this cosine similarity a line is not taken to mean the same as the words. */
export const MIN_SIMILARITY = 0.55;

export interface Ranked<T> { item: T; score: number }

/**
 * Rank `items` (their text from `textOf`) against `words`: BM25 over the items given, with near
 * misses at half weight; merged with `similarity` (cosine, by item, from an embeddings route) when
 * given. Items that match neither way are left out. Ties keep the order given.
 */
export function rank<T>(items: readonly T[], textOf: (item: T) => string, words: string, similarity?: (item: T) => number | undefined): Ranked<T>[] {
  const asked = [...new Set(tokens(words))];
  const docs = items.map((item) => tokens(textOf(item)));
  const n = docs.length;
  const avg = n ? docs.reduce((s, d) => s + d.length, 0) / n : 0;
  // How many lines hold each asked stem (or a near miss of it): rarer stems weigh more.
  const holds = (d: string[], q: string) => d.some((t) => t === q || nearMiss(t, q));
  const idf = new Map(asked.map((q) => {
    const df = docs.filter((d) => holds(d, q)).length;
    return [q, Math.log(1 + (n - df + 0.5) / (df + 0.5))];
  }));
  const lexical = docs.map((d) => {
    let score = 0;
    for (const q of asked) {
      const exact = d.filter((t) => t === q).length;
      const tf = exact || d.filter((t) => nearMiss(t, q)).length * NEAR;
      if (!tf) continue;
      score += idf.get(q)! * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (d.length / (avg || 1))));
    }
    return score;
  });
  const top = Math.max(0, ...lexical);
  return items
    .map((item, i) => {
      const words = top ? lexical[i] / top : 0;
      // With similarities, every item is scored the same way; one with no vector has no meaning score.
      const meant = similarity?.(item) ?? 0;
      const meaning = meant >= MIN_SIMILARITY ? (meant - MIN_SIMILARITY) / (1 - MIN_SIMILARITY) : 0;
      const score = similarity ? (1 - MEANING) * words + MEANING * meaning : words;
      return { item, score, i };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(({ item, score }) => ({ item, score }));
}

/** Cosine similarity of two vectors of the same length; 0 for an empty or mismatched pair. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
