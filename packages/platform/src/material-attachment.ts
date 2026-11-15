// Shared limits for a local original supplied by the person. No filesystem reads here.
import {isIntermediate} from './stub/fsx.ts';

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_BASE64 = 4 * Math.ceil(MAX_ATTACHMENT_BYTES / 3);

/** Keep the existing direct attachment basename and intermediate-file rules. */
export function attachmentName(name: string): string | undefined {
  // No file on disk has a path this long, a name over 255 bytes or a NUL in it; a caller that sends one is not naming a file.
  if (name.length > 4096 || name.includes('\0')) return undefined;
  const clean = name.split(/[\\/]/).pop() ?? '';
  return clean && Buffer.byteLength(clean, 'utf8') <= 255 && !isIntermediate(clean) ? clean : undefined;
}

/** Check encoded length before decoding; Buffer's permissive base64 decoder is not validation. */
export function attachmentBytesFit(base64: unknown): base64 is string {
  if (typeof base64 !== 'string' || base64.length > MAX_BASE64 || base64.length % 4 !== 0) return false;
  if (/[^A-Za-z0-9+/=]/.test(base64)) return false;
  const bytes = Buffer.from(base64, 'base64');
  return bytes.length <= MAX_ATTACHMENT_BYTES && bytes.toString('base64') === base64;
}
