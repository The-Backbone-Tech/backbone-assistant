// Runs only in the preview worker (and focused tests). Input is never executed.
import { Unzip, UnzipInflate, strFromU8, zipSync } from 'fflate';
import { DOMParser, type Element as DomXmlElement } from '@xmldom/xmldom';
import { openDocx, getParagraphStyle, contentControlBlocks, type WmlBlock, type WmlParagraph, type XmlElement } from '@office-kit/docx';
import { loadWorkbook } from '@office-kit/xlsx/io';
import type { CellValue } from '@office-kit/xlsx/cell';
import { READ_FAILURE, EXPANDED_PREVIEW_LIMIT as EXPANDED_MESSAGE, CELL_PREVIEW_LIMIT, MAX_SHEET_CELLS, MAX_TEXT_CHARACTERS, safeImage, type SafeNode, type OfficePreview, type SheetPreview } from './preview-boundary.ts';

const EXPANDED_LIMIT = 48 * 1024 * 1024;
// Render a maintained reader's model, never its raw XML passthrough nodes.
function raster(data: Uint8Array, mime: string): string | undefined {
  let raw = ''; for (const byte of data) raw += String.fromCharCode(byte);
  return safeImage(`data:${mime};base64,${btoa(raw)}`);
}
function wordNodes(files: Record<string, Uint8Array>): SafeNode[] {
  const doc = openDocx(zipSync(files));
  const rels = files['word/_rels/document.xml.rels'] ? elements(xml(files['word/_rels/document.xml.rels']), 'Relationship') : [];
  const localImages = new Map<string, string>();
  for (const rel of rels) {
    if (rel.getAttribute('TargetMode') === 'External') continue;
    const path = /^media\/([\w. -]+\.(png|jpe?g|gif|webp))$/i.exec(rel.getAttribute('Target') ?? '');
    if (!path || !files[`word/media/${path[1]}`]) continue;
    const src = raster(files[`word/media/${path[1]}`], `image/${path[2].replace(/^jpg$/i, 'jpeg').toLowerCase()}`);
    if (src) localImages.set(rel.getAttribute('Id')!, src);
  }
  const inline = (element: XmlElement): SafeNode[] => {
    if (element.name.local === 't') return element.children.flatMap(n => n.kind === 'text' || n.kind === 'cdata' ? [n.value] : []);
    if (element.name.local === 'blip') {
      const src = localImages.get(element.attrs.find(a => a.name.local === 'embed')?.value ?? '');
      return src ? [{ tag: 'img', src, children: [] }] : ['[Image unavailable]'];
    }
    if (element.name.local === 'br') return [{ tag: 'br', children: [] }];
    // Only known Word/drawing containers may carry text or embedded images.
    if (!['p', 'sdt', 'sdtContent', 'ins', 'fldSimple', 'smartTag', 'customXml', 'hyperlink', 'r', 'drawing', 'inline', 'anchor', 'graphic', 'graphicData', 'pic', 'blipFill', 'pict'].includes(element.name.local)) return [];
    return element.children.flatMap(n => n.kind === 'element' ? inline(n) : []);
  };
  const descendants = (node: XmlElement | undefined, name: string): XmlElement | undefined => {
    if (!node) return;
    if (node.name.local === name) return node;
    for (const child of node.children) if (child.kind === 'element') { const found = descendants(child, name); if (found) return found; }
  };
  const lists = new Map<string, string>();
  if (files['word/numbering.xml']) {
    const numbering = xml(files['word/numbering.xml']);
    for (const num of elements(numbering, 'num')) {
      const abstractId = elements(num, 'abstractNumId')[0]?.getAttribute('w:val');
      const abstract = elements(numbering, 'abstractNum').find(a => a.getAttribute('w:abstractNumId') === abstractId);
      lists.set(num.getAttribute('w:numId') ?? '', abstract && elements(abstract, 'numFmt')[0]?.getAttribute('w:val') === 'bullet' ? 'ul' : 'ol');
    }
  }
  const paragraph = (p: WmlParagraph): SafeNode => {
    const children: SafeNode[] = p.children.flatMap(child => {
      if (child.kind === 'raw') return inline(child.node);
      if (child.revision?.kind === 'del') return [];
      const content = child.pieces.flatMap<SafeNode>(piece => {
        if (piece.kind === 'text') return [piece.value];
        if (piece.kind === 'tab') return ['\t'];
        if (piece.kind === 'break') return [{ tag: 'br', children: [] }];
        if (piece.kind === 'drawing' || piece.kind === 'pict') return inline(piece.node);
        return [];
      });
      return descendants(child.rPr, 'b') ? [{ tag: 'strong', children: content }] : content;
    });
    const heading = /^Heading([1-6])$/i.exec(getParagraphStyle(p) ?? '');
    const numId = descendants(p.pPr, 'numId')?.attrs.find(a => a.name.local === 'val')?.value;
    if (numId && numId !== '0') return { tag: lists.get(numId) ?? 'ul', children: [{ tag: 'li', children }] };
    return { tag: heading ? `h${heading[1]}` : 'p', children };
  };
  const block = (b: WmlBlock): SafeNode[] => {
    if (b.kind === 'paragraph') return [paragraph(b)];
    if (b.kind === 'table') return [{ tag: 'table', children: [{ tag: 'tbody', children: b.rows.map(row => ({ tag: 'tr', children: row.cells.map(cell => ({ tag: 'td', children: blocks(cell.paragraphs) })) })) }] }];
    const controlled = contentControlBlocks(b);
    if (controlled) return blocks(controlled);
    const children = inline(b.node);
    return children.length ? [{ tag: 'p', children }] : [];
  };
  function blocks(items: readonly WmlBlock[]): SafeNode[] {
    const result: SafeNode[] = []; let previousList: string | undefined;
    for (const item of items) {
      const rendered = block(item), first = rendered[0], previous = result.at(-1);
      const numbered = typeof first === 'object' && (first.tag === 'ol' || first.tag === 'ul') && item.kind === 'paragraph';
      const id = numbered ? descendants(item.pPr, 'numId')?.attrs.find(a => a.name.local === 'val')?.value : undefined;
      const level = numbered ? descendants(item.pPr, 'ilvl')?.attrs.find(a => a.name.local === 'val')?.value ?? '0' : undefined;
      const key = id ? `${id}:${level}` : undefined;
      if (key && key === previousList && typeof first === 'object' && typeof previous === 'object' && first.tag === previous.tag) previous.children.push(...first.children);
      else result.push(...rendered);
      previousList = key;
    }
    return result;
  }
  return blocks(doc.document.body.blocks);
}
function rawCellText(value: CellValue | undefined): string {
  if (value === undefined || value === null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return String(value);
  if (value.kind === 'formula') return value.cachedValue === undefined ? `=${value.formula}` : String(value.cachedValue);
  if (value.kind === 'rich-text') return value.runs.map(run => run.text).join('');
  if (value.kind === 'error') return value.code;
  return String(value.ms);
}

function boundedCell(text: string): string {
  if (text.length > 10000) throw new Error(CELL_PREVIEW_LIMIT);
  return text;
}
// One budget belongs to the complete conversion, including all worksheets.
function sheetBudget() {
  let cells = 0, characters = 0, exhausted = false;
  return (text: string): boolean => {
    if (exhausted) return false;
    boundedCell(text);
    // Empty coordinates preserve placement without charging the content budget.
    if (!text) return true;
    if (cells === MAX_SHEET_CELLS || characters + text.length > MAX_TEXT_CHARACTERS) {
      exhausted = true; return false;
    }
    cells++; characters += text.length;
    return true;
  };
}

export function boundedArchive(bytes: Uint8Array): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = Object.create(null);
  let total = 0, count = 0;
  const unzip = new Unzip(file => {
    if (++count > 2000 || (file.originalSize ?? 0) > 16 * 1024 * 1024) throw new Error(EXPANDED_MESSAGE);
    if (Object.hasOwn(files, file.name)) throw new Error(READ_FAILURE);
    const chunks: Uint8Array[] = []; let size = 0;
    files[file.name] = new Uint8Array();
    file.ondata = (err, chunk, final) => {
      if (err) throw err;
      size += chunk.length; total += chunk.length;
      if (size > 16 * 1024 * 1024 || total > EXPANDED_LIMIT) throw new Error(EXPANDED_MESSAGE);
      chunks.push(chunk);
      if (final) {
        const result = new Uint8Array(size); let at = 0;
        for (const part of chunks) { result.set(part, at); at += part.length; }
        files[file.name] = result;
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for (let at = 0; at < bytes.length; at += 4096) unzip.push(bytes.subarray(at, at + 4096), at + 4096 >= bytes.length);
  return files;
}
function xml(bytes?: Uint8Array) {
  if (!bytes) throw new Error(READ_FAILURE);
  const text = strFromU8(bytes);
  // No DTDs/entities, external resolution or recovery from malformed XML.
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error(READ_FAILURE);
  return new DOMParser({ onError: () => { throw new Error(READ_FAILURE); } }).parseFromString(text, 'application/xml');
}
function elements(doc: ReturnType<typeof xml> | DomXmlElement, name: string) {
  return Array.from(doc.getElementsByTagNameNS('*', name));
}
function slidePreviews(files: Record<string, Uint8Array>): SafeNode[][] {
  const presentation = xml(files['ppt/presentation.xml']);
  const relations = elements(xml(files['ppt/_rels/presentation.xml.rels']), 'Relationship');
  return elements(presentation, 'sldId').map(slide => {
    const id = slide.getAttribute('r:id');
    const rel = relations.find(r => r.getAttribute('Id') === id && r.getAttribute('TargetMode') !== 'External');
    const path = rel?.getAttribute('Target')?.replace(/^\/?ppt\//, '').replace(/^\.\//, '');
    if (!path || path.includes('..')) throw new Error(READ_FAILURE);
    const name = `ppt/${path}`;
    const doc = xml(files[name]);
    const links = files[`ppt/slides/_rels/${path.split('/').at(-1)}.rels`];
    const images = links ? elements(xml(links), 'Relationship') : [];
    const tree = elements(doc, 'spTree')[0];
    if (!tree) throw new Error(READ_FAILURE);
    const nodes: SafeNode[] = [];
    // Preserve XML shape order, including groups, rather than appending images after text.
    const walk = (parent: typeof tree) => {
      for (const child of Array.from(parent.childNodes)) {
        if (child.nodeType !== 1) continue;
        const element = child as typeof tree;
        if (element.localName === 'p') {
          nodes.push({ tag: 'p', children: elements(element, 't').map(t => t.textContent ?? '') });
        } else if (element.localName === 'blip') {
          const rel = images.find(r => r.getAttribute('Id') === element.getAttribute('r:embed') && r.getAttribute('TargetMode') !== 'External');
          const target = rel?.getAttribute('Target');
          const match = /^(?:\.\.\/)?media\/([\w. -]+\.(png|jpe?g|gif|webp))$/i.exec(target ?? '');
          const data = match && files[`ppt/media/${match[1]}`];
          if (data) {
            let raw = ''; for (const byte of data) raw += String.fromCharCode(byte);
            const src = safeImage(`data:image/${match[2].replace(/^jpg$/i, 'jpeg').toLowerCase()};base64,${btoa(raw)}`);
            if (src) nodes.push({ tag: 'img', src, children: [] });
          }
        } else walk(element);
      }
    };
    walk(tree); return nodes;
  });
}
function csvSheet(text: string): SheetPreview {
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false, column = 0, totalColumns = 0, omittedColumns = false, incompleteRow = false;
  const accept = sheetBudget();
  const result = (partial: boolean, partialRow = false): SheetPreview => ({ name: 'Sheet 1', rows, totalRows: partial ? undefined : rows.length, totalColumns, partial: partial || omittedColumns, partialRow });
  const finishCell = () => {
    totalColumns = Math.max(totalColumns, column + 1);
    if (column < 100) {
      if (!accept(cell)) { incompleteRow = row.length > 0; if (incompleteRow) rows.push(row); return false; }
      row.push(cell);
    } else omittedColumns = true;
    column++; cell = ''; return true;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { if (column < 100) cell += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && (c === ',' || c === '\n' || c === '\r')) {
      if (!finishCell()) return result(true, incompleteRow);
      if (c !== ',') {
        rows.push(row); row = []; column = 0;
        if (c === '\r' && text[i + 1] === '\n') i++;
        // Blank lines after row 1,000 are not more data: the sheet is whole, not partial.
        if (rows.length === 1000 && i < text.length - 1) return /[^\r\n]/.test(text.slice(i + 1)) ? result(true) : result(false);
      }
    } else if (column < 100) cell += c;
    if (cell.length > 10000) throw new Error(CELL_PREVIEW_LIMIT);
  }
  if (quoted) throw new Error(READ_FAILURE);
  if (cell || column) { if (!finishCell()) return result(true, incompleteRow); rows.push(row); }
  return result(false);
}
export function csvRows(text: string): string[][] { return csvSheet(text).rows; }
function boundedNodes(nodes: SafeNode[]): SafeNode[] {
  let count = 0, characters = 0, textCharacters = 0;
  const walk = (list: SafeNode[], depth: number) => {
    if (depth > 100) throw new Error(EXPANDED_MESSAGE);
    for (const node of list) {
      if (++count > 10000) throw new Error(EXPANDED_MESSAGE);
      if (typeof node === 'string') { characters += node.length; textCharacters += node.length; }
      else { characters += node.src?.length ?? 0; walk(node.children, depth + 1); }
      if (characters > 8 * 1024 * 1024 || textCharacters > MAX_TEXT_CHARACTERS) throw new Error(EXPANDED_MESSAGE);
    }
  };
  walk(nodes, 0); return nodes;
}
export async function convertOffice(name: string, bytes: Uint8Array): Promise<OfficePreview> {
  if (/\.csv$/i.test(name)) {
    return { kind: 'sheet', sheets: [csvSheet(new TextDecoder('utf-8', { fatal: true }).decode(bytes))] };
  }
  const files = boundedArchive(bytes);
  let elementCount = 0;
  for (const [path, data] of Object.entries(files)) if (/\.(xml|rels)$/i.test(path)) {
    const markup = strFromU8(data);
    elementCount += (markup.match(/</g) ?? []).length;
    if (elementCount > 200000) throw new Error(EXPANDED_MESSAGE);
    if (/<!DOCTYPE|<!ENTITY/i.test(markup)) throw new Error(READ_FAILURE);
  }
  // The converters get a rebuilt archive with verified actual lengths, never forged ZIP sizes.
  if (/\.docx$/i.test(name)) {
    xml(files['word/document.xml']);
    return { kind: 'word', nodes: boundedNodes(wordNodes(files)) };
  }
  if (/\.pptx$/i.test(name)) {
    const slides = slidePreviews(files);
    if (slides.length > 200) throw new Error(EXPANDED_MESSAGE);
    boundedNodes(slides.flat());
    return { kind: 'slides', slides };
  }
  if (!files['xl/workbook.xml']) throw new Error(READ_FAILURE);
  for (const [path, data] of Object.entries(files)) if (/^xl\/worksheets\/.*\.xml$/.test(path)) {
    const text = strFromU8(data);
    // Bound sparse indices before the reader constructs its model.
    for (const m of text.matchAll(/\br="([A-Z]*)(\d+)"/g)) if (Number(m[2]) > 50000 || m[1].length > 3) throw new Error(EXPANDED_MESSAGE);
  }
  const accept = sheetBudget();
  const workbook = await loadWorkbook({ toBytes: async () => zipSync(files) }, { contentLimits: { maxCells: 100000, maxRows: 50000 }, decompressionLimits: { maxEntryUncompressedBytes: 16 * 1024 * 1024, maxTotalUncompressedBytes: EXPANDED_LIMIT } });
  return { kind: 'sheet', sheets: workbook.sheets.flatMap(ref => {
    if (ref.kind !== 'worksheet') return [];
    const sheet = ref.sheet;
    let totalRows = 0, totalColumns = 0;
    for (const [r, row] of sheet.rows) { totalRows = Math.max(totalRows, r); for (const c of row.keys()) totalColumns = Math.max(totalColumns, c); }
    const rows: string[][] = [];
    let partialRow = false, stopped = false;
    // Keep the reader's sparse coordinates sparse. Empty grid slots never become
    // output cells or row arrays; the renderer fills only its bounded window.
    outer: for (const [r, cells] of [...sheet.rows].sort(([a], [b]) => a - b)) {
      if (r > 1000) continue;
      for (const [c, cell] of [...cells].sort(([a], [b]) => a - b)) {
        if (c > 100) continue;
        const text = rawCellText(cell.value);
        if (!text) continue;
        if (!accept(text)) { stopped = true; partialRow = Boolean(rows[r - 1]); break outer; }
        (rows[r - 1] ??= [])[c - 1] = text;
      }
    }
    if (!stopped) rows.length = Math.min(totalRows, 1000);
    return [{ name: sheet.title, totalRows, totalColumns, rows, partial: rows.length < totalRows || totalColumns > 100 || partialRow, partialRow }];
  }) };
}
