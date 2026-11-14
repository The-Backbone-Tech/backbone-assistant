// Real app and platform, controlled harness, synthetic documents. Hold transport at the actual
// save boundary so typing after Save is a different revision, not a timing-dependent assertion.
import { expect, test, type Page } from '@playwright/test';
import { removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { startBridge, stopBridge } from './bridge';
import { api, phase2ProjectAndAttach, phase3Brief } from './journey';

async function cleanup(page: Page, bridge: Awaited<ReturnType<typeof startBridge>>, home: string) {
  // A timed-out test may already have a closed page. Still stop its owned bridge and data home;
  // transport teardown must not mask the product assertion or strand the test process.
  await page.unrouteAll({ behavior: 'wait' }).catch(() => {});
  if (bridge.proc.exitCode === null && bridge.proc.signalCode === null) await stopBridge(bridge.proc);
  await removeDataHome(home);
}

async function openBrief(page: Page, url: string) {
  await page.goto(url);
  await expect(page.locator('[data-ready=true]')).toBeVisible();
  const projectId = await phase2ProjectAndAttach(page);
  await phase3Brief(page);
  await page.keyboard.press('ControlOrMeta+p');
  await page.getByTestId('file-row').filter({ hasText: 'brief.md' }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Edit brief.md' });
  await expect(editor).toBeVisible();
  const entries = await api<{ id: string; name: string }[]>(page, 'material.list', { projectId });
  return { editor, brief: entries.find((x) => x.name === 'brief.md')! };
}

test('typing after Save starts survives its response and reload, then saves as the next version', async ({ page }) => {
  const home = freshDataHome('save-next-edit');
  const bridge = await startBridge(home);
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let committed = false;
  try {
    const { editor, brief } = await openBrief(page, bridge.url);
    await page.getByTestId('turn').first().getByRole('button', { name: /^brief\.md\s*v1$/ }).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const first = '# First reviewed revision';
    const next = '# More human typing while Save is pending';
    await editor.fill(first);
    await page.route('**/api', async (route) => {
      if (route.request().postDataJSON().method !== 'material.save') return route.continue();
      const response = await route.fetch();
      committed = true;
      await held;
      await route.fulfill({ response });
    });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => committed).toBe(true);
    await editor.fill(next);
    release();
    await page.unrouteAll({ behavior: 'wait' });
    await expect(editor, 'the saved snapshot must not replace later human typing').toContainText(next);
    await expect.poll(async () => (await api<{ text: string; meta?: { baseVersion: number } }>(page, 'drafts.get', { key: `edit:${brief.id}` }))?.meta?.baseVersion).toBe(2);
    // Saving from a result link selects the live workspace tab. A hard browser reload
    // reads acknowledged layout; native quit below tests the still-pending close handoff.
    await expect.poll(async () => (await api<{ pane: { active: string } }>(page, 'viewer.get', {})).pane.active).toBe(`file:${brief.id}`);
    await page.reload();
    await expect(editor).toContainText(next);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => (await api<{ ok: boolean; value: { entry: { current: number }; text: string } }>(page, 'material.read', { id: brief.id })).value).toMatchObject({ text: next, entry: { current: 3 } });
  } finally {
    release();
    await cleanup(page, bridge, home);
  }
});

test('an older in-flight autosave cannot resurrect a draft after Save clears it', async ({ page }) => {
  const home = freshDataHome('ordered-draft-clear');
  const bridge = await startBridge(home);
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let observed = false;
  try {
    const { editor, brief } = await openBrief(page, bridge.url);
    const words = '# Save this once';
    await page.route('**/api', async (route) => {
      const body = route.request().postDataJSON();
      if (body.method === 'drafts.put' && body.args.key === `edit:${brief.id}` && body.args.text === words) {
        observed = true;
        await held;
      }
      await route.continue();
    });
    await editor.fill(words);
    await expect.poll(() => observed).toBe(true);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => (await api<{ ok: boolean; value: { entry: { current: number } } }>(page, 'material.read', { id: brief.id })).value.entry.current).toBe(2);
    // Let Save finish in the UI before releasing the older request. The old implementation
    // clears the server draft first; an ordered writer can show the saved file while its
    // housekeeping clear waits behind the older draft transport.
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
    release();
    await page.unrouteAll({ behavior: 'wait' });
    await expect.poll(async () => (await api<{ text: string }>(page, 'drafts.get', { key: `edit:${brief.id}` }))?.text).toBe('');
    await page.reload();
    await expect(page.getByTestId('reader').filter({ visible: true })).toContainText(words.slice(2));
    await expect(page.getByRole('button', { name: 'Restore my edit', exact: true })).toHaveCount(0);
  } finally {
    release();
    await cleanup(page, bridge, home);
  }
});

test('an intentionally empty edit survives reload as an unsaved draft', async ({ page }) => {
  const home = freshDataHome('empty-edit');
  const bridge = await startBridge(home);
  try {
    const { editor, brief } = await openBrief(page, bridge.url);
    await editor.fill('');
    await expect.poll(async () => (await api<{ text: string; meta?: { baseVersion: number } }>(page, 'drafts.get', { key: `edit:${brief.id}` }))?.meta?.baseVersion).toBe(1);
    await page.reload();
    await expect(editor.locator('.cm-placeholder')).toHaveText('Empty file');
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => (await api<{ ok: boolean; value: { text: string; entry: { current: number } } }>(page, 'material.read', { id: brief.id })).value).toMatchObject({ text: '', entry: { current: 2 } });
  } finally {
    await cleanup(page, bridge, home);
  }
});

test('explicitly restoring a stale draft keeps the newer saved version in history', async ({ page }) => {
  const home = freshDataHome('restored-stale-edit');
  const bridge = await startBridge(home);
  try {
    const { editor, brief } = await openBrief(page, bridge.url);
    const oldEdit = '# My unfinished v1 edit';
    await editor.fill(oldEdit);
    await expect.poll(async () => (await api<{ text: string }>(page, 'drafts.get', { key: `edit:${brief.id}` }))?.text).toBe(oldEdit);
    const other = '# Another writer owns v2';
    await api(page, 'material.save', { id: brief.id, text: other, baseVersion: 1 });
    await page.reload();
    await page.getByRole('button', { name: 'Restore my edit', exact: true }).click();
    await expect(editor).toContainText(oldEdit);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
    const saved = await api<{ ok: boolean; value: { text: string; entry: { current: number } } }>(page, 'material.read', { id: brief.id });
    expect(saved.value.text).toBe(oldEdit);
    expect(saved.value.entry.current).toBe(3);
    const previous = await api<{ ok: boolean; value: { text: string } }>(page, 'material.read', { id: brief.id, version: 2 });
    expect(previous.value.text).toBe(other);
    await expect(editor).toContainText(oldEdit);
  } finally {
    await cleanup(page, bridge, home);
  }
});

test('later composer typing survives the response to the preceding message', async ({ page }) => {
  const home = freshDataHome('composer-next-draft');
  const bridge = await startBridge(home);
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let sent = false;
  try {
    await openBrief(page, bridge.url);
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    const next = 'Keep this next message while the first response finishes';
    await page.route('**/api', async (route) => {
      if (route.request().postDataJSON().method !== 'turns.send') return route.continue();
      const response = await route.fetch();
      sent = true;
      await held;
      await route.fulfill({ response });
    });
    await composer.fill('Summarize the context');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => sent).toBe(true);
    await composer.fill(next);
    release();
    await page.unrouteAll({ behavior: 'wait' });
    await expect(composer).toHaveValue(next);
    await expect(page.getByTestId('draft-state')).toHaveText('Draft saved');
    await page.reload();
    await expect(composer).toHaveValue(next);
  } finally {
    release();
    await cleanup(page, bridge, home);
  }
});

test('later Home typing follows the first message into its new thread', async ({ page }) => {
  const home = freshDataHome('home-next-draft');
  const bridge = await startBridge(home);
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let sent = false;
  try {
    await page.goto(bridge.url);
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    await phase2ProjectAndAttach(page);
    await page.route('**/api', async (route) => {
      if (route.request().postDataJSON().method !== 'turns.send') return route.continue();
      const response = await route.fetch();
      sent = true;
      await held;
      await route.fulfill({ response });
    });
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await composer.fill('Summarize the sources');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => sent).toBe(true);
    const next = 'The next question belongs to this conversation';
    await composer.fill(next);
    release();
    await page.unrouteAll({ behavior: 'wait' });
    await expect(page.getByRole('list', { name: 'Transcript' })).toBeVisible();
    await expect(composer).toHaveValue(next);
    await expect(page.getByTestId('draft-state')).toHaveText('Draft saved');
    // A hard browser reload cannot await the native close handoff. This case checks draft
    // transfer after the separately debounced view selection is acknowledged by its owner;
    // ordinary native quit is tested with pending persistence and no acknowledgement wait.
    const threads = await api<{ id: string }[]>(page, 'threads.list', {});
    await expect.poll(async () => (await api<{ selectedThreadId?: string }>(page, 'viewer.get', {})).selectedThreadId).toBe(threads[0].id);
    await page.reload();
    await expect(composer).toHaveValue(next);
  } finally {
    release();
    await cleanup(page, bridge, home);
  }
});

test('a destination draft failure keeps later Home typing durable before navigation', async ({ page }) => {
  const home = freshDataHome('home-transfer-failure');
  const bridge = await startBridge(home);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let destination = '';
  try {
    await page.goto(bridge.url);
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    const project = await phase2ProjectAndAttach(page);
    await page.route('**/api', async (route) => {
      const request = route.request().postDataJSON();
      if (request.method === 'turns.send') {
        const response = await route.fetch();
        destination = `composer:${(await response.json()).value.threadId}`;
        await held;
        return route.fulfill({ response });
      }
      if (request.method === 'drafts.put' && request.args.key === destination) {
        return route.fulfill({ status: 503, json: { ok: false, reason: 'NOT_AVAILABLE', detail: 'Controlled destination draft failure', outcome: 'REFUSED' } });
      }
      return route.continue();
    });
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await composer.fill('Summarize the sources');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => destination).not.toBe('');
    const next = 'Keep this next question when transfer fails';
    await composer.fill(next);
    release();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect.poll(async () => (await api<{ text: string }>(page, 'drafts.get', { key: `composer:home:${project}` }))?.text).toBe(next);
    await page.reload();
    await expect(composer).toHaveValue(next);
  } finally {
    release();
    await cleanup(page, bridge, home);
  }
});

test('a rejected Save from a reopened draft remains retryable', async ({ page }) => {
  const home = freshDataHome('reopened-save-failure');
  const bridge = await startBridge(home);
  try {
    const { editor, brief } = await openBrief(page, bridge.url);
    const text = '# Draft to retry after transport failure';
    await editor.fill(text);
    await expect.poll(async () => (await api<{ text: string }>(page, 'drafts.get', { key: `edit:${brief.id}` }))?.text).toBe(text);
    await page.reload();
    await expect(editor).toContainText(text);
    await page.route('**/api', (route) => route.request().postDataJSON().method === 'material.save' ? route.abort('failed') : route.continue());
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('could not finish');
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    await page.unrouteAll({ behavior: 'wait' });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => (await api<{ ok: boolean; value: { text: string; entry: { current: number } } }>(page, 'material.read', { id: brief.id })).value).toMatchObject({ text, entry: { current: 2 } });
  } finally {
    await cleanup(page, bridge, home);
  }
});

test('an older result link reopens its exact version while the human save stays current', async ({ page }) => {
  const home = freshDataHome('exact-result-view');
  const bridge = await startBridge(home);
  try {
    const { brief } = await openBrief(page, bridge.url);
    const newer = '# Newer human version kept current';
    await api(page, 'material.save', { id: brief.id, text: newer, baseVersion: 1 });
    await page.getByTestId('turn').first().getByRole('button', { name: /^brief\.md\s*v1$/ }).click();
    await expect(page.getByTestId('historical-version')).toContainText('Viewing v1');
    await expect(page.getByTestId('reader').filter({ visible: true })).toContainText('Write an editable brief from these');
    await expect(page.getByTestId('reader').filter({ visible: true })).not.toContainText(newer);
    await expect(page.getByRole('textbox', { name: 'Edit brief.md' })).toHaveCount(0);
    await expect.poll(async () => (await api<{ pane: { tabs: { version?: number }[] } }>(page, 'viewer.get', {})).pane.tabs.some((tab) => tab.version === 1)).toBe(true);
    await page.reload();
    await expect(page.getByTestId('historical-version')).toContainText('Viewing v1');
    await expect(page.getByTestId('reader').filter({ visible: true })).toContainText('Write an editable brief from these');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Document options', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Download', exact: true }).click();
    const file = await download;
    const stream = await file.createReadStream();
    let bytes = '';
    for await (const chunk of stream!) bytes += chunk.toString();
    expect(bytes).toContain('Write an editable brief from these');
    expect(bytes).not.toContain(newer);
    await page.getByRole('button', { name: 'Open current version', exact: true }).click();
    await expect(page.getByTestId('reader').filter({ visible: true })).toContainText(newer.slice(2));
    const current = await api<{ ok: boolean; value: { text: string; entry: { current: number } } }>(page, 'material.read', { id: brief.id });
    expect(current.value).toMatchObject({ text: newer, entry: { current: 2 } });
  } finally {
    await cleanup(page, bridge, home);
  }
});

test('a missing result version reports failure instead of opening current content', async ({ page }) => {
  const home = freshDataHome('missing-result-view');
  const bridge = await startBridge(home);
  try {
    const { brief } = await openBrief(page, bridge.url);
    // The app's own layout save must land first, or it overwrites what this seeds.
    await expect.poll(async () => (await api<{ pane: { active: string } }>(page, 'viewer.get', {})).pane.active).toBe(`file:${brief.id}`);
    const prefs = await api<Record<string, unknown>>(page, 'viewer.get', {});
    await api(page, 'viewer.put', { prefs: { ...prefs, pane: { open: true,
      tabs: [{ id: 'missing-result-version', kind: 'file', materialId: brief.id, version: 999 }], active: 'missing-result-version' } } });
    await page.reload();
    await expect(page.getByRole('alert')).toContainText('no v999');
    await expect(page.getByTestId('reader').filter({ visible: true })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Edit brief.md' })).toHaveCount(0);
    const current = await api<{ ok: boolean; value: { entry: { current: number } } }>(page, 'material.read', { id: brief.id });
    expect(current.value.entry.current).toBe(1);
  } finally {
    await cleanup(page, bridge, home);
  }
});

for (const action of ['switch', 'close'] as const) test(`later ${action} intent survives a versioned Save response without losing newer typing`, async ({ page }) => {
  const home = freshDataHome(`versioned-save-${action}`);
  const bridge = await startBridge(home);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let committed = false;
  try {
    const { editor, brief } = await openBrief(page, bridge.url);
    await page.getByTestId('turn').first().getByRole('button', { name: /^brief\.md\s*v1$/ }).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await editor.fill('# Snapshot saved before navigation');
    await page.route('**/api', async (route) => {
      if (route.request().postDataJSON().method !== 'material.save') return route.continue();
      const response = await route.fetch(); committed = true;
      await held; return route.fulfill({ response });
    });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => committed).toBe(true);
    const next = '# Newer typing retained when leaving this editor';
    await editor.fill(next);
    await expect.poll(async () => (await api<{ text: string }>(page, 'drafts.get', { key: `edit:${brief.id}` }))?.text).toBe(next);
    const paneTabs = page.getByRole('tablist', { name: 'Pane tabs', exact: true });
    if (action === 'switch') await paneTabs.getByRole('tab', { name: 'Files', exact: true }).click();
    else {
      await page.getByRole('button', { name: 'Close brief.md · v1', exact: true }).click();
      await page.getByRole('button', { name: 'Close brief.md', exact: true }).click();
    }
    release();
    await page.unrouteAll({ behavior: 'wait' });
    await expect(paneTabs.getByRole('tab', { name: 'Files', exact: true })).toHaveAttribute('aria-selected', 'true');
    if (action === 'close') await expect(page.getByRole('tab', { name: /brief\.md/ })).toHaveCount(0);
    await expect.poll(async () => (await api<{ text: string }>(page, 'drafts.get', { key: `edit:${brief.id}` }))?.text).toBe(next);
    await page.getByTestId('file-row').filter({ hasText: 'brief.md' }).click();
    // Closing the tab first leaves a stale draft to restore; a switch keeps the base it advanced to.
    if (action === 'close') await page.getByRole('button', { name: 'Restore my edit', exact: true }).click();
    await expect(editor).toContainText(next);
    const saved = await api<{ ok: boolean; value: { text: string; entry: { current: number } } }>(page, 'material.read', { id: brief.id });
    expect(saved.value).toMatchObject({ text: '# Snapshot saved before navigation', entry: { current: 2 } });
  } finally {
    release(); await cleanup(page, bridge, home);
  }
});
