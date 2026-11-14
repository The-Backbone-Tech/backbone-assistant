// Real renderer; controlled transport faults exercise submission custody, not selector quality.
import { expect, test, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PREFS } from '@backbone-next/platform';
let server: ViteDevServer; let url: string;
test.beforeAll(async () => { server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), server: { host: '127.0.0.1', port: 0 } }); await server.listen(); url = server.resolvedUrls!.local[0]; });
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ page }) => {
  page.setDefaultTimeout(15_000);
  await page.addInitScript(({ prefs }) => {
    const stored = JSON.parse(sessionStorage.getItem('selection-fixture') ?? '{}');
    const at = new Date().toISOString();
    const route = { id: 'local:test:small', label: 'Small model on this computer', kind: 'local-model', capabilities: ['model', 'files'], network: false, spends: 'none', eligible: true };
    const alternative = { ...route, id: 'model-route', label: 'Configured API', kind: 'model-route', network: true, spends: 'metered' };
    const selection = { choice: { route, reasons: ['costs nothing'] }, feasible: [{ route, reasons: ['costs nothing'] }], excluded: [{ route: alternative, reasons: ['costs more than allowed (metered, allowed plan)'] }], limitation: null };
    const state = { drafts: {}, threads: [], requests: [], normal: [], materials: {}, ...stored } as any;
    const listeners = new Set<(e: unknown) => void>();
    const save = () => sessionStorage.setItem('selection-fixture', JSON.stringify(state));
    const fixture = { state, selection, draftPuts: [] as any[], mode: 'ok', holdDraft: false, waitingDraft: false, holdRun: false, holdNormal: false, normalOk: false, releaseNormal: () => {}, releaseDraftRead: () => {}, releaseMaterialRead: () => {}, releaseDraft: () => {}, releaseRun: () => {}, emit: () => listeners.forEach((f) => f({ topic: 'thread' })) };
    Object.assign(window, { fixture, backbone: {
      platform: 'linux', setTheme() {}, onEvent(f: (e: unknown) => void) { listeners.add(f); return () => listeners.delete(f); },
      async call(method: string, args: any) {
        switch (method) {
          case 'identity.get': return {ok:true,value:{person:{id:'fixture-person',name:'Fixture person',role:'owner',status:'active'},people:[],deviceOwner:true}};
          case 'host.status': return { owns: true };
          case 'viewer.get': return state.viewer ?? { ...prefs, selectedProjectId: 'p' };
          case 'viewer.put': state.viewer = args.prefs; save(); return args.prefs;
          case 'models.list': return [{ id: 'stub', label: 'Controlled model', efforts: [3] }];
          case 'projects.list': return [{ id: 'p', name: 'Selection project', kind: 'folder', createdAt: at }];
          case 'threads.list': return state.threads.map((t: any) => t.summary);
          case 'threads.get': if (state.failGoal === 'threads.get') { state.failGoal = undefined; throw new Error('Controlled goal read failure'); } return { ok: true, value: state.threads.find((t: any) => t.summary.id === args.id) };
          case 'plugins.parts': case 'files.list': case 'material.list': return [];
          case 'drafts.get':
            if (state.failDraftRead) throw new Error('Controlled draft read failure');
            if (state.holdOneDraftRead && args.key === 'composer:home:p') {
              state.waitingOneDraftRead = true;
              const captured = structuredClone(state.drafts[args.key] ?? null);
              await new Promise<void>((r) => { fixture.releaseDraftRead = r; });
              return captured;
            }
            if (state.holdDraftRead) await new Promise<void>((r) => { fixture.releaseDraftRead = () => { state.holdDraftRead = false; r(); }; });
            return state.drafts[args.key] ?? null;
          case 'drafts.put':
            fixture.draftPuts.push(structuredClone(args));
            if (state.loseNextDraft) {state.loseNextDraft=false; state.drafts[args.key]={...args,revision:(state.drafts[args.key]?.revision ?? 0)+1,updatedAt:at}; save(); throw new Error('Controlled lost draft acknowledgement');}
            if (state.failDiscardSave === 'stale' && args.meta?.retryNotice && !args.meta?.sendKey) return {ok:false,reason:'STALE_BASE',outcome:'REFUSED',detail:'Draft changed.'};
            if (state.failDiscardSave && args.meta?.retryNotice && !args.meta?.sendKey) throw new Error('Controlled discard save failure');
            if (fixture.holdDraft && args.meta?.sendHow) await new Promise<void>((r) => { fixture.waitingDraft = true; fixture.releaseDraft = () => { fixture.holdDraft = false; r(); }; });
            state.drafts[args.key] = { ...args, updatedAt: at }; save(); return { ok: true, value: state.drafts[args.key] };
          case 'material.attach': { const id = `file-${Object.keys(state.materials).length + 1}`; const entry = { id, projectId: 'p', name: args.name, current: 1, versions: [] }; state.materials[id] = entry; save(); return { ok: true, value: entry }; }
          case 'material.read':
            if (state.holdMaterialRead) await new Promise<void>((r) => { state.waitingMaterialRead = true; fixture.releaseMaterialRead = () => { state.holdMaterialRead = false; r(); }; });
            if (state.failRead) return { ok: false, outcome: 'REFUSED', reason: 'WITHDRAWN', detail: 'Source withdrawn.' }; return { ok: true, value: { entry: state.materials[args.id], text: '# Note' } };
          case 'solutions.options': return structuredClone(fixture.selection);
          case 'solutions.verify': return { ok: true, value: state.verification };
          case 'solutions.run': {
            state.requests.push(structuredClone(args)); save();
            if (fixture.holdRun) await new Promise<void>((r) => { fixture.releaseRun = r; });
            if (fixture.mode === 'no-start') return { ok: true, value: { selection, started: null, detail: 'This route needs the Codex engine; nothing was started.' } };
            if (!state.threads.length) {
              const pin = { kind: 'endpoint', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'small', label: route.label };
              state.threads.push({ summary: { id: 't', projectId: 'p', title: args.text, running: false }, turns: [{ id: 'turn', status: 'done', user: { text: args.text, attachments: (args.attachments ?? []).map((id: string) => ({ materialId: id, name: state.materials[id].name, version: 1 })), at, settings: args.settings }, work: { startedAt: at, endedAt: at, steps: [], harness: 'Controlled' }, answer: { text: 'Result from the selected route.', files: [] }, effects: [], selection: { task: args.task, routeId: route.id, reasons: ['costs nothing'], pinned: pin, ran: pin, options: selection } }], sideTurns: [], card: { project: 'Selection project', sources: [], changes: { added: 0, removed: 0, files: 0 }, subagents: { active: 0, done: 0 } } }); save();
            }
            if (fixture.mode === 'unknown') return { ok: false, reason: 'UNKNOWN_OUTCOME_HELD', outcome: 'UNKNOWN', detail: 'Controlled unknown admission.' };
            if (fixture.mode === 'lost') throw new Error('Controlled response loss after admission');
            fixture.emit(); return { ok: true, value: { selection, started: { threadId: 't', turnId: 'turn' }, detail: 'Started on the selected route.' } };
          }
          case 'turns.send':
            state.normal.push(structuredClone(args)); save();
            if (fixture.holdNormal) await new Promise<void>((r) => { fixture.releaseNormal = () => { fixture.holdNormal = false; r(); }; });
            return fixture.normalOk ? { ok: true, value: { threadId: 't', turnId: 'normal-turn' } } : { ok: false, reason: 'CONTROL', detail: 'Ordinary send observed.' };
          case 'goals.set': if (state.failGoal === 'goals.set') throw new Error('Controlled goal setup failure'); return { ok: true, value: {} };
          case 'goals.run': return { ok: true, value: {} };
          default: return null;
        }
      },
    } });
  }, { prefs: DEFAULT_PREFS });
  await page.goto(url); await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
});
async function open(page: Page) { await page.getByRole('button', { name: /^Model and effort:/ }).click(); await page.getByRole('menuitem', { name: 'Choose route for this task…' }).click(); return page.getByRole('dialog', { name: 'Choose a route for this task' }); }
async function compare(page: Page) { const dialog = await open(page); await dialog.getByRole('button', { name: 'Compare available routes' }).click(); await expect(dialog.getByRole('heading', { name: 'Recommended route' })).toBeVisible(); return dialog; }

test('route comparison displays current use, concrete setup and entitlement prerequisites', async ({ page }) => {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Compare routes for my brief');
  await page.evaluate(() => {
    const selection = (window as any).fixture.selection;
    selection.choice.route.availability = { state: 'now', detail: 'Observed local endpoint.' };
    const excluded = selection.excluded[0];
    excluded.route.availability = { state: 'setup', detail: 'Select the Pi engine for this home.' };
    selection.excluded.push({ route: { ...excluded.route, id: 'unconfigured-api', availability: { state: 'entitlement', detail: 'Supply an entitled API key.' } }, reasons: ['API access has not been established.'] });
  });
  const dialog = await compare(page);
  // The heading confirms this render committed; absent metadata should fail before the hang guard.
  await expect(dialog.locator('[data-availability="now"]')).toContainText('Observed local endpoint.', { timeout: 5000 });
  await dialog.getByText('Excluded routes (2)', { exact: true }).click();
  await expect(dialog.locator('[data-availability="setup"]')).toContainText('Select the Pi engine for this home.', { timeout: 5000 });
  await expect(dialog.locator('[data-availability="entitlement"]')).toContainText('Supply an entitled API key.', { timeout: 5000 });
  expect(await page.evaluate(() => (window as any).fixture.state.requests)).toHaveLength(0);
});

test('constraints, reasons and recorded route are visible without changing ordinary composing', async ({ page }) => {
  const message = page.getByRole('textbox', { name: 'Message', exact: true }); await message.fill('Summarise the notes');
  let dialog = await compare(page);
  await dialog.getByText('Excluded routes (1)', { exact: true }).click(); await expect(dialog).toContainText('costs more than allowed');
  await dialog.getByText('Current limits', { exact: true }).click(); await expect(dialog).toContainText('does not use Arena evidence');
  await page.keyboard.press('Escape'); await expect(message).toHaveValue('Summarise the notes'); await expect(message).toBeFocused();
  dialog = await compare(page); await dialog.getByRole('button', { name: 'Choose again and run' }).click();
  await expect(page.getByTestId('turn-selection')).toContainText('Route recorded for execution');
  await page.getByTestId('turn-selection').locator('summary').first().click(); await expect(page.getByTestId('turn-selection')).toContainText('Existing plan allowed');
  expect(await page.evaluate(() => (window as any).fixture.state.requests[0].task)).toEqual({ needs: ['model', 'files'], network: true, spend: 'plan' });
  await expect(page.getByTestId('selection-followup')).toBeVisible(); await expect(message).toHaveValue('');
});

test('an unavailable execution keeps the draft and gives the concrete dependency', async ({ page }) => {
  await page.evaluate(() => { (window as any).fixture.mode = 'no-start'; });
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Prepare a brief');
  const dialog = await compare(page); await dialog.getByRole('button', { name: 'Choose again and run' }).click();
  await expect(dialog.getByRole('alert')).toContainText('needs the Codex engine');
  await page.keyboard.press('Escape'); await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('Prepare a brief');
});

for (const mode of ['lost', 'unknown']) test(`${mode}: reload retries the exact submission once, never falling back to ordinary send`, async ({ page }) => {
  await page.evaluate((mode) => { (window as any).fixture.mode = mode; }, mode);
  const message = page.getByRole('textbox', { name: 'Message', exact: true }); await message.fill('Preserve this submission');
  let dialog = await compare(page); await dialog.getByRole('button', { name: 'Choose again and run' }).click();
  await expect(dialog.getByRole('alert')).toContainText(mode === 'lost' ? 'could not be confirmed' : 'unknown outcome');
  const first = await page.evaluate(() => (window as any).fixture.state.requests[0]);
  await page.reload(); await expect(message).toHaveValue('Preserve this submission');
  await message.press('Enter'); await expect(page.getByRole('alert')).toContainText('last try was never answered');
  dialog = await open(page); await expect(dialog.getByLabel('Spending category')).toBeDisabled();
  await dialog.getByRole('button', { name: 'Retry existing submission' }).click();
  await expect(page.getByTestId('turn-selection')).toContainText('Route recorded for execution');
  const state = await page.evaluate(() => (window as any).fixture.state);
  expect(state.requests).toEqual([first, first]); expect(state.threads).toHaveLength(1); expect(state.normal).toHaveLength(0);
});

test('typing while the submission is pending survives navigation to its new thread', async ({ page }) => {
  await page.evaluate(() => { (window as any).fixture.holdRun = true; });
  const message = page.getByRole('textbox', { name: 'Message', exact: true }); await message.fill('First task');
  const dialog = await compare(page); await dialog.getByRole('button', { name: 'Choose again and run' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.state.requests.length)).toBe(1);
  await page.keyboard.press('Escape'); await message.fill('Newer unsent follow-up');
  await page.evaluate(() => (window as any).fixture.releaseRun());
  await expect(page.getByTestId('turn-selection')).toBeVisible(); await expect(message).toHaveValue('Newer unsent follow-up');
});

test('selection preserves all attached source IDs through response loss and reload', async ({ page }) => {
  await page.getByTestId('attach-input').setInputFiles([{ name: 'note.md', mimeType: 'text/markdown', buffer: Buffer.from('# Note') }, { name: 'context.md', mimeType: 'text/markdown', buffer: Buffer.from('# Context') }]);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Use the attached sources');
  await page.evaluate(() => { (window as any).fixture.mode = 'lost'; });
  let dialog = await compare(page); await dialog.getByRole('button', { name: 'Choose again and run' }).click();
  await expect(dialog.getByRole('alert')).toContainText('could not be confirmed');
  const first = await page.evaluate(() => (window as any).fixture.state.requests[0]); expect(first.attachments).toEqual(['file-1', 'file-2']);
  await page.reload(); await expect(page.getByTestId('attachment-chip')).toHaveText(['note.md', 'context.md']);
  dialog = await open(page); await dialog.getByRole('button', { name: 'Retry existing submission' }).click();
  await expect(page.getByTestId('turn-selection')).toBeVisible();
  expect(await page.evaluate(() => (window as any).fixture.state.requests)).toEqual([first, first]);
  await expect(page.getByTestId('turn').getByRole('button', { name: 'note.md v1', exact: true })).toBeVisible();
  await expect(page.getByTestId('turn').getByRole('button', { name: 'context.md v1', exact: true })).toBeVisible();
});

for (const width of [375, 1440]) for (const colorScheme of ['light', 'dark'] as const) {
  test(`route comparison fits ${width}px in ${colorScheme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 812 }); await page.emulateMedia({ colorScheme });
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Compare routes for this task');
    const dialog = await compare(page);
    await dialog.getByText('Excluded routes (1)', { exact: true }).click();
    const box = (await dialog.boundingBox())!; expect(box.x).toBeGreaterThanOrEqual(8); expect(box.x + box.width).toBeLessThanOrEqual(width - 8);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`comparison-${width}-${colorScheme}.png`), fullPage: true });
  });
}

test('an unreadable draft source stays visible and removable rather than disappearing', async ({ page }) => {
  await page.getByTestId('attach-input').setInputFiles({ name: 'note.md', mimeType: 'text/markdown', buffer: Buffer.from('# Note') });
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Use this source');
  await expect(page.getByTestId('draft-state')).toHaveText('Draft saved');
  await page.evaluate(() => { const f = (window as any).fixture; f.state.failRead = true; sessionStorage.setItem('selection-fixture', JSON.stringify(f.state)); });
  await page.reload();
  await expect(page.getByTestId('attachment-chip')).toContainText('Unavailable source 1');
  await page.getByRole('button', { name: 'Remove Unavailable source 1', exact: true }).click();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.state.normal.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).fixture.state.normal[0].attachments)).toEqual([]);
});

for (const mode of ['lost', 'unknown']) test(`${mode}: editing keeps the original selection locked and a separate newer draft through retry`, async ({ page }) => {
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await page.getByTestId('attach-input').setInputFiles({ name: 'note.md', mimeType: 'text/markdown', buffer: Buffer.from('# Original') });
  await message.fill('Original task');
  await page.evaluate((mode) => { (window as any).fixture.mode = mode; }, mode);
  let dialog = await compare(page); await dialog.getByRole('button', { name: 'Choose again and run' }).click();
  await expect(dialog.getByRole('alert')).toContainText(mode === 'lost' ? 'could not be confirmed' : 'unknown outcome');
  const first = await page.evaluate(() => (window as any).fixture.state.requests[0]);
  await page.keyboard.press('Escape');
  await message.fill('A different newer draft');
  await page.getByTestId('attach-input').setInputFiles({ name: 'context.md', mimeType: 'text/markdown', buffer: Buffer.from('# Later') });
  await expect(page.getByTestId('draft-state')).toHaveText('Draft saved');
  await page.reload(); await expect(message).toHaveValue('A different newer draft');
  await message.press('Enter'); await expect(page.getByRole('alert')).toContainText('last try was never answered');
  dialog = await open(page); await expect(dialog.getByLabel('Task message')).toHaveText('Original task');
  await expect(dialog.getByLabel('Spending category')).toBeDisabled();
  // Observe acknowledgement of navigation while retaining the fixture's fixed viewer.get.
  await page.evaluate(() => {
    const api = (window as any).backbone; const call = api.call;
    api.call = async (method: string, args: any) => {
      const result = await call(method, args);
      if (method === 'viewer.put' && args.prefs.selectedThreadId === 't') (window as any).navigationSaved = true;
      return result;
    };
  });
  await dialog.getByRole('button', { name: 'Retry existing submission' }).click();
  await expect(page.getByTestId('turn-selection')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).navigationSaved === true)).toBe(true);
  await expect(message).toHaveValue('A different newer draft');
  await expect(page.getByTestId('attachment-chip')).toHaveText(['note.md', 'context.md']);
  expect(await page.evaluate(() => (window as any).fixture.state.requests)).toEqual([first, first]);
  // Diagnostic only: record both custody locations and the fixture's viewer answer on each side
  // of this reload, including when the existing assertion fails. Do not wait for a save here.
  const reloadEvidence: unknown[] = [];
  const snapshot = () => page.evaluate(async () => {
    const api = (window as any).backbone;
    const state = (window as any).fixture.state;
    const threadId = state.threads[0]?.summary.id;
    return {
      home: state.drafts['composer:home:p'] ?? null,
      thread: threadId ? state.drafts[`composer:${threadId}`] ?? null : null,
      viewer: await api.call('viewer.get', {}),
      leftPrefs: sessionStorage.getItem('viewer-left'),
      message: (document.querySelector('textarea[id^="composer-"]') as HTMLTextAreaElement | null)?.value ?? null,
    };
  });
  reloadEvidence.push({ stage: 'before reload', value: await snapshot() });
  try {
    await page.reload();
    try { await expect(message).toHaveValue('A different newer draft'); }
    finally { reloadEvidence.push({ stage: 'after reload', value: await snapshot() }); }
  } finally {
    await test.info().attach('draft-reload-observation', { body: JSON.stringify(reloadEvidence, null, 2), contentType: 'application/json' });
  }
  await message.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).fixture.state.normal.length)).toBe(1);
  const normal = await page.evaluate(() => (window as any).fixture.state.normal[0]);
  expect(normal.text).toBe('A different newer draft'); expect(normal.attachments).toEqual(['file-1', 'file-2']);
});

test('typing before the retry key finishes saving cannot erase selection custody', async ({ page }) => {
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await message.fill('Original before key save');
  await page.evaluate(() => { const f = (window as any).fixture; f.mode = 'lost'; f.holdDraft = true; });
  const dialog = await compare(page);
  await dialog.getByRole('button', { name: 'Choose again and run' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.waitingDraft)).toBe(true);
  await page.keyboard.press('Escape'); await message.fill('Typed while key was saving');
  await page.evaluate(() => (window as any).fixture.releaseDraft());
  await expect(page.getByRole('alert')).toContainText('could not be confirmed');
  await expect(page.getByTestId('draft-state')).toHaveText('Draft saved');
  await page.reload(); await expect(message).toHaveValue('Typed while key was saving');
  await message.press('Enter'); await expect(page.getByRole('alert')).toContainText('last try was never answered');
  const retry = await open(page); await expect(retry.getByLabel('Task message')).toHaveText('Original before key save');
  await expect(retry.getByRole('button', { name: 'Retry existing submission' })).toBeEnabled();
  const state = await page.evaluate(() => (window as any).fixture.state);
  expect(state.requests).toHaveLength(1); expect(state.normal).toHaveLength(0);
});

test('a stopped turn with readable written files shows its actual verification limitation', async ({ page }) => {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Write a brief');
  const dialog = await compare(page); await dialog.getByRole('button', { name: 'Choose again and run' }).click();
  await expect(page.getByTestId('turn-selection')).toBeVisible();
  await page.evaluate(() => {
    const f = (window as any).fixture, turn = f.state.threads[0].turns[0];
    turn.status = 'stopped'; turn.answer.files = [{ materialId: 'out', name: 'brief.md', version: 1 }];
    f.state.verification = { complete: false, checks: [{ name: 'brief.md', ok: true, version: 1 }], summary: 'Not done: the turn ended stopped.' };
    f.emit();
  });
  await page.getByTestId('turn-selection').locator('summary').first().click();
  await page.getByRole('button', { name: 'Check written file versions' }).click();
  const checks = page.getByRole('region', { name: 'Written version checks' });
  await expect(checks).toContainText('Not done: the turn ended stopped.');
  await expect(checks).toContainText('brief.md v1: passed');
  await expect(checks).not.toContainText('Some recorded files did not pass.');
});

for (const invalid of ['malformed', 'another-project']) test(`${invalid}: an explicit discard releases only the local retry and keeps the draft`, async ({ page }) => {
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await page.getByTestId('attach-input').setInputFiles({ name: 'note.md', mimeType: 'text/markdown', buffer: Buffer.from('# Keep') });
  await message.fill('Keep my current draft');
  await page.evaluate(() => { (window as any).fixture.mode = 'lost'; });
  let dialog = await compare(page); await dialog.getByRole('button', { name: 'Choose again and run' }).click();
  await expect(dialog.getByRole('alert')).toContainText('could not be confirmed');
  await page.evaluate((invalid) => {
    const f = (window as any).fixture, draft = Object.values(f.state.drafts).find((d: any) => d.meta?.sendHow === 'selection') as any;
    const selected = JSON.parse(draft.meta.selectionSubmission); selected.projectId = 'another-project';
    draft.meta.selectionSubmission = invalid === 'malformed' ? '{' : JSON.stringify(selected);
    sessionStorage.setItem('selection-fixture', JSON.stringify(f.state));
  }, invalid);
  await page.reload(); await expect(message).toHaveValue('Keep my current draft');
  await message.press('Enter'); await expect(page.getByRole('alert')).toContainText('last try was never answered');
  await page.getByRole('button', { name: 'Discard saved retry…', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Discard saved retry?' });
  await expect(dialog).toContainText('does not stop work'); await dialog.getByRole('button', { name: 'Keep saved retry', exact: true }).click();
  await page.reload(); await expect(page.getByRole('button', { name: 'Discard saved retry…', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Discard saved retry…', exact: true }).click();
  await page.getByRole('dialog', { name: 'Discard saved retry?' }).getByRole('button', { name: 'Discard saved retry', exact: true }).click();
  await expect(message).toBeFocused(); await expect(message).toHaveValue('Keep my current draft');
  await expect(page.getByTestId('attachment-chip')).toContainText('note.md');
  await expect(page.getByTestId('discarded-retry-notice')).toContainText('outcome is still unknown');
  await page.reload(); await expect(page.getByRole('button', { name: 'Discard saved retry…', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('discarded-retry-notice')).toContainText('Check Chats');
  const before = await page.evaluate(() => (window as any).fixture.state);
  expect(before.requests).toHaveLength(1); expect(before.threads).toHaveLength(1); expect(before.normal).toHaveLength(0);
  await page.evaluate(() => { (window as any).fixture.normalOk = true; });
  await message.press('Enter'); await expect.poll(() => page.evaluate(() => (window as any).fixture.state.normal.length)).toBe(1);
  await expect(page.getByTestId('discarded-retry-notice')).toHaveCount(0);
});

test('a pending no-project draft is not moved or cleared on selecting a project', async ({ page }) => {
  await page.evaluate(() => {
    const f = (window as any).fixture;
    f.state.drafts['composer:home:none'] = { key: 'composer:home:none', text: 'Unconfirmed without project', meta: { sendKey: 'old-key', sendHow: 'selection', selectionSubmission: '{' }, updatedAt: new Date().toISOString() };
    sessionStorage.setItem('selection-fixture', JSON.stringify(f.state));
  });
  await page.reload(); await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('');
  const draft = await page.evaluate(() => (window as any).fixture.state.drafts['composer:home:none']);
  expect(draft.text).toBe('Unconfirmed without project'); expect(draft.meta.sendKey).toBe('old-key');
});

test('an answer to an unmounted composer cannot clear typing after returning to the same draft', async ({ page }) => {
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await message.fill('Original before leaving'); await page.evaluate(() => { (window as any).fixture.holdRun = true; });
  const dialog = await compare(page); await dialog.getByRole('button', { name: 'Choose again and run' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.state.requests.length)).toBe(1);
  await page.keyboard.press('Escape');
  await page.getByRole('navigation', { name: 'Projects and threads' }).getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Memory', exact: true }).click();
  await expect(message).toHaveCount(0);
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(message).toHaveValue('Original before leaving'); await message.fill('Typed after returning');
  await expect(page.getByTestId('draft-state')).toHaveText('Draft saved');
  await page.evaluate(() => { const f = (window as any).fixture; f.holdRun = false; f.releaseRun(); });
  await expect.poll(() => page.evaluate(() => (window as any).fixture.state.threads.length)).toBe(1);
  await expect(page.getByTestId('sent-notice')).toContainText('earlier message was sent');
  await expect(page.getByRole('button', { name: 'Open sent chat', exact: true })).toBeVisible();
  await expect(message).toHaveValue('Typed after returning');
  await page.reload(); await expect(message).toHaveValue('Typed after returning');
  await message.press('Enter'); await expect(page.getByRole('alert')).toContainText('last try was never answered');
  expect(await page.evaluate(() => (window as any).fixture.state.normal)).toHaveLength(0);
});

for (const failure of ['threads.get', 'goals.set']) test(`${failure}: goal setup failure after admission never presents the message as unsent`, async ({ page }) => {
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await message.fill('Initial selected task');
  const dialog = await compare(page); await dialog.getByRole('button', { name: 'Choose again and run' }).click();
  await expect(page.getByTestId('turn-selection')).toBeVisible();
  await page.evaluate((failure) => { const f = (window as any).fixture; f.normalOk = true; f.state.failGoal = failure; }, failure);
  await message.fill('/goal Prepare the next brief'); await message.press('Enter');
  await expect(message).toHaveValue('');
  await expect(page.getByTestId('sent-notice')).toContainText('Your message was sent, but goal setup could not be confirmed.');
  await page.evaluate(() => { const f = (window as any).fixture; f.state.failGoal = undefined; sessionStorage.setItem('selection-fixture', JSON.stringify(f.state)); });
  await page.reload(); await expect(message).toHaveValue('');
  const state = await page.evaluate(() => (window as any).fixture.state);
  expect(state.normal).toHaveLength(1); expect(state.normal[0].text).toBe('Prepare the next brief');
  expect(state.drafts['composer:t']?.meta?.sendKey).toBeUndefined();
});

test('a late ordinary admission stays visible while newer text remains a draft', async ({ page }) => {
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await message.fill('Create the existing chat'); const dialog = await compare(page);
  await dialog.getByRole('button', { name: 'Choose again and run' }).click(); await expect(page.getByTestId('turn-selection')).toBeVisible();
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await page.evaluate(() => { const f = (window as any).fixture; f.normalOk = true; f.holdNormal = true; });
  await message.fill('Ordinary message before leaving'); await message.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).fixture.state.normal.length)).toBe(1);
  await page.getByRole('navigation', { name: 'Projects and threads' }).getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Memory', exact: true }).click(); await expect(message).toHaveCount(0);
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await message.fill('Newer ordinary draft'); await expect(page.getByTestId('draft-state')).toHaveText('Draft saved');
  await page.evaluate(() => (window as any).fixture.releaseNormal());
  await expect(page.getByTestId('sent-notice')).toContainText('earlier message was sent');
  await expect(message).toHaveValue('Newer ordinary draft'); await message.fill('Still a newer draft');
  await expect(page.getByRole('button', { name: 'Open sent chat', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).fixture.state.normal)).toHaveLength(1);
});

test('an empty stored draft still exposes its pending selection immediately', async ({ page }) => {
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await message.fill('Original task with empty later draft'); await page.evaluate(() => { (window as any).fixture.mode = 'lost'; });
  const dialog = await compare(page); await dialog.getByRole('button', { name: 'Choose again and run' }).click();
  await expect(dialog.getByRole('alert')).toContainText('could not be confirmed');
  await page.evaluate(() => { const f = (window as any).fixture; for (const draft of Object.values(f.state.drafts) as any[]) if (draft.meta?.sendKey) draft.text = ''; sessionStorage.setItem('selection-fixture', JSON.stringify(f.state)); });
  await page.reload(); await expect(message).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Discard saved retry…', exact: true })).toBeVisible();
  const retry = await open(page); await expect(retry.getByLabel('Task message')).toHaveText('Original task with empty later draft');
});

test('a failed discard save reports uncertainty and keeps the warning through explicit recovery', async ({ page }) => {
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await message.fill('Keep this draft after a failed discard'); await page.evaluate(() => { (window as any).fixture.mode = 'lost'; });
  const selector = await compare(page); await selector.getByRole('button', { name: 'Choose again and run' }).click();
  await expect(selector.getByRole('alert')).toContainText('could not be confirmed'); await page.keyboard.press('Escape');
  await page.evaluate(() => { (window as any).fixture.state.failDiscardSave = true; });
  await page.getByRole('button', { name: 'Discard saved retry…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Discard saved retry?' });
  await dialog.getByRole('button', { name: 'Discard saved retry', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Discard could not be confirmed. Saving may still apply it later');
  await page.evaluate(() => { (window as any).fixture.state.failDiscardSave = false; });
  await dialog.getByRole('button', { name: 'Discard saved retry', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(page.getByTestId('discarded-retry-notice')).toContainText('outcome is still unknown');
  const attempts = await page.evaluate(() => (window as any).fixture.draftPuts.filter((p: any) => p.meta?.retryNotice && !p.meta?.sendKey));
  expect(attempts.length).toBeGreaterThanOrEqual(2); expect(attempts[1]).toEqual(attempts[0]);
  await expect(message).toHaveValue('Keep this draft after a failed discard');
  expect(await page.evaluate(() => (window as any).fixture.state.normal)).toHaveLength(0);
});

test('an uncertain composer draft can retry the same saved request', async ({page}) => {
  const message=page.getByRole('textbox',{name:'Message',exact:true});
  await page.evaluate(()=>{(window as any).fixture.state.loseNextDraft=true;});
  await message.fill('Draft with lost acknowledgement');
  const retry=page.getByRole('button',{name:'Retry saving draft'});await expect(retry).toBeVisible();
  const before=await page.evaluate(()=>(window as any).fixture.draftPuts.at(-1));
  await retry.click();await expect(retry).toHaveCount(0);await expect(message).toHaveValue('Draft with lost acknowledgement');
  const attempts=await page.evaluate(()=>(window as any).fixture.draftPuts);expect(attempts.at(-1)).toEqual(before);
});

test('a stale retry opens draft review and preserves the unconfirmed selection', async ({page}) => {
  const message=page.getByRole('textbox',{name:'Message',exact:true});
  await message.fill('Keep this text');await page.evaluate(()=>{(window as any).fixture.mode='lost';});
  const selection=await compare(page);await selection.getByRole('button',{name:'Choose again and run'}).click();await expect(selection.getByRole('alert')).toContainText('could not be confirmed');
  await page.keyboard.press('Escape');
  await page.evaluate(()=>{(window as any).fixture.state.failDiscardSave=true;});
  await page.getByRole('button',{name:'Discard saved retry…',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Discard saved retry?'});await dialog.getByRole('button',{name:'Discard saved retry',exact:true}).click();
  await expect(dialog.getByRole('alert')).toContainText('Discard could not be confirmed');
  await page.evaluate(()=>{(window as any).fixture.state.failDiscardSave='stale';});
  await dialog.getByRole('button',{name:'Discard saved retry',exact:true}).click();
  await expect(dialog).toHaveCount(0);await expect(page.getByRole('button',{name:'Review saved draft'})).toBeVisible();
  await expect(message).toHaveValue('Keep this text');await expect(page.getByRole('button',{name:'Discard saved retry…',exact:true})).toBeVisible();
});

test('moving an ordinary no-project draft preserves an existing discarded-retry warning', async ({ page }) => {
  await page.evaluate(() => {
    const f = (window as any).fixture, at = new Date().toISOString();
    f.state.drafts['composer:home:p'] = { key: 'composer:home:p', text: '', meta: { retryNotice: 'Earlier outcome is still unknown. Check Chats.' }, updatedAt: at };
    f.state.drafts['composer:home:none'] = { key: 'composer:home:none', text: 'Carry this ordinary draft', updatedAt: at };
    sessionStorage.setItem('selection-fixture', JSON.stringify(f.state));
  });
  await page.reload(); await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('Carry this ordinary draft');
  await expect(page.getByTestId('discarded-retry-notice')).toContainText('Earlier outcome is still unknown');
  await expect(page.getByTestId('draft-state')).toHaveText('Draft saved');
  const state = await page.evaluate(() => (window as any).fixture.state);
  expect(state.drafts['composer:home:p'].meta.retryNotice).toContain('Check Chats');
});


test('an automated goal route never replaces the chat choice shown by the composer', async ({ page }) => {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('A restricted personal task');
  let dialog = await open(page);
  await dialog.getByLabel('Model connection').selectOption('false');
  await dialog.getByLabel('Spending category').selectOption('none');
  await dialog.getByRole('button', { name: 'Compare available routes' }).click();
  await dialog.getByRole('button', { name: 'Choose again and run' }).click();
  await expect(page.getByTestId('selection-followup')).toContainText('Small model on this computer');
  await page.evaluate(() => {
    const f = (window as any).fixture, goal = structuredClone(f.state.threads[0].turns[0]);
    goal.id = 'goal-turn'; goal.user.text = 'An automated goal check';
    goal.selection.origin = 'goal-run'; goal.selection.routeId = 'local:test:goal'; delete goal.selection.options;
    goal.selection.task = { needs: ['model'], network: true, spend: 'metered' };
    goal.selection.pinned = { kind: 'endpoint', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:4321/v1', model: 'goal-model', label: 'Goal run model' };
    goal.selection.ran = goal.selection.pinned;
    f.state.threads[0].turns.push(goal); f.emit();
  });
  await expect(page.getByTestId('turn-selection')).toHaveCount(2);
  await expect(page.getByTestId('selection-followup')).toContainText('Small model on this computer');
  await expect(page.getByTestId('selection-followup')).not.toContainText('Goal run model');
  await page.getByRole('button', { name: 'Review or change requirements', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Choose a route for this task' });
  await expect(dialog.getByLabel('Model connection')).toHaveValue('false');
  await expect(dialog.getByLabel('Spending category')).toHaveValue('none');
});


test('draft hydration blocks edits until saved retry custody and text are restored', async ({ page }) => {
  await page.evaluate(() => {
    const f = (window as any).fixture;
    f.state.holdDraftRead = true;
    f.state.drafts['composer:home:p'] = { key: 'composer:home:p', text: 'Kept pending draft', updatedAt: new Date().toISOString(), meta: { sendKey: 'original-key', sendHow: 'selection' } };
    sessionStorage.setItem('selection-fixture', JSON.stringify(f.state));
  });
  await page.reload();
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(message).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await expect(page.getByRole('status').filter({ hasText: 'Loading draft…' })).toBeVisible();
  await page.evaluate(() => (window as any).fixture.releaseDraftRead());
  await expect(message).toBeEnabled();
  await expect(message).toHaveValue('Kept pending draft');
  await expect(page.getByRole('button', { name: 'Discard saved retry…', exact: true })).toBeVisible();
  await message.fill('Newer words');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  expect(await page.evaluate(() => (window as any).fixture.state.normal)).toEqual([]);
});

test('failed draft reads keep composing closed until retry restores the saved notice', async ({ page }) => {
  await page.evaluate(() => {
    const f = (window as any).fixture;
    f.state.failDraftRead = true;
    f.state.drafts['composer:home:p'] = { key: 'composer:home:p', text: 'Kept draft', updatedAt: new Date().toISOString(), meta: { retryNotice: 'Earlier outcome is still unknown. Check Chats.' } };
    sessionStorage.setItem('selection-fixture', JSON.stringify(f.state));
  });
  await page.reload();
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(message).toBeDisabled();
  await page.evaluate(() => { (window as any).fixture.state.failDraftRead = false; });
  await page.getByRole('button', { name: 'Try loading again' }).click();
  await expect(message).toBeEnabled();
  await expect(message).toHaveValue('Kept draft');
  await expect(page.getByTestId('discarded-retry-notice')).toContainText('Earlier outcome is still unknown');
});

test('a stuck draft read can be retried without a late response replacing newer edits', async ({ page }) => {
  await page.evaluate(() => {
    const f = (window as any).fixture;
    f.state.holdOneDraftRead = true;
    f.state.drafts['composer:home:p'] = { key: 'composer:home:p', text: 'Saved draft', updatedAt: new Date().toISOString(), meta: { sendKey: 'original-key', sendHow: 'selection' } };
    sessionStorage.setItem('selection-fixture', JSON.stringify(f.state));
  });
  await page.reload();
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(message).toBeDisabled();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.state.waitingOneDraftRead)).toBe(true);
  await page.evaluate(() => { (window as any).fixture.state.holdOneDraftRead = false; });
  await page.getByRole('button', { name: 'Try loading again' }).click();
  await expect(message).toHaveValue('Saved draft');
  await expect(page.getByRole('button', { name: 'Discard saved retry…' })).toBeVisible();
  await message.fill('Newer words');
  await page.evaluate(async () => { (window as any).fixture.releaseDraftRead(); await new Promise((r) => setTimeout(r, 0)); });
  await expect(message).toHaveValue('Newer words');
  expect(await page.evaluate(() => (window as any).fixture.state.normal)).toEqual([]);
});


test('slow source hydration retains the restored source when another is attached', async ({ page }) => {
  await page.evaluate(() => {
    const f = (window as any).fixture;
    f.state.holdMaterialRead = true;
    f.state.materials['file-1'] = { id: 'file-1', name: 'original.md', projectId: 'p', current: 1, versions: [] };
    f.state.drafts['composer:home:p'] = { key: 'composer:home:p', text: 'Use both sources', updatedAt: new Date().toISOString(), meta: { attachments: 'file-1' } };
    sessionStorage.setItem('selection-fixture', JSON.stringify(f.state));
  });
  await page.reload();
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(message).toBeDisabled();
  await expect(page.getByTestId('attach-input')).toBeDisabled();
  await page.evaluate(() => (window as any).fixture.releaseMaterialRead());
  await expect(message).toBeEnabled();
  await expect(page.getByTestId('attachment-chip')).toHaveText(['original.md']);
  await page.getByTestId('attach-input').setInputFiles({ name: 'new.md', mimeType: 'text/markdown', buffer: Buffer.from('New source') });
  await expect(page.getByTestId('attachment-chip')).toHaveText(['original.md', 'new.md']);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.state.normal[0]?.attachments)).toEqual(['file-1', 'file-2']);
});

test('a stuck source read offers retry while preserving the saved attachment', async ({ page }) => {
  await page.evaluate(() => {
    const f = (window as any).fixture;
    f.state.holdMaterialRead = true;
    f.state.materials['file-1'] = { id: 'file-1', name: 'original.md', projectId: 'p', current: 1, versions: [] };
    f.state.drafts['composer:home:p'] = { key: 'composer:home:p', text: 'Saved draft', updatedAt: new Date().toISOString(), meta: { attachments: 'file-1' } };
    sessionStorage.setItem('selection-fixture', JSON.stringify(f.state));
  });
  await page.reload();
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(message).toBeDisabled();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.state.waitingMaterialRead)).toBe(true);
  await page.evaluate(() => { (window as any).fixture.state.holdMaterialRead = false; });
  await page.getByRole('button', { name: 'Try loading again' }).click();
  await expect(message).toHaveValue('Saved draft');
  await expect(page.getByTestId('attachment-chip')).toHaveText(['original.md']);
  await message.fill('Newer words');
  await page.evaluate(async () => { (window as any).fixture.releaseMaterialRead(); await new Promise((r) => setTimeout(r, 0)); });
  await expect(message).toHaveValue('Newer words');
  await expect(page.getByTestId('attachment-chip')).toHaveText(['original.md']);
});

test('closing model connections returns keyboard focus to the composer control', async ({ page }) => {
  const control = page.getByRole('button', { name: /^Model and effort:/ });
  await control.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: 'Model connections…' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toHaveCount(0);
  await expect(control).toBeFocused();
});
