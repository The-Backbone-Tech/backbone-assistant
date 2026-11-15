import assert from 'node:assert/strict';
import { test } from 'node:test';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { convertOffice, csvRows, boundedArchive } from '../src/components/files/office-converter.ts';
import { wordFixture, workbookFixture, slidesFixture, sharedStringWorkbookFixture, sizedWorkbookFixture, controlledWordFixture, sparseSheetsFixture } from '../e2e/preview-fixtures.ts';

test('Word keeps headings, lists, tables and embedded images as inert nodes', async () => {
  const value = await convertOffice('report.docx', wordFixture());
  const json = JSON.stringify(value);
  for (const text of ['Quarterly review', 'Harbor revenue', 'Follow up', 'North', '120', 'data:image/png']) assert.ok(json.includes(text), text);
  for (const tag of ['h1', 'ul', 'table']) assert.ok(json.includes(`"tag":"${tag}"`), tag);
  assert.ok(!json.includes('javascript:'));
  assert.ok(!json.includes('https:'));
});
test('Word models expose only safe element names, text and local raster image properties', async () => {
  const value = await convertOffice('report.docx', wordFixture());
  const json = JSON.stringify(value);
  assert.ok(!json.includes('javascript:'));
  assert.ok(!json.includes('https:'));
  assert.ok(!json.includes('href'));
  assert.ok(!json.includes('onclick'));
});
test('workbook conversion preserves sheets and cell coordinates', async () => {
  const value = await convertOffice('report.xlsx', workbookFixture());
  assert.equal(value.kind, 'sheet');
  if (value.kind !== 'sheet') throw new Error('Expected sheets');
  assert.deepEqual(value.sheets.map(s => s.name), ['Revenue', 'Forecast']);
  assert.deepEqual(value.sheets[0].rows, [['North', '120']]);
});
test('slides follow the presentation order with text and images interleaved', async () => {
  const value = await convertOffice('deck.pptx', slidesFixture());
  assert.equal(value.kind, 'slides');
  if (value.kind !== 'slides') throw new Error('Expected slides');
  assert.equal(value.slides.length, 2);
  assert.deepEqual(value.slides[0].map(n => typeof n === 'string' ? n : n.tag), ['p', 'img', 'p']);
  assert.match(JSON.stringify(value.slides[1]), /Next steps/);
});
test('CSV keeps quoted commas, newlines, escaped quotes and Unicode', () => {
  assert.deepEqual(csvRows('Region,Value\r\n"North, west","a""b"\r\n"España\nSur",12'), [['Region', 'Value'], ['North, west', 'a"b'], ['España\nSur', '12']]);
  assert.throws(() => csvRows('"unterminated'), /read/);
});
test('large sheets report omitted rows and never evaluate formulas', async () => {
  const value = await convertOffice('report.csv', strToU8('"=WEBSERVICE(""https://example.invalid"")"\n' + 'value\n'.repeat(1200)));
  assert.equal(value.kind, 'sheet');
  if (value.kind !== 'sheet') throw new Error('Expected sheets');
  assert.equal(value.sheets[0].rows.length, 1000);
  assert.equal(value.sheets[0].totalRows, undefined);
  assert.equal(value.sheets[0].partial, true);
  assert.equal(value.sheets[0].rows[0][0], '=WEBSERVICE("https://example.invalid")');
});
test('archive expansion is bounded by actual output and DTDs fail closed', async () => {
  assert.throws(() => boundedArchive(zipSync({ 'bomb.txt': new Uint8Array(17 * 1024 * 1024) })), /too large/);
  await assert.rejects(convertOffice('report.docx', zipSync({ 'word/document.xml': strToU8('<!DOCTYPE test [<!ENTITY x SYSTEM "https://example.invalid">]><test>&x;</test>') })), /read/);
  await assert.rejects(convertOffice('report.pptx', strToU8('invalid archive')), /read|zip/i);
});
test('a dense Word document is refused before its model can flood the renderer', async () => {
  const { unzipSync } = await import('fflate');
  const files = unzipSync(wordFixture());
  files['word/document.xml'] = strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + '<w:p><w:r><w:t>Many paragraphs</w:t></w:r></w:p>'.repeat(6000) + '</w:body></w:document>');
  await assert.rejects(convertOffice('dense.docx', zipSync(files)), /too large/);
});

test('a giant cell fails with its ceiling before text layout can stall the window', async () => {
  await assert.rejects(convertOffice('giant.csv', strToU8('a'.repeat(10001))), /cell limit is 10,000 characters/);
});
test('Word groups consecutive numbered items and honors numbering removal', async () => {
  const { unzipSync } = await import('fflate');
  const files = unzipSync(wordFixture());
  files['word/numbering.xml'] = strToU8(new TextDecoder().decode(files['word/numbering.xml']).replace('w:val="bullet"', 'w:val="decimal"'));
  const item = (text: string, id = '1') => `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${id}"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
  files['word/document.xml'] = strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + ['One', 'Two', 'Three'].map(text => item(text)).join('') + item('After the list', '0') + '</w:body></w:document>');
  const value = await convertOffice('numbered.docx', zipSync(files));
  assert.equal(value.kind, 'word');
  if (value.kind !== 'word') throw new Error('Expected Word');
  assert.deepEqual(value.nodes, [{ tag: 'ol', children: ['One', 'Two', 'Three'].map(text => ({ tag: 'li', children: [text] })) }, { tag: 'p', children: ['After the list'] }]);
});

test('a shared long string across 100 by 100 cells posts only a bounded partial view', async () => {
  const value = await convertOffice('shared.xlsx', sharedStringWorkbookFixture());
  assert.equal(value.kind, 'sheet');
  if (value.kind !== 'sheet') throw new Error('Expected sheets');
  assert.equal(value.sheets[0].partial, true);
  assert.equal(value.sheets[0].totalRows, 100);
  assert.equal(value.sheets[0].rows.flat().join('').length, 499950);
});
test('sheet text budget spans sheets and wide CSV, and cell output has a ceiling', async () => {
  assertBounded(await convertOffice('wide.csv', strToU8(Array.from({ length: 100 }, () => 'x'.repeat(6000)).join(','))));
  assertBounded(await convertOffice('cells.csv', strToU8(('x,'.repeat(99) + 'x\n').repeat(1000))));
  const files = unzipSync(workbookFixture());
  for (const n of [1, 2]) files[`xl/worksheets/sheet${n}.xml`] = strToU8('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + Array.from({ length: 30 }, (_, r) => `<row r="${r + 1}"><c r="A${r + 1}" t="inlineStr"><is><t>${'x'.repeat(9999)}</t></is></c></row>`).join('') + '</sheetData></worksheet>');
  const value = await convertOffice('two.xlsx', zipSync(files));
  assertBounded(value);
  if (value.kind === 'sheet') assert.equal(value.sheets[1].rows.length, 20);
});
test('actual archive lengths defeat forged local and directory size declarations', () => {
  const bytes = zipSync({ 'bomb.txt': new Uint8Array(17 * 1024 * 1024) });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < bytes.length - 46; i++) {
    if (view.getUint32(i, true) === 0x04034b50) view.setUint32(i + 22, 1, true);
    if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, 1, true);
  }
  assert.throws(() => boundedArchive(bytes), /too large/);
});
test('entity expansion inside an otherwise valid Word archive is refused', async () => {
  const files = unzipSync(wordFixture());
  files['word/document.xml'] = strToU8(new TextDecoder().decode(files['word/document.xml']).replace('<w:document', '<!DOCTYPE w:document [<!ENTITY a "expanded"><!ENTITY b "&a;&a;&a;">]><w:document').replace('Quarterly review', '&b;'));
  await assert.rejects(convertOffice('entities.docx', zipSync(files)), /read/);
});
test('Word preserves content controls, insertions, fields, smart tags and custom XML, excluding deletions', async () => {
  const files = unzipSync(wordFixture());
  const run = (text: string) => `<w:r><w:t>${text}</w:t></w:r>`;
  files['word/document.xml'] = strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:sdt><w:sdtContent><w:p>' + run('Block control') + '</w:p></w:sdtContent></w:sdt><w:p>' + ['sdt', 'ins', 'fldSimple', 'smartTag', 'customXml', 'del'].map(tag => `<w:${tag}>${tag === 'sdt' ? '<w:sdtContent>' : ''}${run(tag)}${tag === 'sdt' ? '</w:sdtContent>' : ''}</w:${tag}>`).join('') + '</w:p></w:body></w:document>');
  const result = JSON.stringify(await convertOffice('containers.docx', zipSync(files)));
  for (const text of ['Block control', 'sdt', 'ins', 'fldSimple', 'smartTag', 'customXml']) assert.ok(result.includes(text), text);
  assert.ok(!result.includes('"del"'));
});

test('an otherwise valid document rejects even unused entity declarations before the reader', async () => {
  const files = unzipSync(wordFixture());
  files['word/document.xml'] = strToU8(new TextDecoder().decode(files['word/document.xml']).replace('<w:document', '<!DOCTYPE w:document [<!ENTITY unused "safe">]><w:document'));
  await assert.rejects(convertOffice('declaration.docx', zipSync(files)), /read/);
});
test('External local-looking slide images remain absent from the inert output', async () => {
  const value = await convertOffice('hostile.pptx', slidesFixture());
  assert.equal(value.kind, 'slides');
  if (value.kind === 'slides') assert.equal(value.slides.flat().filter(n => typeof n === 'object' && n.tag === 'img').length, 1);
});

test('every Office fixture carries external image, script and link parts that stay out of its output', async () => {
  for (const [name, fixture] of [['hostile.docx', wordFixture], ['hostile.xlsx', workbookFixture], ['hostile.pptx', slidesFixture]] as const) {
    const files = unzipSync(fixture());
    const contents = Object.entries(files).filter(([name]) => /\.(xml|rels|js)$/.test(name)).map(([, data]) => new TextDecoder().decode(data)).join('');
    for (const marker of ['TargetMode="External"', 'https://preview-attack.invalid/tracker.png', 'javascript:', 'PREVIEW_ATTACK']) assert.ok(contents.includes(marker), name + ': ' + marker);
    const result = JSON.stringify(await convertOffice(name, fixture()));
    for (const marker of ['preview-attack.invalid', 'PREVIEW_ATTACK', 'javascript:']) assert.ok(!result.includes(marker), name + ': ' + marker);
  }
});

function assertBounded(value: Awaited<ReturnType<typeof convertOffice>>) {
  assert.equal(value.kind, 'sheet');
  if (value.kind !== 'sheet') throw new Error('Expected sheets');
  const cells = value.sheets.flatMap(s => s.rows.flat()).filter(Boolean);
  assert.ok(cells.length <= 20000);
  assert.ok(cells.join('').length <= 500000);
  assert.ok(value.sheets.some(s => s.partial));
}
test('ordinary large CSV and dense sheets return their first content instead of refusing', async () => {
  for (const bytes of [strToU8('x,y\n'.repeat(10001)), strToU8(('x'.repeat(6000) + '\n').repeat(100))]) {
    const value = await convertOffice('ordinary.csv', bytes);
    assertBounded(value);
    if (value.kind === 'sheet') assert.ok(value.sheets[0].rows.length > 0);
  }
  const value = await convertOffice('ordinary.xlsx', sizedWorkbookFixture(1000, 21));
  assertBounded(value);
  if (value.kind === 'sheet') {
    assert.equal(value.sheets[0].totalRows, 1000);
    assert.equal(value.sheets[0].rows.flat().filter(Boolean).length, 20000);
  }
});
test('empty spreadsheet coordinates do not consume the real content budget', async () => {
  const value = await convertOffice('sparse.xlsx', sizedWorkbookFixture(1000, 21, true));
  if (value.kind !== 'sheet') throw new Error('Expected sheets');
  assert.equal(value.sheets[0].rows.length, 1000);
  assert.equal(value.sheets[0].rows[999][20], 'value');
  assert.equal(value.sheets[0].partial, false);
});
test('Word content controls keep separate paragraphs and a contained table', async () => {
  const value = await convertOffice('control.docx', controlledWordFixture());
  if (value.kind !== 'word') throw new Error('Expected Word');
  assert.deepEqual(value.nodes.map(n => typeof n === 'string' ? n : n.tag), ['p', 'p', 'table']);
  assert.match(JSON.stringify(value.nodes[2]), /Table inside control/);
});
test('presentation-level External relationships never load a local-looking slide', async () => {
  const files = unzipSync(slidesFixture());
  files['ppt/_rels/presentation.xml.rels'] = strToU8(new TextDecoder().decode(files['ppt/_rels/presentation.xml.rels']).replace('Id="second"', 'Id="second" TargetMode="External"'));
  await assert.rejects(convertOffice('external.pptx', zipSync(files)), /read/);
});
test('Word skips an External relationship even when its target exists in the archive', async () => {
  const files = unzipSync(wordFixture());
  files['word/_rels/document.xml.rels'] = strToU8(new TextDecoder().decode(files['word/_rels/document.xml.rels']).replace('Id="image"', 'Id="image" TargetMode="External"'));
  const value = await convertOffice('external.docx', zipSync(files));
  assert.ok(!JSON.stringify(value).includes('data:image/'));
});

test('sparse coordinates keep both far cells without allocating empty rows or cells', async () => {
  const value = await convertOffice('sparse-sheets.xlsx', sparseSheetsFixture());
  if (value.kind !== 'sheet') throw new Error('Expected sheets');
  assert.deepEqual(value.sheets.map(s => s.rows.length), [1000, 1000]);
  assert.deepEqual(value.sheets.map(s => Object.keys(s.rows).length), [1, 1]);
  for (const sheet of value.sheets) {
    assert.equal(sheet.rows[999][99], 'value');
    assert.equal(Object.keys(sheet.rows[999]).length, 1);
    assert.equal(sheet.partial, false);
  }
});

test('empty row metadata does not allocate a blank preview grid', async () => {
  const files = unzipSync(workbookFixture());
  for (const n of [1, 2]) files[`xl/worksheets/sheet${n}.xml`] = strToU8('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1000"/></sheetData></worksheet>');
  const value = await convertOffice('empty-rows.xlsx', zipSync(files));
  if (value.kind !== 'sheet') throw new Error('Expected sheets');
  assert.deepEqual(value.sheets.map(s => s.rows.length), [0, 0]);
});

test('a CSV of exactly 1,000 rows followed by blank lines is whole, while a 1,001st row makes it partial', async () => {
  const rows = 'a,b\n'.repeat(1000);
  for (const tail of ['', '\n', '\n\n\n', '\r\n\r\n']) {
    const sheet = (await convertOffice('exact.csv', strToU8(rows + tail)) as { sheets: { rows: string[][]; partial?: boolean; totalRows?: number }[] }).sheets[0];
    assert.equal(sheet.rows.length, 1000, JSON.stringify(tail)); assert.equal(sheet.partial, false, JSON.stringify(tail)); assert.equal(sheet.totalRows, 1000);
  }
  const more = (await convertOffice('more.csv', strToU8(rows + '\n\nlast,row\n')) as { sheets: { rows: string[][]; partial?: boolean }[] }).sheets[0];
  assert.equal(more.rows.length, 1000); assert.equal(more.partial, true);
});
