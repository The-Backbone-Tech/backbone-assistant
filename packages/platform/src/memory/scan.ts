// Original local rules, licensed with this package. No I/O, model, decoding or third-party scanner.
// This is an intentionally narrow signal. Stored provenance and data-only handling are the boundary.
export type MemoryUnsafe = 'injection' | 'exfiltration';

const addressed = '(?:^|[.!?]\\s+)(?:(?:assistant|ai assistant|you)[,:]?\\s+)?';
const override = '(?:(?:ignore|disregard)\\s*(?:all\\s+)?|forget\\s+(?:all\\s+|your\\s+))(?:previous|prior|earlier|above)\\s+(?:system\\s+)?instructions\\b';
const hiddenInstruction = /\b(?:assistant|ai assistant)[,:]?\s+(?:follow|obey|ignore|override)(?=\s|$)/i;
const rules: { kind: MemoryUnsafe; matches: (text: string) => boolean }[] = [
  // A direct imperative discards previous assistant instructions, not an ordinary workplace rule.
  { kind: 'injection', matches: text => new RegExp(addressed + override, 'i').test(text) },
  // Possessive system/rule objects avoid blocking "ignore the eslint rule".
  { kind: 'injection', matches: text => new RegExp(addressed + '(?:ignore|override|disregard)\\s+your\\s+(?:system prompt|system instructions|rules|safety policy)\\b', 'i').test(text) },
  // Disabling the assistant's own safety policy is distinct from turning off a water filter.
  { kind: 'injection', matches: text => new RegExp(addressed + '(?:disable|bypass|turn off)\\s+your\\s+(?:safety policy|safety rules|guardrails)\\b', 'i').test(text) },
  // Explicitly voiding system instructions impersonates a higher-priority policy update.
  { kind: 'injection', matches: text => /\byour system (?:instructions|rules|prompt) (?:no longer appl(?:y|ies)|are now void)\b/i.test(text) },
  // HTML comments hide instructions from a rendered document while models can still see them.
  { kind: 'injection', matches: text => [...text.matchAll(/<!--[\s\S]*?-->/g)].some(m => hiddenInstruction.test(m[0])) },
  // Require both hidden rendering and an assistant directive; normal hidden UI markup is harmless.
  { kind: 'injection', matches: text => /<[^>]+(?:\bhidden\b|display\s*:\s*none|visibility\s*:\s*hidden)[^>]*>[^<]*\b(?:assistant|ai assistant)[,:]?\s+(?:follow|obey|ignore|override)(?=\s|$)/i.test(text) },
  // Markdown reference comments can conceal assistant directives without visible link text.
  { kind: 'injection', matches: text => /^\s*\[(?:\/\/|comment)\]:\s*#\s*\(.*\b(?:assistant|ai assistant)[,:]?\s+(?:follow|obey|ignore|override)(?=\s|$)/i.test(text) },
  // Exact model-protocol role delimiters are stronger evidence than ordinary "system:" prose.
  { kind: 'injection', matches: text => /<\|(?:im_start|start_header_id)\|>\s*(?:system|developer)\b/i.test(text) },
  // Outbound URL placeholders substitute data; a normal release URL or API-key notice does not.
  { kind: 'exfiltration', matches: text =>
    /https?:\/\/[^\s<>"')]*[?&][\w.-]+=\$?\{[^}\s]*(?:secret|token|key|data|password|credential|private)[^}\s]*\}/i.test(text)
    || /https?:\/\/[^\s<>"')]*[?&][\w.-]+=(?:SECRET|DATA|TOKEN|API_KEY|PASSWORD)(?=[&#\s<>"')]|$)/.test(text) },
  // A direct private-data transfer requires a disclosure verb, private object and HTTP destination.
  { kind: 'exfiltration', matches: text => new RegExp(addressed + '(?:send|upload|post|exfiltrate|leak)\\s+(?:all\\s+)?(?:your\\s+)?(?:private documents?|private keys?|secrets?|credentials?|access tokens?|api keys?)\\s+to\\s+https?://', 'i').test(text) },
];

/** Strip format controls only in the matching copy. Emoji ZWJ, RTL and all stored bytes survive. */
export function scanMemory(text: string): MemoryUnsafe | undefined {
  // Valid admissions are at most 1,000 characters. Bound ALL costly regex inputs, including
  // NFKC expansion, so a large direct-file line cannot turn a heuristic into a host-wide stall.
  const normalized = text.slice(0, 1024).normalize('NFKC').slice(0, 1024).replace(/[\p{Cf}\u034f\uFE00-\uFE0F]/gu, '');
  return rules.find(rule => rule.matches(normalized))?.kind;
}

/** A category only: matched words and URLs are never copied into an error, record or log. */
export class MemoryScanRefused extends Error {
  readonly code = 'MEMORY_UNSAFE';
  readonly kind: MemoryUnsafe;
  constructor(kind: MemoryUnsafe) {
    super(kind === 'exfiltration'
      ? 'Not kept: this memory matches a clear data exfiltration pattern.'
      : 'Not kept: this memory matches a clear prompt injection pattern.');
    this.name = 'MemoryScanRefused';
    this.kind = kind;
  }
}

/** Scan each field separately, before any storage write or merge staging. */
export function assertSafeMemory(text: string, topic: string): void {
  const unsafe = scanMemory(text) ?? scanMemory(topic);
  if (unsafe) throw new MemoryScanRefused(unsafe);
}
