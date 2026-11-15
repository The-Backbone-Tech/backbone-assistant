import { StringDecoder } from 'node:string_decoder';
import type { TerminalBlock } from '../api.ts';

/** A bounded beginning and end, not a terminal emulator. The omitted middle is counted in bulk. */
export function terminalOutput(block: TerminalBlock, keepEnd = true) {
  const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
  let kept = '', line = '', bytes = 0, lineBytes = 0, lines = 0, streamed = 0, capped = false, cr = false;
  let mode: 'text' | 'escape' | 'intermediate' | 'csi' | 'string' | 'end' = 'text', controlLength = 0;
  const ring = Buffer.alloc(keepEnd ? 32_768 : 0);
  let tailAt = 0, tailSize = 0, discardedBytes = 0, discardedLines = 0, tailDirty = false;
  function dropped(source: Buffer | string) {
    discardedBytes += typeof source === 'string' ? Buffer.byteLength(source) : source.length;
    let at = -1;
    while ((at = typeof source === 'string' ? source.indexOf('\n', at + 1) : source.indexOf(10, at + 1)) !== -1) discardedLines++;
    if (keepEnd && source.length) {
      // Copy only the bounded suffix; never retain an arbitrarily large input allocation.
      const suffix = (Buffer.isBuffer(source) ? source : Buffer.from(source.slice(-32_768))).subarray(-32_768);
      const first = Math.min(suffix.length, ring.length - tailAt);
      suffix.copy(ring, tailAt, 0, first); suffix.copy(ring, 0, first);
      tailAt = (tailAt + suffix.length) % ring.length; tailSize = Math.min(ring.length, tailSize + suffix.length);
      tailDirty = true;
    }
    block.omittedBytes = discardedBytes; block.omittedLines = discardedLines;
  }
  function text(source: string) {
    let offset = 0;
    for (const c of source) {
      if (capped) { dropped(source.slice(offset)); break; }
      offset += c.length;
      if (mode !== 'text') {
        controlLength++;
        if (mode === 'escape') mode = c === '[' ? 'csi' : ']PX_^'.includes(c) ? 'string' : /[ -/]/.test(c) ? 'intermediate' : 'text';
        else if (mode === 'intermediate' && /[0-~]/.test(c)) mode = 'text';
        else if (mode === 'csi' && /[@-~]/.test(c)) mode = 'text';
        else if (c === '\x9c' || mode === 'string' && c === '\x07' || mode === 'end' && c === '\\') mode = 'text';
        else if (mode === 'string' && c === '\x1b') mode = 'end';
        else if (mode === 'end') mode = 'string';
        if (controlLength >= 256) mode = 'text';
        continue;
      }
      if (c === '\x1b' || c === '\x9b' || /[\x90\x98\x9d-\x9f]/.test(c)) {
        mode = c === '\x1b' ? 'escape' : c === '\x9b' ? 'csi' : 'string'; controlLength = 0; continue;
      }
      if (c === '\r') { cr = true; continue; }
      if (cr) { if (c !== '\n') { bytes -= lineBytes; line = ''; lineBytes = 0; } cr = false; }
      if (c !== '\n' && c !== '\t' && /[\x00-\x1f\x7f-\x9f\p{Cf}]/u.test(c)) continue;
      const size = Buffer.byteLength(c);
      if (bytes + size > 32_768 || lines >= 500) { capped = true; dropped(source.slice(offset - c.length)); break; }
      bytes += size;
      if (c === '\n') { kept += line + '\n'; line = ''; lineBytes = 0; lines++; }
      else { line += c; lineBytes += size; }
    }
    if (!keepEnd || !discardedBytes) block.output = kept + line;
  }
  function publish() {
    if (!tailDirty) return;
    tailDirty = false;
    // Materialize once per read/checkpoint, not per input event. Only the retained suffix is parsed.
    const tail = tailSize < ring.length ? ring.subarray(0, tailSize) : Buffer.concat([ring.subarray(tailAt), ring.subarray(0, tailAt)]);
    let start = tail.length;
    for (let n = 0; n < 500; n++) { const at = tail.lastIndexOf(10, start - 1); if (at < 0) { start = 0; break; } start = at; }
    let from = start ? start + 1 : 0;
    while (from < tail.length && (tail[from] & 0xc0) === 0x80) from++; // Do not start inside UTF-8.
    const suffix = tail.subarray(from);
    const last = { output: '', omittedBytes: 0, omittedLines: 0 } as TerminalBlock;
    const parser = terminalOutput(last, false); parser.append(suffix, 0); parser.end();
    block.output = kept + line + last.output;
    block.omittedBytes = discardedBytes - Buffer.byteLength(last.output);
    block.omittedLines = discardedLines - (last.output.match(/\n/g)?.length ?? 0);
  }
  return {
    publish,
    append(bytes: Buffer, stream: number) {
      if (capped) { dropped(bytes); return; }
      // Invisible controls and CR-only progress cannot evade the work bound by keeping the preview empty.
      const take = Math.min(bytes.length, 1_048_576 - streamed); streamed += take;
      text(decoders[stream].write(bytes.subarray(0, take)));
      if (streamed >= 1_048_576) {
        text(decoders[stream].end()); capped = true;
        dropped(bytes.subarray(take));
      }
    },
    end() { for (const decoder of decoders) text(decoder.end()); publish(); },
  };
}
