// Real app renderer over a controlled API transport: exercise snapshots, not a second backend.
import { expect, test } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PREFS } from '@backbone-next/platform';

let server: ViteDevServer;
let url: string;
test.beforeAll(async () => {
  server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), server: { host: '127.0.0.1', port: 0 } });
  await server.listen(); url = server.resolvedUrls!.local[0];
});
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ page }) => {
  page.setDefaultTimeout(15_000);
  await page.addInitScript(({ prefs }) => {
    const at = '2026-11-05T10:00:00Z';
    const summary = { id: 't', projectId: 'p', title: 'Streaming review', running: true, archived: false, unread: false, pinned: false, updatedAt: at };
    const turn = { id: 'turn', status: 'running', user: { text: 'Review the implementation and explain the result.', attachments: [], at }, work: { startedAt: at, steps: [{ kind: 'note', label: 'Inspecting source…' }], harness: 'controlled' }, answer: { text: 'Stable opening paragraph.\n\nA **streaming', files: [] }, effects: [] };
    const thread = { summary, turns: [turn], sideTurns: [], card: { project: 'Streaming fixture', sources: [], changes: { added: 0, removed: 0, files: 0 }, subagents: { active: 0, done: 0 } } };
    const listeners = new Set<(event: { topic: string; id: string }) => void>();
    const fixture = { thread, files: [] as unknown[], fileReads: 0, sent: 0, draft: '', kept: [] as unknown[], keepResult: null as any, copied: '', emit: () => listeners.forEach((f) => f({ topic: 'thread', id: 't' })) };
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => { fixture.copied = text; } } });
    Object.assign(window, { fixture, backbone: {
      platform: 'linux', setTheme() {},
      onEvent(f: (event: { topic: string; id: string }) => void) { listeners.add(f); return () => listeners.delete(f); },
      async call(method: string, args: any) {
        switch (method) {
          case 'identity.get': return {ok:true,value:{person:{id:'fixture-person',name:'Fixture person',role:'owner',status:'active'},people:[],deviceOwner:true}};
          case 'host.status': return { owns: true };
          case 'viewer.get': return { ...prefs, selectedProjectId: 'p', selectedThreadId: 't' };
          case 'viewer.put': return prefs;
          case 'models.list': return [{ id: 'stub', label: 'Controlled model', efforts: [3] }];
          case 'projects.list': return [{ id: 'p', name: 'Streaming fixture', kind: 'folder', createdAt: at }];
          case 'threads.list': return structuredClone([summary]);
          case 'threads.get': return { ok: true, value: structuredClone(thread) };
          case 'drafts.get': return fixture.draft ? { text: fixture.draft, meta: {} } : null;
          case 'drafts.put': fixture.draft = args.text; return { ok: true, value: args };
          case 'turns.send': fixture.sent++; return { ok: false, detail: 'Synthetic refusal.' };
          case 'turns.keepRecovery': fixture.kept.push(args); if (fixture.keepResult?.ok && fixture.keepResult.value.cleared) { delete (thread.summary as any).recoveryHold; fixture.emit(); } return fixture.keepResult;
          case 'material.list': return [];
          case 'files.list': fixture.fileReads++; return structuredClone(fixture.files);
          case 'turns.stop': turn.status = 'stopped'; summary.running = false; fixture.emit(); return { ok: true, value: null };
          default: return null;
        }
      },
    } });
  }, { prefs: DEFAULT_PREFS });
  await page.goto(url);
  await expect(page.getByTestId('answer')).toContainText('Stable opening');
  await expect(page.getByText('Answers do not confirm actions.')).toHaveCount(0);
});

test('incomplete Markdown is readable and completed blocks survive text and workspace updates', async ({ page }) => {
  await expect(page.getByTestId('answer').locator('p').last()).toHaveText('A streaming');
  await page.getByTestId('answer').locator('p').first().evaluate((node) => { (window as any).opening = node; });
  await page.evaluate(() => {
    const f = (window as any).fixture;
    f.thread.turns[0].answer.text += ' response** with `code`.';
    f.files = [{ path: 'new.md', materialId: 'new' }]; f.emit();
  });
  await expect(page.getByTestId('answer')).toContainText('response');
  await expect.poll(() => page.evaluate(() => (window as any).opening.isConnected)).toBe(true);
});

test('workspace refresh does not detach a completed paragraph or its selection', async ({ page }) => {
  await page.getByTestId('answer').locator('p').first().evaluate((node) => {
    (window as any).opening = node;
    const selection = window.getSelection()!;
    const range = document.createRange(); range.selectNodeContents(node);
    selection.removeAllRanges(); selection.addRange(range);
  });
  await page.evaluate(() => {
    const f = (window as any).fixture;
    f.files = [{ path: 'new.md', materialId: 'new' }]; f.emit();
  });
  // Wait for the workspace refetch to land before checking the original DOM node.
  await expect.poll(() => page.evaluate(() => (window as any).fixture.fileReads)).toBeGreaterThan(1);
  await expect.poll(() => page.evaluate(() => (window as any).opening.isConnected)).toBe(true);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('Stable opening paragraph.');
});

test('growing output follows the bottom, lets the reader scroll back, and offers return to latest', async ({ page }) => {
  await page.evaluate(() => {
    const f = (window as any).fixture;
    f.thread.turns[0].answer.text += '\n\n' + Array.from({ length: 55 }, (_, i) => `Paragraph ${i}. A useful explanation that takes space.`).join('\n\n'); f.emit();
  });
  const scroll = page.getByRole('region', { name: 'Conversation' });
  await expect.poll(() => scroll.evaluate((e) => e.scrollHeight - e.clientHeight - e.scrollTop)).toBeLessThan(8);
  await scroll.hover();
  await page.mouse.wheel(0, -5000);
  await expect.poll(() => scroll.evaluate((e) => e.scrollTop)).toBe(0);
  await page.evaluate(() => { const f = (window as any).fixture; f.thread.turns[0].answer.text += '\n\nMore output.'; f.emit(); });
  await expect.poll(() => scroll.evaluate((e) => e.scrollTop)).toBe(0);
  await page.getByRole('button', { name: 'Jump to latest' }).click();
  await expect.poll(() => scroll.evaluate((e) => e.scrollHeight - e.clientHeight - e.scrollTop)).toBeLessThan(8);
});

test('long code, activity, interruption and reopen retain the received answer', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.evaluate(() => {
    const f = (window as any).fixture;
    f.thread.turns[0].work.steps.push({ kind: 'tool', label: 'Read source · completed in staging' });
    f.thread.turns[0].answer.text = '# Result\n\n' + '```ts\n' + Array.from({ length: 80 }, (_, i) => `const value${i} = ${i};`).join('\n') + '\n```\n\nFinal explanation.'; f.emit();
  });
  await expect(page.getByTestId('answer').locator('pre')).toContainText('value79');
  await expect(page.getByTestId('work-block')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: 'Copy Code', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByTestId('work-block')).toContainText('Stopped');
  await expect(page.getByTestId('answer')).toContainText('Final explanation.');
  await page.getByRole('button', { name: 'Copy Code', exact: true }).click();
  expect(await page.evaluate(() => (window as any).fixture.copied)).toContain('const value79 = 79;');
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'Streaming review', exact: true }).click();
  await expect(page.getByTestId('answer')).toContainText('value79');
  expect(errors).toEqual([]);
});

for (const width of [1440, 375]) for (const colorScheme of ['light', 'dark'] as const) {
  test(`streamed Markdown and code remain usable at ${width}px in ${colorScheme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme });
    await page.evaluate(async () => {
      const f = (window as any).fixture;
      const answer = '# Review result\n\nA **clear explanation** with `inline code`.\n\n| Check | Outcome |\n| --- | --- |\n| Stream | Stable |\n\n```ts\nconst answer = 42;\nconst longLine = "' + 'workspace/'.repeat(30) + '";\n```\n\nThe response stays readable as it arrives.';
      let emptyFrames = 0;
      let observing = true;
      const observe = () => {
        if (!observing) return;
        if (!document.querySelector('[data-testid="answer"]')?.textContent?.trim()) emptyFrames++;
        requestAnimationFrame(observe);
      };
      requestAnimationFrame(observe);
      for (let end = 20; end < answer.length + 30; end += 30) {
        f.thread.turns[0].answer.text = answer.slice(0, end); f.emit();
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      observing = false; f.emptyFrames = emptyFrames;
    });
    await expect(page.getByTestId('answer')).toContainText('The response stays readable as it arrives.');
    await expect(page.getByTestId('answer').getByRole('table')).toContainText('Stable');
    expect(await page.evaluate(() => (window as any).fixture.emptyFrames)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.getByTestId('work-block')).toContainText('Stopped');
    await page.getByRole('region', { name: 'Conversation', exact: true }).hover();
    await page.mouse.wheel(0, -5000);
    await page.screenshot({ path: info.outputPath(`streaming-${width}-${colorScheme}.png`), fullPage: true });
  });
}

test('stopping incomplete output keeps its readable formatting and reader position', async ({ page }) => {
  const before = await page.getByTestId('answer').textContent();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByTestId('work-block')).toContainText('Stopped');
  expect(await page.getByTestId('answer').textContent()).toBe(before);
});

test('a shorter authoritative snapshot replaces provisional text immediately', async ({ page }) => {
  await page.evaluate(() => {
    const f = (window as any).fixture;
    f.thread.turns[0].answer.text = 'Corrected answer.'; f.emit();
  });
  await expect(page.getByTestId('answer')).toHaveText('Corrected answer.');
  await expect(page.getByTestId('answer')).not.toContainText('Stable opening');
});

test('local link eligibility updates in place as files arrive and are removed', async ({ page }) => {
  await page.evaluate(() => {
    const f = (window as any).fixture;
    f.thread.turns[0].answer.text = 'See [the brief](brief.md) and [the passwords](/etc/passwd).'; f.emit();
  });
  const answer = page.getByTestId('answer');
  await expect(answer.locator('[data-blocked-link]')).toHaveCount(2);
  await answer.locator('p').evaluate((node) => { (window as any).linkParagraph = node; });
  await page.evaluate(() => {
    const f = (window as any).fixture;
    f.files = [{ path: 'brief.md', materialId: 'brief' }]; f.emit();
  });
  await expect(answer.getByRole('button', { name: 'the brief', exact: true })).toHaveAttribute('data-workspace-link', 'brief.md');
  await expect(answer.locator('[data-blocked-link]', { hasText: 'the passwords' })).toHaveCount(1);
  await page.evaluate(() => { const f = (window as any).fixture; f.files = []; f.emit(); });
  await expect(answer.getByRole('button', { name: 'the brief', exact: true })).toHaveCount(0);
  await expect(answer.locator('[data-blocked-link]')).toHaveCount(2);
  expect(await page.evaluate(() => (window as any).linkParagraph.isConnected)).toBe(true);
});

test('selecting an answer pauses following while new output arrives', async ({ page }) => {
  const opening = page.getByTestId('answer').locator('p').first();
  await opening.click({ clickCount: 3 });
  const scroll = page.getByRole('region', { name: 'Conversation', exact: true });
  const before = await scroll.evaluate((e) => e.scrollTop);
  await page.evaluate(() => {
    const f = (window as any).fixture;
    f.thread.turns[0].answer.text += '\n\n' + 'More explanation.\n\n'.repeat(60); f.emit();
  });
  await expect(page.getByTestId('answer')).toContainText('More explanation.');
  await expect.poll(() => scroll.evaluate((e) => e.scrollTop)).toBe(before);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toContain('Stable opening paragraph.');
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
  await page.getByRole('button', { name: 'Jump to latest' }).click();
  await expect.poll(() => scroll.evaluate((e) => e.scrollHeight - e.clientHeight - e.scrollTop)).toBeLessThan(8);
});


test('views opened from More retain their names in the conversation bar', async ({ page }) => {
  for (const label of ['Memory', 'Scheduled', 'Now', 'Mail triage']) {
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: label, exact: true }).click();
    await expect(page.getByRole('tablist', { name: 'Open conversations' }).getByRole('tab', { name: label, exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Close conversation view Streaming review' }).click();
  await expect(page.getByRole('region', { name: 'Mail triage' })).toBeVisible();
});


test('recovery holds explain the state and preserve an unsent draft until cleared', async ({ page }) => {
  await page.evaluate(() => { const f = (window as any).fixture; f.thread.summary.running = false; f.thread.turns[0].status = 'stopped'; f.thread.summary.recoveryHold = { turnId: 'turn', kind: 'inspection' }; f.emit(); });
  const notice = page.getByTestId('recovery-hold');
  await expect(notice).toContainText('Saved recovery data needs inspection');
  await expect(notice).toContainText('saved bytes are kept');
  await expect(notice).toContainText('Other conversations still work');
  await expect(notice).toContainText('cannot be deleted while it is held');
  await expect(notice.getByRole('button', { name: 'Open Now to inspect saved work' })).toBeVisible();
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill('Keep this draft');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await composer.press('Enter');
  expect(await page.evaluate(() => (window as any).fixture.sent)).toBe(0);
  await expect(composer).toHaveValue('Keep this draft');
  await page.evaluate(() => { const f = (window as any).fixture; f.thread.summary.recoveryHold.kind = 'awaiting-decision'; f.emit(); });
  await expect(notice).toContainText('Nothing was resent');
  await expect(notice).toContainText('waiting for your decision');
  await expect(notice.getByRole('button', { name: 'Keep recovery data' })).toHaveCount(0);
  await page.evaluate(() => { const f = (window as any).fixture; f.thread.summary.recoveryHold.kind = 'recovering'; f.emit(); });
  await expect(notice).toContainText('being reconciled');
  await expect(notice).not.toContainText('Nothing was resent');
  await page.evaluate(() => { const f = (window as any).fixture; delete f.thread.summary.recoveryHold; f.emit(); });
  await expect(notice).toHaveCount(0);
  await expect(composer).toHaveValue('Keep this draft');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
});


test('person can keep recovery data without claiming an unresolved hold was cleared', async ({ page }) => {
  await page.evaluate(() => { const f = (window as any).fixture; f.thread.summary.running = false; f.thread.turns[0].status = 'stopped'; f.thread.summary.recoveryHold = { turnId: 'turn', kind: 'inspection' }; f.thread.turns[0].recovery = { revision: 'rev-1', detail: 'Saved data needs inspection.' }; f.keepResult = { ok: false, outcome: 'REFUSED', reason: 'STALE_BASE', detail: 'The recovery changed.' }; f.emit(); });
  const notice = page.getByTestId('recovery-hold');
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill('Keep my draft');
  await expect(notice).toContainText('cancels unsent work');
  await expect(notice).toContainText('otherwise continue automatically when recovery resumes');
  await expect(notice).toContainText('never resumes or sends');
  await expect(notice).not.toContainText('no release action yet');
  await notice.getByRole('button', { name: 'Keep recovery data' }).click();
  await expect(notice.getByRole('alert')).toContainText('The recovery changed.');
  await expect(notice.getByRole('button', { name: 'Reload conversation' })).toBeVisible();
  await expect(composer).toHaveValue('Keep my draft');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await page.evaluate(() => { const f = (window as any).fixture; f.thread.turns[0].recovery.revision = 'rev-2'; f.keepResult = { ok: true, value: { cleared: false, detail: 'An effect is still unknown.', files: [{ materialId: 'saved', name: 'Saved.md', version: 1 }] } }; f.emit(); });
  await expect(notice.getByRole('alert')).toBeVisible();
  await notice.getByRole('button', { name: 'Reload conversation' }).click();
  await notice.getByRole('button', { name: 'Keep recovery data' }).click();
  const result = page.getByTestId('keep-recovery-result');
  await expect(result).toContainText('An effect is still unknown.');
  await expect(result).toContainText('This attempt did not clear recovery.');
  await expect(result.getByRole('button', { name: 'Saved.md v1' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await page.evaluate(() => { const f = (window as any).fixture; f.keepResult = { ok: true, value: { cleared: true, detail: 'Recovery data was kept.', files: [] } }; });
  await notice.getByRole('button', { name: 'Keep recovery data' }).click();
  await expect(result).toContainText('That recovery was cleared.');
  await expect(notice).toHaveCount(0);
  await expect(composer).toHaveValue('Keep my draft');
  expect(await page.evaluate(() => (window as any).fixture.kept)).toEqual([{ threadId: 't', turnId: 'turn', revision: 'rev-1' }, { threadId: 't', turnId: 'turn', revision: 'rev-2' }, { threadId: 't', turnId: 'turn', revision: 'rev-2' }]);
  expect(await page.evaluate(() => (window as any).fixture.sent)).toBe(0);
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(page.getByTestId('keep-recovery-result')).toHaveCount(0);
});


test('awaiting a decision offers a revision-bound keep only while idle', async ({ page }) => {
  await page.evaluate(() => { const f = (window as any).fixture; f.thread.summary.running = false; f.thread.turns[0].status = 'stopped'; f.thread.summary.recoveryHold = {turnId:'turn', kind:'awaiting-decision'}; f.thread.turns[0].recovery = {revision:'rev', detail:'Review saved work.'}; f.keepResult = {ok:true, value:{cleared:false, detail:'Original effect remains unknown.', files:[]}}; f.emit(); });
  const notice = page.getByTestId('recovery-hold');
  await expect(notice).toContainText('cancels unsent work');
  await expect(notice).toContainText('otherwise continue automatically when recovery resumes');
  await expect(notice).toContainText('never resumes or sends');
  await expect(notice).not.toContainText('original run closed');
  await notice.getByRole('button',{name:'Keep recovery data'}).click();
  await expect(page.getByTestId('keep-recovery-result')).toContainText('Original effect remains unknown.');
  await expect(page.getByTestId('recovery-hold')).toBeVisible();
  await page.evaluate(() => { const f = (window as any).fixture; f.thread.summary.running = true; f.emit(); });
  await expect(notice.getByRole('button',{name:'Keep recovery data'})).toHaveCount(0);
  await page.evaluate(() => { const f = (window as any).fixture; f.thread.summary.running = false; delete f.thread.turns[0].recovery; f.emit(); });
  await expect(notice.getByRole('button',{name:'Keep recovery data'})).toHaveCount(0);
});
