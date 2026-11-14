// What a finished turn leaves in memory: only what the person said in their own message, and only
// the kinds of sentence that ask to be kept: "remember that…", a standing preference ("from now on…",
// "always…", "I prefer…"), a correction ("actually, …"), or a fact about their own things ("our
// office is in Madrid"). Never a credential: a sentence holding an exact credential value the host
// knows, a known credential format, or words that name one is not kept at all.

export interface Learned { topic: 'facts' | 'preferences' | 'corrections'; text: string }

/** Known credential formats. A match anywhere in a sentence keeps the whole sentence out. */
const CREDENTIAL = /(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/;
const NAMES_ONE = /\b(password|passcode|passwd|passphrase|api[ _-]?key|access[ _-]?key|secret|token|pin)\b/i;
/** A credential named and then given: "password: x", "the token is x", "api key = x". */
const NAMED_VALUE = /\b(password|passcode|passwd|passphrase|api[ _-]?key|access[ _-]?key|secret|token|bearer|pin)\b\s*(?:[:=]|\bis\b|\bwas\b)\s*["'`]?[^\s"'`]{3,}/i;

/**
 * Whether text holds a credential: any value the host's store holds, however short; a known format;
 * or a credential named and then given. Everything stored in memory or handed to a model passes this.
 */
export function holdsCredential(text: string, exact: readonly string[]): boolean {
  return exact.some((v) => v.length > 0 && text.includes(v)) || CREDENTIAL.test(text) || NAMED_VALUE.test(text);
}

const sentence = (s: string) => {
  const t = s.trim().replace(/\s+/g, ' ');
  const capital = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
};

export function learnFrom(text: string, exact: readonly string[]): Learned[] {
  const out: Learned[] = [];
  for (const raw of text.split(/(?<=[.!?])\s+|\n+/)) {
    const s = raw.trim();
    if (s.length < 6 || s.length > 400) continue;
    if (holdsCredential(s, exact) || NAMES_ONE.test(s)) continue;
    const remember = /^(?:please\s+)?(?:remember|note)(?:\s+that|:)?\s+(.+)$/i.exec(s);
    if (remember) { out.push({ topic: 'facts', text: sentence(remember[1]) }); continue; }
    if (/^(from now on|going forward|always|never)\b/i.test(s) || /^I (prefer|like|want|don't like|do not like|dislike)\b/i.test(s)) { out.push({ topic: 'preferences', text: sentence(s) }); continue; }
    const correction = /^(?:actually|correction)[,:]?\s+(.+)$/i.exec(s) ?? /^no[,:]\s+(.+)$/i.exec(s);
    if (correction) { out.push({ topic: 'corrections', text: sentence(correction[1]) }); continue; }
    if (/^(my|our) [\p{L}' -]{1,40}? (is|are) \S/iu.test(s)) out.push({ topic: 'facts', text: sentence(s) });
  }
  return out;
}
