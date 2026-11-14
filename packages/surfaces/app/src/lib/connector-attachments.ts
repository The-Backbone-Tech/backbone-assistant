import type { HeldCall } from '@backbone-next/platform';

export interface HeldAttachment { index: number; filename: string; mime: string; bytes: Uint8Array<ArrayBuffer>; content: string }

/** A display projection only: retain the immutable call/hash and decode only canonical inline bytes. */
export function attachmentDisplay(held: Pick<HeldCall, 'args' | 'statement'>) {
  const files: HeldAttachment[] = [];
  const attachments = held.args.attachments;
  if (!Array.isArray(attachments)) return { ...held, files };
  const shown = attachments.map((file: unknown, index) => {
    if (!file || typeof file !== 'object' || !('filename' in file) || typeof file.filename !== 'string'
      || !('content' in file) || typeof file.content !== 'string') return file;
    try {
      const decoded = atob(file.content);
      if (btoa(decoded) !== file.content) return file;
      const mime = 'mime_type' in file && typeof file.mime_type === 'string' ? file.mime_type : 'application/octet-stream';
      const bytes = Uint8Array.from(decoded, char => char.charCodeAt(0));
      files.push({ index, filename: file.filename, mime, bytes, content: file.content });
      const { content: _content, ...metadata } = file;
      return { ...metadata, mime_type: mime, size: bytes.byteLength };
    } catch { return file; }
  });
  const args = { ...held.args, attachments: shown }, json = JSON.stringify(held.args);
  // Only replace the exact argument suffix. Never invent a matching statement for mismatched data.
  const statement = held.statement.endsWith(json) ? held.statement.slice(0, -json.length) + JSON.stringify(args) : held.statement;
  return { args, statement, files };
}
