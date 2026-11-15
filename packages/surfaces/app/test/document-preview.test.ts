import assert from 'node:assert/strict';
import { test } from 'node:test';
import { previewKind, previewBytes, MAX_PREVIEW_BYTES, safeImage, previewTag, previewErrorMessage, CELL_PREVIEW_LIMIT, checkImageHeader, IMAGE_PIXEL_LIMIT, PDF_PAGE_LIMIT, PDF_CANVAS_LIMIT, EXPANDED_PREVIEW_LIMIT, PREVIEW_LIMIT, READ_FAILURE, previewRefusal, previewKindLabel } from '../src/components/files/preview-boundary.ts';

test('preview classification takes precedence over text MIME types', () => {
  assert.equal(previewKind('sales.csv'), 'sheet');
  assert.equal(previewKind('drawing.SVG'), 'image');
  assert.equal(previewKind('report.docx'), 'word');
  assert.equal(previewKind('deck.pptx'), 'slides');
  assert.equal(previewKind('report.pdf'), 'pdf');
  assert.equal(previewKind('program.exe'), undefined);
});
test('preview bytes reject oversized and malformed inputs before decoding', () => {
  assert.throws(() => previewBytes('a'.repeat(Math.ceil(MAX_PREVIEW_BYTES / 3) * 4 + 4)), /20 MB/);
  assert.throws(() => previewBytes('%%%'), /read/);
  assert.deepEqual(previewBytes('aGk='), new TextEncoder().encode('hi'));
});
test('embedded Office images allow only bounded raster data, never URLs or SVG', () => {
  assert.equal(safeImage('https://example.invalid/tracker.png'), undefined);
  assert.equal(safeImage('data:image/svg+xml;base64,PHN2Zy8+'), undefined);
  assert.equal(safeImage('data:image/png;base64,aGk='), 'data:image/png;base64,aGk=');
});

test('the renderer boundary refuses active markup even if a converter returns it', () => {
  for (const tag of ['script', 'iframe', 'style', 'a', 'svg', 'object', 'img onerror=attack()']) assert.equal(previewTag(tag), undefined);
  assert.equal(previewTag('h1'), 'h1');
  assert.equal(previewTag('img'), 'img');
});

test('untrusted parser details cannot become trusted preview messages', () => {
  assert.match(previewErrorMessage(new Error('untrusted filename too large <script>attack()</script>')), /^This file could not be read\./);
  assert.match(previewErrorMessage('untrusted parser exception'), /^This file could not be read\./);
  assert.equal(previewErrorMessage(new Error(CELL_PREVIEW_LIMIT)), CELL_PREVIEW_LIMIT);
});

test('size refusal classification is separate from explicit recovery controls', () => {
  for (const message of [IMAGE_PIXEL_LIMIT, PDF_PAGE_LIMIT, PDF_CANVAS_LIMIT, EXPANDED_PREVIEW_LIMIT, PREVIEW_LIMIT, CELL_PREVIEW_LIMIT]) assert.equal(previewRefusal(message), true);
  assert.equal(previewRefusal(READ_FAILURE), false);
});
test('PNG dimension ceiling is checked from bytes before image decoding', () => {
  const bytes = new Uint8Array(24); bytes.set([137, 80, 78, 71]);
  const view = new DataView(bytes.buffer); view.setUint32(16, 100000); view.setUint32(20, 100000);
  assert.throws(() => checkImageHeader(bytes), /40 million pixels/);
  view.setUint32(16, 160); view.setUint32(20, 72);
  assert.doesNotThrow(() => checkImageHeader(bytes));
});
test('every supported kind has a plain header label', () => {
  assert.deepEqual(['image', 'pdf', 'word', 'sheet', 'slides'].map(k => previewKindLabel(k as Parameters<typeof previewKindLabel>[0])), ['Image', 'PDF', 'Word document', 'Spreadsheet', 'Slides']);
});
