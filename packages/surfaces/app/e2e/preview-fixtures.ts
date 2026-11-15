// Synthetic, minimal Office and PDF files. No customer documents or network sources.
import { zipSync, unzipSync, strToU8 } from 'fflate';
// A generated 160 by 72 pixel diagram makes embedded images visible in screenshots.
export const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAKAAAABICAIAAAD+ummVAAAAzklEQVR4nO3RsQmAMAAAwUzjZNaZ20pwAzewCIj4HNwADz+O6yRsfF7AqwyOMzjO4DiD4wyOMzjO4Linwdvc+QuD4wyOMzjO4DiD4wyOMzjO4DiD4wyOMzjO4DiD4wyOMzjO4DiD4wyOMzjO4DiD4wyOMzjO4DiD4wyOMzjO4DiD4wyOMzjO4DiD4wyOMzjO4DiD4wyOMzjO4DiD4wyOMzjO4DiD4wyOMzjO4DiD4wyOMzjO4DiD4wyOWxlMgMFxBscZHGdwnMFxBscZHHcDV1tudc3Hv7gAAAAASUVORK5CYII=';
const archive = (files: Record<string, string | Uint8Array>) => Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, typeof value === 'string' ? strToU8(value) : value]))));
export function wordFixture() {
  return archive({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly review</w:t></w:r></w:p><w:p><w:r><w:t>Harbor revenue increased.</w:t></w:r></w:p><w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Follow up with the team</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>North</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>120</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:hyperlink r:id="bad"><w:r><w:t>Suspicious link shown as text</w:t></w:r></w:hyperlink></w:p><w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="image"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p><w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="remote"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p></w:body></w:document>`,
    'word/styles.xml': '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>',
    'word/numbering.xml': '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>',
    'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="bad" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:console.error(\'PREVIEW_ATTACK\')" TargetMode="External"/><Relationship Id="image" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/pixel.png"/><Relationship Id="remote" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://preview-attack.invalid/tracker.png" TargetMode="External"/></Relationships>',
    'word/media/pixel.png': Buffer.from(PIXEL, 'base64'),
  });
}
// Each Office fixture includes inert script bytes, remote image/link relationships,
// and a local-looking External target that makes removing the relationship guard observable.
function hostileArchive(input: Record<string, string | Uint8Array>, root: 'xl' | 'ppt') {
  const files = { ...input };
  files[`${root}/scripts/attack.js`] = 'console.error("PREVIEW_ATTACK"); parent.__previewAttack=true;';
  const path = root === 'ppt' ? 'ppt/slides/_rels/slide2.xml.rels' : 'xl/worksheets/_rels/sheet1.xml.rels';
  const relationships = '<Relationship Id="remote" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://preview-attack.invalid/tracker.png" TargetMode="External"/><Relationship Id="evil" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:PREVIEW_ATTACK" TargetMode="External"/><Relationship Id="external-local" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/poison.png" TargetMode="External"/>';
  files[path] = String(files[path] ?? '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>').replace('</Relationships>', relationships + '</Relationships>');
  files[`${root}/media/poison.png`] = Buffer.from(PIXEL, 'base64');
  return archive(files);
}
export function workbookFixture() {
  const files = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Revenue" sheetId="1" r:id="rId1"/><sheet name="Forecast" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>North</t></is></c><c r="B1"><v>120</v></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet2.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Next quarter</t></is></c></row></sheetData></worksheet>',
  };
  files['xl/worksheets/sheet1.xml'] = files['xl/worksheets/sheet1.xml'].replace('</worksheet>', '<hyperlinks><hyperlink ref="A1" location="javascript:PREVIEW_ATTACK"/></hyperlinks></worksheet>');
  return hostileArchive(files, 'xl');
}
export function slidesFixture() {
  const files = {
    'ppt/presentation.xml': '<p:presentation xmlns:p="urn:p" xmlns:r="urn:r"><p:sldIdLst><p:sldId id="256" r:id="second"/><p:sldId id="257" r:id="first"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="first" Target="slides/slide1.xml"/><Relationship Id="second" Target="slides/slide2.xml"/></Relationships>',
    'ppt/slides/slide2.xml': '<p:sld xmlns:p="urn:p" xmlns:a="urn:a" xmlns:r="urn:r"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Harbor launch</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:blipFill><a:blip r:embed="image"/></p:blipFill></p:pic><p:sp><p:txBody><a:p><a:r><a:t>After the image</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:blipFill><a:blip r:embed="external-local"/></p:blipFill></p:pic><p:pic><p:blipFill><a:blip r:embed="remote"/></p:blipFill></p:pic><a:hlinkClick r:id="evil"/></p:spTree></p:cSld></p:sld>',
    'ppt/slides/slide1.xml': '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Next steps</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
    'ppt/slides/_rels/slide2.xml.rels': '<Relationships><Relationship Id="image" Target="../media/pixel.png"/></Relationships>',
    'ppt/media/pixel.png': Buffer.from(PIXEL, 'base64'),
  };
  return hostileArchive(files, 'ppt');
}
export function pdfFixture(pages = 2, size: [number, number] = [612, 792]) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R /OpenAction 4 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /S /JavaScript /JS (console.error("PREVIEW_ATTACK")) >>', '<< /Type /Annot /Subtype /Link /Rect [40 680 350 730] /A << /S /URI /URI (https://preview-attack.invalid/link) >> >>', '<< /Type /Filespec /FS /URL /F (https://preview-attack.invalid/remote.pdf) >>'];
  const kids: string[] = [];
  for (let i = 0; i < pages; i++) {
    const page = objects.length + 1; kids.push(`${page} 0 R`);
    const content = `BT /F1 24 Tf 50 ${size[1] - 92} Td (${i === 0 ? 'Harbor PDF review' : i === 1 ? 'Second page' : 'Extra page'}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${size[0]} ${size[1]}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${page + 1} 0 R /Annots [5 0 R] /Ref << /F 6 0 R /Page 0 >> >>`, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`;
  // A remote document reference is retained as an external file specification, never fetched.
  objects[0] = objects[0].replace(' >>', ' /Names << /EmbeddedFiles << /Names [(remote) 6 0 R] >> >> >>');
  let text = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(text.length); text += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const start = text.length;
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(text);
}
export const maliciousSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="120"><script>console.error("PREVIEW_ATTACK"); parent.__previewAttack=true;</script><image href="https://preview-attack.invalid/tracker.png"/><a href="javascript:console.error(\'PREVIEW_ATTACK\')"><rect width="180" height="120" fill="teal"/></a></svg>');

export function emptyWordFixture() {
  const files = unzipSync(wordFixture());
  files['word/document.xml'] = strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>');
  return Buffer.from(zipSync(files));
}
export function emptySlidesFixture() {
  const files = unzipSync(slidesFixture());
  files['ppt/presentation.xml'] = strToU8('<p:presentation xmlns:p="urn:p"><p:sldIdLst/></p:presentation>');
  return Buffer.from(zipSync(files));
}

export function sharedStringWorkbookFixture() {
  const files = unzipSync(workbookFixture());
  files['xl/sharedStrings.xml'] = strToU8('<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>' + 'x'.repeat(9999) + '</t></si></sst>');
  const col = (n: number): string => n < 26 ? String.fromCharCode(65 + n) : col(Math.floor(n / 26) - 1) + col(n % 26);
  files['xl/worksheets/sheet1.xml'] = strToU8('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + Array.from({ length: 100 }, (_, r) => `<row r="${r + 1}">` + Array.from({ length: 100 }, (_, c) => `<c r="${col(c)}${r + 1}" t="s"><v>0</v></c>`).join('') + '</row>').join('') + '</sheetData></worksheet>');
  files['xl/worksheets/sheet2.xml'] = strToU8('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1000"><c r="CV1000" t="inlineStr"><is><t>Next quarter</t></is></c></row></sheetData></worksheet>');
  return Buffer.from(zipSync(files));
}

export function sizedWorkbookFixture(rows: number, columns: number, sparse = false) {
  const files = unzipSync(workbookFixture());
  const col = (n: number): string => n < 26 ? String.fromCharCode(65 + n) : col(Math.floor(n / 26) - 1) + col(n % 26);
  files['xl/worksheets/sheet1.xml'] = strToU8('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + Array.from({ length: rows }, (_, r) => `<row r="${r + 1}">` + Array.from({ length: columns }, (_, c) => sparse && c !== columns - 1 ? '' : `<c r="${col(c)}${r + 1}" t="inlineStr"><is><t>value</t></is></c>`).join('') + '</row>').join('') + '</sheetData></worksheet>');
  return Buffer.from(zipSync(files));
}
export function controlledWordFixture() {
  const files = unzipSync(wordFixture());
  const p = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
  files['word/document.xml'] = strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:sdt><w:sdtContent>' + p('First paragraph') + p('Second paragraph') + '<w:tbl><w:tr><w:tc>' + p('Table inside control') + '</w:tc></w:tr></w:tbl></w:sdtContent></w:sdt></w:body></w:document>');
  return Buffer.from(zipSync(files));
}

export function sparseSheetsFixture() {
  const files = unzipSync(workbookFixture());
  const sheet = strToU8('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1000"><c r="CV1000" t="inlineStr"><is><t>value</t></is></c></row></sheetData></worksheet>');
  files['xl/worksheets/sheet1.xml'] = sheet;
  files['xl/worksheets/sheet2.xml'] = sheet;
  return Buffer.from(zipSync(files));
}
