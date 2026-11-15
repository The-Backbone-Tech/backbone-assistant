// All document input crosses here. Never pass document markup to the live DOM.
export const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;
export const PREVIEW_LIMIT = 'This file is too large to preview. The preview limit is 20 MB. Download keeps the complete file.';
export const READ_FAILURE = 'This file could not be read. It may be damaged or use an unsupported feature. You can retry or download it.';
export type PreviewKind = 'image' | 'pdf' | 'word' | 'sheet' | 'slides';
export type SafeNode = string | { tag: string; children: SafeNode[]; src?: string };
export interface SheetPreview { name: string; rows: string[][]; totalRows?: number; totalColumns: number; partial?: boolean; partialRow?: boolean }
export type OfficePreview = { kind: 'word'; nodes: SafeNode[] } | { kind: 'sheet'; sheets: SheetPreview[] } | { kind: 'slides'; slides: SafeNode[][] };

export function previewKind(name: string): PreviewKind | undefined {
  const ext = name.split('.').at(-1)?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
  return ({ pdf: 'pdf', docx: 'word', xlsx: 'sheet', csv: 'sheet', pptx: 'slides' } as Record<string, PreviewKind>)[ext];
}
export function previewBytes(base64: string): Uint8Array<ArrayBuffer> {
  if (base64.length > Math.ceil(MAX_PREVIEW_BYTES / 3) * 4) throw new Error(PREVIEW_LIMIT);
  try {
    const raw = atob(base64);
    if (raw.length > MAX_PREVIEW_BYTES) throw new Error(PREVIEW_LIMIT);
    const result = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) result[i] = raw.charCodeAt(i);
    return result;
  } catch (e) { throw new Error(e instanceof Error && e.message === PREVIEW_LIMIT ? PREVIEW_LIMIT : READ_FAILURE); }
}
export function safeImage(src: string): string | undefined {
  return src.length <= 8 * 1024 * 1024 && /^data:image\/(?:png|jpeg|gif|webp);base64,[a-zA-Z0-9+/=]+$/.test(src) ? src : undefined;
}
// Fixed MIME chosen from the extension, never from untrusted file metadata. SVG is
// an image resource: Chromium disables its scripts, links and external resources.
export function imageSource(name: string, base64: string): string {
  const ext = name.split('.').at(-1)!.toLowerCase();
  const mime = ({ jpg: 'jpeg', svg: 'svg+xml' } as Record<string, string>)[ext] ?? ext;
  return `data:image/${mime};base64,${base64}`;
}
// The sole element allowlist at the renderer boundary. Even a converter regression
// cannot turn a model node into a live link, style, embedded page or script.
const PREVIEW_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'strong', 'em', 'u', 's', 'br', 'blockquote', 'sup', 'sub', 'img']);
export function previewTag(tag: string): string | undefined { return PREVIEW_TAGS.has(tag) ? tag : undefined; }

export const MAX_TEXT_CHARACTERS = 500000;
export const MAX_SHEET_CELLS = 20000;
export const SHEET_WINDOW_ROWS = 100;
export const SHEET_WINDOW_COLUMNS = 10;
export const EXPANDED_PREVIEW_LIMIT = 'This document is too large to expand for preview. Office archives allow 48 MB expanded; Word and slide previews allow 500,000 text characters. Download keeps the complete file.';
export const CELL_PREVIEW_LIMIT = 'This file contains a cell too large to preview. The cell limit is 10,000 characters. Download keeps the complete file.';
export function previewErrorMessage(error: unknown): string {
  return error instanceof Error && [EXPANDED_PREVIEW_LIMIT, CELL_PREVIEW_LIMIT].includes(error.message) ? error.message : READ_FAILURE;
}

export const IMAGE_PIXEL_LIMIT = 'This image is too large to preview. The preview limit is 40 million pixels. Download keeps the complete file.';
export const PDF_PAGE_LIMIT = 'This PDF is too large to preview. The preview limit is 200 pages. Download keeps the complete file.';
export const PDF_CANVAS_LIMIT = 'This PDF page is too large to preview. The canvas limit is 16 million pixels. Download keeps the complete file.';
export function previewRefusal(message: string): boolean {
  return [PREVIEW_LIMIT, EXPANDED_PREVIEW_LIMIT, CELL_PREVIEW_LIMIT, IMAGE_PIXEL_LIMIT, PDF_PAGE_LIMIT, PDF_CANVAS_LIMIT].includes(message);
}
export function previewKindLabel(kind: PreviewKind): string {
  return { image: 'Image', pdf: 'PDF', word: 'Word document', sheet: 'Spreadsheet', slides: 'Slides' }[kind];
}
// PNG dimensions can be refused before asking Chromium to decode the compressed pixels.
export function checkImageHeader(bytes: Uint8Array): void {
  if (bytes.length >= 24 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(16) * view.getUint32(20) > 40_000_000) throw new Error(IMAGE_PIXEL_LIMIT);
  }
}
