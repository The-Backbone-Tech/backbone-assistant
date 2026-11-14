// Shared, unchanged classification floor; the service keeps its public re-exports.
import type { ListedTool } from './client.ts';
import type { ConnectorTool } from '../api-connectors.ts';
/** Classification floor only: these names cannot use a server hint to evade the effect gate. */
const EFFECT_NAMES_ANYWHERE = ['send', 'reply', 'forward', 'delete', 'remove', 'trash', 'destroy', 'purge', 'wipe', 'erase', 'payment', 'purchase', 'transfer', 'refund', 'withdraw', 'publish', 'tweet', 'invite', 'broadcast', 'submit', 'deploy'];
/** Short verbs, matched where a word starts or ends (buynow, postmessage, chargecard, reorder), not inside one (display, support). */
const EFFECT_NAMES_EDGES = ['pay', 'buy', 'order', 'charge', 'post', 'share'];
/** A tool name's words: camelCase, snake_case, kebab and dots all split, lowercased. */
const wordsOf = (name: string) => name.normalize('NFKC').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
/** Name-list membership only. The optional old argument parameter is ignored for compatibility. */
export function blocked(tool: string, _args?: Record<string, unknown>): boolean {
  const words = wordsOf(tool);
  const joined = words.join('');
  return EFFECT_NAMES_ANYWHERE.some((v) => joined.includes(v)) || words.some((w) => EFFECT_NAMES_EDGES.some((v) => w.startsWith(v) || w.endsWith(v)));
}
// The narrow read-noun exemption belongs only to classification.
const NOUN_WORDS = new Set(['post', 'posts', 'order', 'orders', 'share', 'shares', 'reply', 'replies', 'forward', 'forwards', 'payment', 'payments', 'purchase', 'purchases', 'refund', 'refunds', 'tweet', 'tweets', 'invite', 'invites', 'broadcast', 'broadcasts', 'charge', 'charges', 'trash']);
const READ_WORDS = new Set(['get', 'list', 'search', 'read', 'fetch', 'find', 'count', 'describe', 'show', 'view', 'lookup']);
const CONNECTIVE_WORDS = new Set(['and', 'then', 'to', 'with', 'or', 'plus']);
const classificationWords = (name: string) => name.normalize('NFKC').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const unsafeName = (name: string): boolean => [...name].some(c => c.codePointAt(0)! > 127 && /\p{L}/u.test(c)) || /[^A-Za-z0-9_.-]/.test(name.normalize('NFKC'));

/** Every released hit must start inside the single final noun, including joined-name hits. */
const readNounException = (name: string): boolean => {
  const words = classificationWords(name), noun = words.at(-1);
  if (words.length < 2 || !READ_WORDS.has(words[0]) || !noun || !NOUN_WORDS.has(noun) || words.some(w => CONNECTIVE_WORDS.has(w))) return false;
  const releasedWords = wordsOf(name), joined = releasedWords.join(''), nounStart = joined.length - noun.length;
  if (joined !== words.join('')) return false;
  if (EFFECT_NAMES_ANYWHERE.some(stem => { const hit = joined.indexOf(stem); return hit >= 0 && hit < nounStart; })) return false;
  let offset = 0;
  for (const word of releasedWords) {
    if (EFFECT_NAMES_EDGES.some(stem => (word.startsWith(stem) && offset < nounStart)
      || (word.endsWith(stem) && offset + word.length - stem.length < nounStart))) return false;
    offset += word.length;
  }
  return true;
};
export const annotated = (t: ListedTool): ConnectorTool['annotated'] => {
  const a = t.annotations;
  if (a.readOnlyHint === undefined && a.destructiveHint === undefined) return 'unannotated';
  return a.readOnlyHint === true && a.destructiveHint !== true ? 'read' : 'effect';
};
/** Released floor plus unsafe characters; only an annotated final-noun read can be exempt. */
export const kindOf = (t: ListedTool, override?: 'read' | 'effect'): 'read' | 'effect' => {
  if (t.name.toLowerCase().startsWith('webmcp_')) return 'effect'; // Page code owns these annotations.
  const read = annotated(t) === 'read';
  if (unsafeName(t.name) || (blocked(t.name) && !(read && readNounException(t.name)))) return 'effect';
  return override ?? (read ? 'read' : 'effect');
};
