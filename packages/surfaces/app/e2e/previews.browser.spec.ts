import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { removeDataHome } from '@backbone-next/platform/composition';
import { startBridge, stopBridge } from './bridge';
import { api, closePaneOnNarrow, closeSidebar, narrow, openSidebar } from './journey';
import { emptySlidesFixture, emptyWordFixture, maliciousSvg, pdfFixture, PIXEL, slidesFixture, wordFixture, workbookFixture, sharedStringWorkbookFixture, sizedWorkbookFixture, controlledWordFixture, sparseSheetsFixture } from './preview-fixtures';

async function setup(page: Page) {
  const folder = freshDataHome('preview');
  const bridge = await startBridge(folder, { BACKBONE_HARNESS: 'stub' });
  try {
  await page.goto(bridge.url);
  await expect(page.locator('[data-ready=true]')).toBeVisible();
  await openSidebar(page);
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Document review');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('navigation').getByRole('button', { name: 'Document review', exact: true })).toBeVisible();
  await closeSidebar(page);
  const projects = await api<{ id: string; name: string }[]>(page, 'projects.list', {});
  const id = projects.find(p => p.name === 'Document review')!.id;
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Please review the documents beside this conversation.');
  await page.getByRole('textbox', { name: 'Message', exact: true }).press('Enter');
  await expect(page.getByTestId('work-block').first()).toContainText('Worked for');
  return { id, end: async () => { await stopBridge(bridge.proc); await removeDataHome(folder); } };
  } catch (error) { await stopBridge(bridge.proc); await removeDataHome(folder); throw error; }
}
async function attach(page: Page, projectId: string, name: string, bytes: Buffer, mediaType = 'application/octet-stream') {
  const result = await api<{ ok: boolean }>(page, 'material.attach', { projectId, name, base64: bytes.toString('base64'), mediaType });
  expect(result.ok).toBe(true);
}
async function openFile(page: Page, name: string) {
  await page.keyboard.press('ControlOrMeta+p');
  const row = page.getByTestId('file-row').filter({ hasText: name });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByTestId('file-tab').filter({ visible: true })).toBeVisible();
}
const fileTab = (page: Page) => page.getByTestId('file-tab').filter({ visible: true });

test('every supported document renders beside a conversation with inert content and keyboard controls', async ({ page, context }, info) => {
  const { id, end } = await setup(page);
  const attacks: string[] = [], remoteRequests: string[] = [], pdfRequests: string[] = [];
  context.on('request', request => { if (/PdfPreview-|pdf\.worker/.test(request.url())) pdfRequests.push(request.url()); });
  context.on('request', request => { if (new URL(request.url()).hostname === 'preview-attack.invalid') remoteRequests.push(request.url()); });
  page.on('console', message => { if (message.text().includes('PREVIEW_ATTACK')) attacks.push(message.text()); });
  const dir = process.env.BACKBONE_PREVIEW_SCREENSHOTS;
  if (dir) mkdirSync(dir, { recursive: true });
  const shot = async (name: string) => { if (dir) await page.screenshot({ path: join(dir, `${info.project.name}-${name}.png`) }); };
  try {
    const longName = 'diagram-with-a-long-filename-that-remains-identifiable-in-the-document-tab.svg';
    await attach(page, id, longName, maliciousSvg, 'image/svg+xml');
    await openFile(page, longName);
    const image = fileTab(page).getByRole('img', { name: longName, exact: true });
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(180);
    const actual = fileTab(page).getByRole('button', { name: 'Actual size', exact: true });
    await actual.focus(); await page.keyboard.press('Enter');
    await expect(actual).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('tab', { name: longName, exact: true })).toHaveAttribute('title', `${longName} · v1`);
    await shot('image');
    // PNG, JPEG, GIF and WebP all take the same inert image path.
    const generated = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 2400; canvas.height = 1600; canvas.getContext('2d')!.fillRect(0, 0, 2400, 1600); return [canvas.toDataURL('image/jpeg'), canvas.toDataURL('image/webp')]; });
    for (const [name, data] of [['pixel.png', PIXEL], ['pixel.gif', 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'], ['pixel.jpeg', generated[0].split(',')[1]], ['pixel.webp', generated[1].split(',')[1]]]) {
      await attach(page, id, name, Buffer.from(data, 'base64'));
      await openFile(page, name);
      await expect.poll(() => fileTab(page).getByRole('img', { name, exact: true }).evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
      if (name === 'pixel.jpeg') {
        const large = fileTab(page).getByRole('img', { name, exact: true });
        expect((await large.boundingBox())!.width).toBeLessThanOrEqual((await fileTab(page).boundingBox())!.width);
        await fileTab(page).getByRole('button', { name: 'Actual size', exact: true }).click();
        await expect.poll(async () => (await large.boundingBox())!.width).toBe(2400);
        await fileTab(page).getByRole('button', { name: 'Fit to pane', exact: true }).click();
        await expect.poll(async () => (await large.boundingBox())!.width).toBeLessThan(2400);
      }
    }
    expect(pdfRequests).toEqual([]);
    await attach(page, id, 'review.pdf', pdfFixture(), 'application/pdf');
    await openFile(page, 'review.pdf');
    await expect(fileTab(page).locator('.textLayer')).toContainText(['Harbor PDF review', '']);
    await expect(fileTab(page).getByRole('group', { name: 'PDF controls' })).toContainText('of 2');
    const zoom = fileTab(page).getByLabel('PDF zoom', { exact: true });
    await zoom.focus();
    await expect(zoom).toBeFocused();
    await zoom.selectOption('0.75');
    await expect(fileTab(page).locator('canvas').first()).toHaveAttribute('width', '459');
    await fileTab(page).getByRole('button', { name: 'Next page', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(fileTab(page).locator('.textLayer').nth(1)).toContainText('Second page');
    await expect.poll(() => fileTab(page).locator('.textLayer').nth(1).evaluate(el => { const selection = window.getSelection()!; const range = document.createRange(); range.selectNodeContents(el); selection.removeAllRanges(); selection.addRange(range); return selection.toString(); })).toContain('Second page');
    await expect(fileTab(page).getByRole('link')).toHaveCount(0);
    await shot('pdf');
    await attach(page, id, 'review.docx', wordFixture());
    await openFile(page, 'review.docx');
    await expect(fileTab(page).getByRole('heading', { name: 'Quarterly review' })).toBeVisible();
    await expect(fileTab(page).locator('li')).toContainText('Follow up');
    await expect(fileTab(page).getByRole('cell', { name: 'North', exact: true })).toBeVisible();
    await expect(fileTab(page).getByRole('img', { name: 'Embedded document image' })).toBeVisible();
    await expect(fileTab(page).getByRole('link')).toHaveCount(0);
    await shot('word');
    await attach(page, id, 'revenue.xlsx', workbookFixture());
    await openFile(page, 'revenue.xlsx');
    await expect(fileTab(page).getByRole('cell', { name: 'North', exact: true })).toBeVisible();
    await expect(fileTab(page).getByRole('link')).toHaveCount(0);
    await expect(fileTab(page)).toContainText('Spreadsheet');
    await shot('workbook');
    await fileTab(page).getByRole('tab', { name: 'Revenue', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(fileTab(page).getByRole('cell', { name: 'Next quarter', exact: true })).toBeVisible();
    await attach(page, id, 'revenue.csv', Buffer.from('Region,Value\n"North, west",120\n' + 'South,95\n'.repeat(1200)), 'text/csv');
    await openFile(page, 'revenue.csv');
    await expect(fileTab(page).getByRole('cell', { name: 'North, west', exact: true })).toBeVisible();
    await expect(fileTab(page)).toContainText('Showing the first 1000 rows');
    await fileTab(page).getByRole('button', { name: 'Next rows', exact: true }).click();
    await expect(fileTab(page)).toContainText('Rows 101–200');
    expect(await fileTab(page).locator('tbody tr').count()).toBe(100);
    await shot('csv');
    await attach(page, id, 'formula.csv', Buffer.from('=WEBSERVICE(https://preview-attack.invalid),literal'), 'text/csv');
    await openFile(page, 'formula.csv');
    await expect(fileTab(page).getByRole('cell', { name: '=WEBSERVICE(https://preview-attack.invalid)', exact: true })).toBeVisible();
    await attach(page, id, 'columns.csv', Buffer.from(Array.from({ length: 100 }, (_, i) => `Column ${i}`).join(',') + '\n' + Array.from({ length: 100 }, () => 'value').join(',')), 'text/csv');
    await openFile(page, 'columns.csv');
    await expect(fileTab(page).getByRole('cell')).toHaveCount(20);
    await fileTab(page).getByRole('button', { name: 'Next columns', exact: true }).click();
    await expect(fileTab(page).getByRole('cell', { name: 'Column 10', exact: true })).toBeVisible();
    await attach(page, id, 'launch.pptx', slidesFixture());
    await openFile(page, 'launch.pptx');
    await expect(fileTab(page).getByRole('region', { name: 'Slide 1', exact: true })).toContainText('Harbor launch');
    await expect(fileTab(page).getByRole('region', { name: 'Slide 2', exact: true })).toContainText('Next steps');
    await expect(fileTab(page).getByRole('img', { name: 'Embedded document image' })).toHaveCount(1);
    await expect(fileTab(page).getByRole('link')).toHaveCount(0);
    await shot('slides');
    expect(remoteRequests).toEqual([]); expect(attacks).toEqual([]);
    expect(await page.evaluate(() => '__previewAttack' in window)).toBe(false);
    // The pane remains reachable when narrow; closing a file restores a useful focus target.
    await page.getByRole('button', { name: 'Close launch.pptx', exact: true }).click();
    await expect(page.getByRole('tablist', { name: 'Pane tabs', exact: true }).locator('[aria-selected=true]')).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (narrow(page)) { await closePaneOnNarrow(page); await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible(); }
  } finally { await end(); }
});

test('oversized, malformed and unsupported files retain Download and explicit retry', async ({ page }) => {
  const { id, end } = await setup(page);
  try {
    const huge = Buffer.alloc(20 * 1024 * 1024 + 1);
    await attach(page, id, 'large.png', huge);
    await openFile(page, 'large.png');
    await expect(fileTab(page).getByRole('alert')).toContainText('preview limit is 20 MB');
    await expect(fileTab(page).getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
    const downloadEvent = page.waitForEvent('download');
    await fileTab(page).getByRole('button', { name: 'Download', exact: true }).click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe('large.png');
    expect(readFileSync((await download.path())!).equals(huge)).toBe(true);
    await attach(page, id, 'broken.docx', Buffer.from('not a zip'));
    await openFile(page, 'broken.docx');
    await expect(fileTab(page).getByRole('alert')).toContainText('could not be read');
    await fileTab(page).getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(fileTab(page).getByRole('alert')).toContainText('could not be read');
    await expect(fileTab(page).getByRole('button', { name: 'Download', exact: true })).toBeEnabled();
    await attach(page, id, 'unknown.bin', Buffer.from('opaque bytes'));
    await openFile(page, 'unknown.bin');
    await expect(fileTab(page)).toContainText('This file type has no preview.');
    await expect(fileTab(page)).toContainText('application/octet-stream');
    await expect(fileTab(page).getByRole('button', { name: 'Download', exact: true })).toBeEnabled();
    await attach(page, id, 'empty.docx', emptyWordFixture());
    await openFile(page, 'empty.docx');
    await expect(fileTab(page)).toContainText('No supported document content could be previewed.');
    await expect(fileTab(page).getByRole('button', { name: 'Download', exact: true })).toBeEnabled();
    await attach(page, id, 'empty.pptx', emptySlidesFixture());
    await openFile(page, 'empty.pptx');
    await expect(fileTab(page)).toContainText('This deck has no slides to preview.');
    await expect(fileTab(page).getByRole('button', { name: 'Download', exact: true })).toBeEnabled();
  } finally { await end(); }
});


const repairExpect = expect.configure({ timeout: 8000 });
async function repairScreenshot(page: Page, project: string, name: string) {
  const dir = process.env.BACKBONE_PREVIEW_SCREENSHOTS;
  if (dir) { mkdirSync(dir, { recursive: true }); await page.screenshot({ path: join(dir, `${project}-${name}.png`) }); }
}
test('CSV keeps saved grid, editable drafts, versioned Save and matching Download', async ({ page }, info) => {
  const { id, end } = await setup(page);
  try {
    const attached = await api<any>(page, 'material.attach', { projectId: id, name: 'editable.csv', base64: Buffer.from('Region,Value\nSaved,1').toString('base64'), mediaType: 'text/csv' });
    const entry = { ...attached.value, class: 'working' };
    let saved = 'Region,Value\nSaved,1';
    const readVersions: (number | undefined)[] = [];
    // Controlled working-file transport; the real renderer owns editing, draft custody and downloads.
    await page.route('**/api', async route => {
      const body = route.request().postDataJSON();
      if (body.args?.id !== entry.id) return route.continue();
      if (body.method === 'material.read') { readVersions.push(body.args.version); return route.fulfill({ json: { ok: true, value: { entry, text: saved } } }); }
      if (body.method === 'material.save') {
        repairExpect(body.args.baseVersion).toBe(entry.current);
        saved = body.args.text; entry.current++;
        entry.versions.push({ n: entry.current, bytes: Buffer.byteLength(saved), by: 'person', at: new Date().toISOString() });
        return route.fulfill({ json: { ok: true, value: entry } });
      }
      return route.continue();
    });
    await api(page, 'drafts.put', { key: `edit:${entry.id}`, text: 'Region,Value\nDraft,2', meta: { baseVersion: 1 }, clientKey: 'csv-fixture', baseRevision: 0 });
    await openFile(page, 'editable.csv');
    const editor = page.getByRole('textbox', { name: 'Edit editable.csv', exact: true });
    await repairExpect(editor).toContainText('Draft,2');
    await repairScreenshot(page, info.project.name, 'csv-draft-editor');
    await page.getByRole('button', { name: 'Read', exact: true }).click();
    await repairExpect(fileTab(page).getByRole('cell', { name: 'Saved', exact: true })).toBeVisible();
    await repairExpect(fileTab(page).getByRole('cell', { name: 'Draft', exact: true })).toHaveCount(0);
    await repairExpect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
    const downloading = page.waitForEvent('download');
    await fileTab(page).getByRole('button', { name: 'Download', exact: true }).click();
    repairExpect(readFileSync((await (await downloading).path())!, 'utf8')).toBe(saved);
    repairExpect(readVersions.at(-1)).toBe(1);
    await repairScreenshot(page, info.project.name, 'csv-saved-grid-with-draft');
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await repairExpect(editor).toContainText('Draft,2');
    await editor.fill('Region,Value\nEdited,3');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await repairExpect.poll(() => entry.current).toBe(2);
    await page.getByRole('button', { name: 'Read', exact: true }).click();
    await repairExpect(fileTab(page).getByRole('cell', { name: 'Edited', exact: true })).toBeVisible();
    const next = page.waitForEvent('download');
    await fileTab(page).getByRole('button', { name: 'Download', exact: true }).click();
    repairExpect(readFileSync((await (await next).path())!, 'utf8')).toBe('Region,Value\nEdited,3');
    repairExpect(readVersions.at(-1)).toBe(2);
    await repairScreenshot(page, info.project.name, 'csv-saved-new-version');
  } finally { await end(); }
});

test('ordinary large files and hostile shared strings open bounded partial views', async ({ page }, info) => {
  const { id, end } = await setup(page);
  try {
    for (const [name, bytes, notice] of [
      ['many-rows.csv', Buffer.from('x,y\n'.repeat(10001)), 'Showing the first 1000 rows'],
      ['large-text.csv', Buffer.from(('x'.repeat(6000) + '\n').repeat(100)), 'Showing the first 83 rows'],
      ['dense.xlsx', sizedWorkbookFixture(1000, 21), 'Showing the first 953 rows of 1000'],
      ['shared-hostile.xlsx', sharedStringWorkbookFixture(), 'Showing the first 1 row of 100'],
    ] as const) {
      await attach(page, id, name, bytes);
      await openFile(page, name);
      await repairExpect(fileTab(page)).toContainText(notice);
      await repairExpect(fileTab(page).getByRole('alert')).toHaveCount(0);
      repairExpect(await fileTab(page).locator('tbody tr').count()).toBeLessThanOrEqual(100);
      repairExpect(await fileTab(page).getByRole('cell').count()).toBeLessThanOrEqual(1000);
      const downloading = page.waitForEvent('download');
      await fileTab(page).getByRole('button', { name: 'Download', exact: true }).click();
      repairExpect(readFileSync((await (await downloading).path())!).equals(bytes)).toBe(true);
      repairExpect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await repairScreenshot(page, info.project.name, name.replace('.', '-'));
    }
    await fileTab(page).getByRole('tab', { name: 'Forecast', exact: true }).click();
    await repairExpect(fileTab(page)).toContainText('No cells fit in the remaining preview budget.');
    await repairExpect(fileTab(page).getByRole('button', { name: 'Next columns', exact: true })).toHaveCount(0);
    await repairScreenshot(page, info.project.name, 'hostile-omitted-sheet');
    await page.reload();
    await repairExpect(fileTab(page)).toContainText('Showing the first 1 row of 100');
    await repairExpect(page.getByRole('button', { name: 'Close shared-hostile.xlsx', exact: true })).toBeEnabled();
    await attach(page, id, 'sparse-sheets.xlsx', sparseSheetsFixture());
    await openFile(page, 'sparse-sheets.xlsx');
    for (const [sheet, screenshot] of [['Revenue', 'sparse-content'], ['Forecast', 'sparse-forecast']]) {
      await fileTab(page).getByRole('tab', { name: sheet, exact: true }).click();
      await repairExpect(fileTab(page)).toContainText('Rows 1–100 of 1000');
      for (let i = 0; i < 9; i++) {
        await fileTab(page).getByRole('button', { name: 'Next columns', exact: true }).click();
        await fileTab(page).getByRole('button', { name: 'Next rows', exact: true }).click();
      }
      await repairExpect(fileTab(page).getByRole('cell', { name: 'value', exact: true })).toHaveCount(1);
      await repairExpect(fileTab(page).getByRole('cell')).toHaveCount(1000);
      await fileTab(page).getByRole('region', { name: `${sheet} cell values`, exact: true }).evaluate(el => { el.scrollLeft = el.scrollWidth; el.scrollTop = el.scrollHeight; });
      await repairScreenshot(page, info.project.name, screenshot);
    }
    await attach(page, id, 'control.docx', controlledWordFixture());
    await openFile(page, 'control.docx');
    await repairExpect(fileTab(page).locator('article > p')).toHaveCount(2);
    await repairExpect(fileTab(page).getByRole('cell', { name: 'Table inside control' })).toBeVisible();
    await repairScreenshot(page, info.project.name, 'word-control');
  } finally { await end(); }
});

test('conversion deadline ends its worker and closing a loading tab ends its worker', async ({ page }) => {
  const { id, end } = await setup(page);
  try {
    await page.evaluate(() => {
      const Original = window.Worker;
      (window as any).previewWorkers = [];
      window.Worker = class extends Original {
        constructor(url: string | URL, options?: WorkerOptions) { super(url, options); (window as any).previewWorkers.push(this); }
        postMessage() { /* Deliberately hold conversion, not the renderer. */ }
        terminate() { (this as any).ended = true; super.terminate(); }
      };
    });
    await attach(page, id, 'waiting.docx', wordFixture());
    await page.clock.install();
    await openFile(page, 'waiting.docx');
    await repairExpect.poll(() => page.evaluate(() => (window as any).previewWorkers.length)).toBeGreaterThan(0);
    await page.clock.fastForward(15001);
    await repairExpect(fileTab(page).getByRole('alert')).toContainText('too long');
    repairExpect(await page.evaluate(() => (window as any).previewWorkers.every((w: any) => w.ended))).toBe(true);
    await fileTab(page).getByRole('button', { name: 'Try again', exact: true }).click();
    await repairExpect(fileTab(page).getByRole('status')).toContainText('Loading preview');
    await page.getByRole('button', { name: 'Close waiting.docx', exact: true }).click();
    repairExpect(await page.evaluate(() => (window as any).previewWorkers.every((w: any) => w.ended))).toBe(true);
  } finally { await end(); }
});

test('pixel and PDF page ceilings precede page insertion and offer Download, not a new attempt that fails the same way', async ({ page }) => {
  const { id, end } = await setup(page);
  try {
    const huge = Buffer.from(PIXEL, 'base64'); huge.writeUInt32BE(100000, 16); huge.writeUInt32BE(100000, 20);
    await attach(page, id, 'huge-pixels.png', huge);
    await openFile(page, 'huge-pixels.png');
    await repairExpect(fileTab(page).getByRole('alert')).toContainText('40 million pixels');
    await repairExpect(fileTab(page).getByRole('img', { name: 'huge-pixels.png', exact: true })).toHaveCount(0);
    // The same file fails the same way, so only Download is offered.
    await repairExpect(fileTab(page).getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
    await repairExpect(fileTab(page).getByRole('button', { name: 'Download', exact: true })).toBeEnabled();
    await attach(page, id, 'too-many.pdf', pdfFixture(201));
    await openFile(page, 'too-many.pdf');
    await repairExpect(fileTab(page).getByRole('alert')).toContainText('200 pages');
    await repairExpect(fileTab(page).locator('canvas')).toHaveCount(0);
    await repairExpect(fileTab(page).getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
    await repairExpect(fileTab(page).getByRole('button', { name: 'Download', exact: true })).toBeEnabled();
  } finally { await end(); }
});

test('PDF document deadline terminates its worker and stays retryable', async ({ page }) => {
  const { id, end } = await setup(page);
  try {
    await page.evaluate(() => {
      const Original = window.Worker;
      (window as any).pdfWorkers = [];
      window.Worker = class extends Original {
        constructor(url: string | URL, options?: WorkerOptions) { super(url, options); (window as any).pdfWorkers.push(this); }
        postMessage() { /* Hold the PDF worker handshake and document read. */ }
        terminate() { (this as any).ended = true; super.terminate(); }
      };
    });
    await attach(page, id, 'waiting.pdf', pdfFixture());
    await page.clock.install();
    await openFile(page, 'waiting.pdf');
    await repairExpect.poll(() => page.evaluate(() => (window as any).pdfWorkers.length)).toBeGreaterThan(0);
    await page.clock.fastForward(15001);
    await repairExpect(fileTab(page).getByRole('alert')).toContainText('PDF took too long');
    await repairExpect(fileTab(page).getByRole('button', { name: 'Try again', exact: true })).toBeEnabled();
    await repairExpect.poll(() => page.evaluate(() => (window as any).pdfWorkers.every((w: any) => w.ended))).toBe(true);
  } finally { await end(); }
});

test('PDF page deadline cancels painting and ends its worker', async ({ page }) => {
  const { id, end } = await setup(page);
  try {
    await page.evaluate(() => {
      const Original = window.Worker;
      (window as any).pdfWorkers = [];
      window.Worker = class extends Original {
        constructor(url: string | URL, options?: WorkerOptions) { super(url, options); (window as any).pdfWorkers.push(this); }
        postMessage(message: any, transfer: any) { if (message.action !== 'GetOperatorList') super.postMessage(message, transfer); }
        terminate() { (this as any).ended = true; super.terminate(); }
      };
    });
    await attach(page, id, 'waiting-page.pdf', pdfFixture());
    await page.clock.install();
    await openFile(page, 'waiting-page.pdf');
    await repairExpect(fileTab(page).getByRole('group', { name: 'PDF controls' })).toContainText('of 2');
    await page.clock.fastForward(15001);
    await repairExpect(fileTab(page).getByRole('alert')).toContainText('PDF page took too long');
    await repairExpect.poll(() => page.evaluate(() => (window as any).pdfWorkers.every((w: any) => w.ended))).toBe(true);
  } finally { await end(); }
});


test('PDF canvas refusal belongs to its zoom and lowering zoom restores the page', async ({ page }, info) => {
  const { id, end } = await setup(page);
  try {
    // 5.88 million pixels at 100%, 23.5 million at 200%.
    const bytes = pdfFixture(1, [2100, 2800]);
    await attach(page, id, 'zoom.pdf', bytes);
    await openFile(page, 'zoom.pdf');
    const zoom = fileTab(page).getByLabel('PDF zoom', { exact: true });
    await repairExpect(fileTab(page).locator('canvas')).toHaveAttribute('width', '2100');
    await zoom.selectOption('2');
    await repairExpect(fileTab(page).getByRole('alert')).toContainText('16 million pixels');
    await repairExpect(zoom).toBeVisible();
    repairExpect(await page.evaluate(() => localStorage.getItem('document-preview-failures') ?? '')).not.toContain('16 million pixels');
    await repairScreenshot(page, info.project.name, 'pdf-zoom-refusal');
    await zoom.focus(); await zoom.selectOption('0.5');
    await repairExpect(fileTab(page).getByRole('alert')).toHaveCount(0);
    await repairExpect(fileTab(page).locator('canvas')).toHaveAttribute('width', '1050');
    await repairExpect(fileTab(page).locator('.textLayer').first()).toContainText('Harbor PDF review');
    await repairScreenshot(page, info.project.name, 'pdf-zoom-recovered');
  } finally { await end(); }
});

test('remembered PDF failure loads no chunk or worker until Try again and limits changes invalidate it', async ({ page, context }) => {
  await page.addInitScript(() => {
    const Original = window.Worker;
    (window as any).previewWorkerCount = 0;
    window.Worker = class extends Original { constructor(url: string | URL, options?: WorkerOptions) { super(url, options); (window as any).previewWorkerCount++; } };
  });
  const { id, end } = await setup(page);
  try {
    await attach(page, id, 'remembered.pdf', Buffer.from('damaged'));
    await openFile(page, 'remembered.pdf');
    await repairExpect(fileTab(page).getByRole('alert')).toContainText('could not be read');
    const loads: string[] = [];
    context.on('request', request => { if (/PdfPreview-|pdf\.worker/.test(request.url())) loads.push(request.url()); });
    await page.reload();
    await repairExpect(fileTab(page).getByRole('alert')).toContainText('could not be read');
    repairExpect(loads).toEqual([]);
    repairExpect(await page.evaluate(() => (window as any).previewWorkerCount)).toBe(0);
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      (window as any).previewSetItem = original;
      Storage.prototype.setItem = function(key, value) { if (key === 'document-preview-failures') throw new Error('Storage unavailable'); original.call(this, key, value); };
    });
    await fileTab(page).getByRole('button', { name: 'Try again', exact: true }).click();
    await repairExpect.poll(() => page.evaluate(() => (window as any).previewWorkerCount)).toBe(1);
    await repairExpect(fileTab(page).getByRole('alert')).toContainText('could not be read');
    await page.evaluate(() => { Storage.prototype.setItem = (window as any).previewSetItem; const value = JSON.parse(localStorage.getItem('document-preview-failures')!); value.limits = 'previous'; localStorage.setItem('document-preview-failures', JSON.stringify(value)); });
    await page.reload();
    await repairExpect.poll(() => page.evaluate(() => (window as any).previewWorkerCount)).toBe(1);
  } finally { await end(); }
});

test('remembered Office failure runs no converter after a restart until Try again', async ({ page }) => {
  await page.addInitScript(() => {
    const Original = window.Worker;
    (window as any).previewWorkerCount = 0;
    window.Worker = class extends Original { constructor(url: string | URL, options?: WorkerOptions) { super(url, options); (window as any).previewWorkerCount++; } };
  });
  const { id, end } = await setup(page);
  try {
    await attach(page, id, 'remembered.docx', Buffer.from('damaged'));
    await openFile(page, 'remembered.docx');
    await repairExpect(fileTab(page).getByRole('alert')).toContainText('could not be read');
    repairExpect(await page.evaluate(() => (window as any).previewWorkerCount)).toBeGreaterThan(0);
    await page.reload();
    await repairExpect(fileTab(page).getByRole('alert')).toContainText('could not be read');
    repairExpect(await page.evaluate(() => (window as any).previewWorkerCount)).toBe(0);
    await fileTab(page).getByRole('button', { name: 'Try again', exact: true }).click();
    await repairExpect.poll(() => page.evaluate(() => (window as any).previewWorkerCount)).toBe(1);
    await repairExpect(fileTab(page).getByRole('alert')).toContainText('could not be read');
  } finally { await end(); }
});

test('a missing PDF chunk has a contained Retry and Download recovery', async ({ page }, info) => {
  const { id, end } = await setup(page);
  try {
    await page.route('**/PdfPreview-*.js', route => route.abort());
    await attach(page, id, 'chunk.pdf', pdfFixture());
    await openFile(page, 'chunk.pdf');
    await repairExpect(fileTab(page).getByRole('alert')).toContainText('This preview could not be loaded');
    await repairExpect(fileTab(page).getByRole('button', { name: 'Download', exact: true })).toBeEnabled();
    await repairScreenshot(page, info.project.name, 'pdf-chunk-failure');
    await page.unroute('**/PdfPreview-*.js');
    await fileTab(page).getByRole('button', { name: 'Retry', exact: true }).click();
    await repairExpect(fileTab(page).locator('.textLayer').first()).toContainText('Harbor PDF review');
  } finally { await end(); }
});

test('JPEG GIF and WebP dimensions are refused while detached', async ({ page }) => {
  const { id, end } = await setup(page);
  try {
    const generated = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1; return [canvas.toDataURL('image/jpeg'), canvas.toDataURL('image/webp')]; });
    await page.evaluate(() => {
      Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', { get: () => 9000 });
      Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', { get: () => 9000 });
    });
    for (const [name, data] of [['detached.jpeg', generated[0].split(',')[1]], ['detached.gif', 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'], ['detached.webp', generated[1].split(',')[1]]]) {
      await attach(page, id, name, Buffer.from(data, 'base64'));
      await openFile(page, name);
      await repairExpect(fileTab(page).getByRole('alert')).toContainText('40 million pixels');
      await repairExpect(fileTab(page).getByRole('img', { name, exact: true })).toHaveCount(0);
    }
  } finally { await end(); }
});

test('listed files open before their document details arrive', async ({ page }) => {
  const { id, end } = await setup(page);
  try {
    // Reproduce the empty detail state while the independent file list is ready.
    await page.route('**/api', route => {
      const body = route.request().postDataJSON();
      if (body.method === 'material.list' && body.args?.projectId === id) return route.fulfill({ json: [] });
      return route.continue();
    });
    await attach(page, id, 'listed.docx', wordFixture());
    await page.keyboard.press('ControlOrMeta+p');
    const row = page.getByTestId('file-row').filter({ hasText: 'listed.docx' });
    await repairExpect(row).toBeVisible();
    await row.click();
    await repairExpect(fileTab(page).getByRole('heading', { name: 'Quarterly review' })).toBeVisible();
    await repairExpect(fileTab(page).getByRole('button', { name: 'Download', exact: true })).toBeEnabled();
  } finally { await end(); }
});
