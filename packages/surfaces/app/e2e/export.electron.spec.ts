import { TEST_HANG_MS } from '../../../../scripts/lib/test-hang.ts';
// Assertion deadlines detect hangs; Playwright retains the pending locator/property and last value.
// Export on the development or installed Electron build, on the controlled harness with no model route: a historical
// version exported to PDF and HTML from the document's menu, where the save dialog is stood in for
// (the answer is a temporary folder; every default name asked is recorded). The files are the
// version shown, the hidden print window is gone after, and no version is added.
import { expect, test, _electron, type ElectronApplication } from '@playwright/test';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { api, appDir } from './journey';

const executablePath = createRequire(import.meta.url)('electron') as string;
type Read = { ok: boolean; value: { text: string; entry: { current: number; versions: unknown[] } } };

test('a shown version exports to PDF and HTML where the person chooses, and records nothing', async () => {
  const installed = process.env.BACKBONE_APP_EXECUTABLE;
  // Let the packaged app initialise its own sealed vault instead of reusing a plaintext test vault.
  const home = installed ? mkdtempSync(join(tmpdir(), 'backbone-export-')) : freshDataHome('export');
  const out = mkdtempSync(join(tmpdir(), 'backbone-export-out-'));
  let app: ElectronApplication | undefined;
  try {
    app = await _electron.launch({ executablePath: installed || executablePath, args: installed ? [] : [appDir], env: { ...process.env, BACKBONE_HOME: home, BACKBONE_USER_HOME: out, BACKBONE_KEYS: 'plaintext', BACKBONE_HARNESS: 'harness-stub', BACKBONE_MODEL_ENDPOINT: '' } });
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(!!installed);
    const page = await app.firstWindow();
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    const project = await api<{ ok: boolean; value: { id: string } }>(page, 'projects.create', { name: 'Harbor', kind: 'folder' });
    const sent = await api<{ ok: boolean; value: { threadId: string } }>(page, 'turns.send', { projectId: project.value.id, text: 'Write an editable brief', attachments: [], settings: { permission: 'full', model: 'stub', effort: 3, runsOn: 'this-computer', mode: 'chat' }, clientKey: crypto.randomUUID() });
    expect(sent.ok).toBe(true);
    await expect.poll(async () => (await api<{ value: { summary: { running: boolean } } }>(page, 'threads.get', { id: sent.value.threadId })).value.summary.running).toBe(false);
    const brief = (await api<{ id: string; name: string }[]>(page, 'material.list', { projectId: project.value.id })).find((f) => f.name === 'brief.md')!;
    const v1 = await api<Read>(page, 'material.read', { id: brief.id, version: 1 });
    // A later version exists; the person is looking at v1.
    const saved = await api<{ ok: boolean }>(page, 'material.save', { id: brief.id, text: '# Revised brief\n\nNot what was shown.', baseVersion: v1.value.entry.current });
    expect(saved.ok).toBe(true);
    const before = await api<Read>(page, 'material.read', { id: brief.id });
    expect(before.value.entry.current).toBe(2);
    const heading = /^#\s+(.+)$/m.exec(v1.value.text)![1].trim();

    // The renderer names only a document shown in its project: anything else is refused before a dialog.
    type Ask = (p: string, i: string, v: number, f: string) => Promise<{ ok: boolean; detail?: string }>;
    const ask = (...a: [string, string, number, string]) => page.evaluate((a) => (window as unknown as { backbone: { exportDocument: Ask } }).backbone.exportDocument(...a), a);
    const other = await api<{ value: { id: string } }>(page, 'projects.create', { name: 'Elsewhere', kind: 'folder' });
    expect(await ask('nope', 'nope', 1, 'exe')).toMatchObject({ ok: false });
    expect(await ask(other.value.id, brief.id, 1, 'pdf')).toMatchObject({ ok: false, detail: 'That document is not in this project.' });
    expect(await ask(project.value.id, brief.id, 3, 'pdf')).toMatchObject({ ok: false, detail: 'That version does not exist.' });

    // One export at a time: while a dialog is open, a second request is refused at once; cancel writes nothing.
    await app.evaluate(({ dialog }) => {
      dialog.showSaveDialog = (() => new Promise((resolve) => { (globalThis as { answer?: unknown }).answer = resolve; })) as never;
    });
    const first = ask(project.value.id, brief.id, 1, 'md');
    await expect.poll(() => app!.evaluate(() => typeof (globalThis as { answer?: unknown }).answer)).toBe('function');
    expect(await ask(project.value.id, brief.id, 1, 'md')).toMatchObject({ ok: false, detail: 'An export is already open; finish it first.' });
    await app.evaluate(() => ((globalThis as { answer?: (v: unknown) => void }).answer!)({ canceled: true, filePath: '' }));
    expect(await first).toMatchObject({ ok: true, value: { saved: false } });

    await app.evaluate(({ dialog }, dir) => {
      const asked: string[] = [];
      (globalThis as { asked?: string[] }).asked = asked;
      dialog.showSaveDialog = (async (...args: { defaultPath: string; title: string }[]) => {
        const name = args.at(-1)!.defaultPath.split(/[\\/]/).pop()!;
        asked.push(`${args.at(-1)!.title} → ${name}`);
        return { canceled: false, filePath: `${dir}/${name}` };
      }) as never;
    }, out);

    const prefs = await api<Record<string, unknown>>(page, 'viewer.get', {});
    await api(page, 'viewer.put', { prefs: { ...prefs, selectedThreadId: sent.value.threadId, selectedProjectId: project.value.id, pane: { open: false, tabs: [], active: null } } });
    await page.reload();
    // Use the result the person received, not a seeded version tab: the newer human Save stays current.
    await page.getByTestId('turn').first().getByRole('button', { name: /^brief\.md\s*v1$/ }).click();
    await expect(page.getByTestId('historical-version')).toBeVisible();
    await expect(page.getByTestId('reader').filter({ visible: true })).toContainText(heading);
    await expect(page.getByTestId('reader').filter({ visible: true })).not.toContainText('Revised brief');
    await expect(page.getByRole('textbox', { name: 'Edit brief.md' })).toHaveCount(0);

    const exportAs = async (label: string, file: string) => {
      await page.getByRole('button', { name: 'Document options' }).click();
      await expect(page.getByTestId('file-version')).toContainText('v1');
      await page.getByRole('menuitem', { name: `Export as ${label}…` }).click();
      await expect.poll(() => existsSync(join(out, file)), { timeout: TEST_HANG_MS }).toBe(true);
    };
    await exportAs('PDF', 'brief-v1.pdf');
    await exportAs('PDF slides', 'brief-v1-slides.pdf');
    await exportAs('Markdown', 'brief-v1.md');
    await exportAs('HTML', 'brief-v1.html');
    // A regular file the person chose again is replaced, with no temporary file left beside it.
    writeFileSync(join(out, 'brief-v1.html'), 'stale');
    await exportAs('HTML', 'brief-v1.html');
    await expect.poll(() => readFileSync(join(out, 'brief-v1.html'), 'utf8'), { timeout: TEST_HANG_MS }).toContain(heading);
    await expect.poll(() => readdirSync(out).sort()).toEqual(['brief-v1-slides.pdf', 'brief-v1.html', 'brief-v1.md', 'brief-v1.pdf']);
    expect(readFileSync(join(out, 'brief-v1.md'), 'utf8')).toBe(v1.value.text);
    expect(await app.evaluate(() => (globalThis as { asked?: string[] }).asked)).toEqual(['pdf', '-slides.pdf', 'md', 'html', 'html'].map((x) => `Export Harbor › brief.md v1 → brief-v1${x.startsWith('-') ? x : `.${x}`}`));

    const pdf = readFileSync(join(out, 'brief-v1.pdf'));
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // The deck prints on 16:9 pages (13.333 by 7.5 inches, 960 by 540 points), each slide its own.
    const deck = readFileSync(join(out, 'brief-v1-slides.pdf')).toString('latin1');
    expect(deck.startsWith('%PDF-')).toBe(true);
    const boxes = [...deck.matchAll(/\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/g)].map((m) => [Math.round(Number(m[1])), Math.round(Number(m[2]))]);
    expect(boxes.length).toBeGreaterThan(0);
    expect(boxes.every(([w, h]) => w === 960 && h === 540)).toBe(true);
    const html = readFileSync(join(out, 'brief-v1.html'), 'utf8');
    expect(html).toContain(heading);
    expect(html).not.toContain('Revised brief');
    expect(html).not.toMatch(/<script|\ssrc=/i);

    // The hidden print window is gone, nothing failed on screen, and export recorded no version.
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    await expect(page.getByRole('alert')).toHaveCount(0);
    const after = await api<Read>(page, 'material.read', { id: brief.id });
    expect(after.value.entry.current).toBe(2);
    expect(after.value.entry.versions.length).toBe(before.value.entry.versions.length);
    expect(after.value.text).toBe('# Revised brief\n\nNot what was shown.');
  } finally {
    await app?.close().catch(() => undefined);
    await removeDataHome(home);
    rmSync(out, { recursive: true, force: true });
  }
});
