// Engine-facing projections only. Stored words, credential checks, hashes and snapshots stay raw.
// One character-class pass: tag letters, bidi controls and other invisible code points become text.
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/gu;

/** A visible spelling, never an instruction or a decoder. Emoji/RTL bytes remain intact in storage. */
export function memoryReferenceText(text: string): string {
  return text.replace(INVISIBLE, c => `\\u{${c.codePointAt(0)!.toString(16)}}`);
}

/** Values become visible before JSON encoding, so a transport's JSON parse cannot restore controls. */
export function memoryReferenceJson(value: unknown, space?: number): string {
  return JSON.stringify(value, (_key, part) => typeof part === 'string' ? memoryReferenceText(part) : part, space) ?? 'null';
}
