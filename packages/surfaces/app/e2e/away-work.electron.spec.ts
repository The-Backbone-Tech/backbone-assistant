// Installed-capable journeys use the actual Host and a scripted local model. No mailbox or account.
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Proactivity, Receipt, Schedule, Thread, TurnSettings } from '@backbone-next/platform';
import { removeDataHome } from '@backbone-next/platform/composition';
import { startScriptedModel } from '@backbone-next/platform/testing';
import { api, appDir, openMoreView, repoRoot } from './journey';

const settings: TurnSettings = { permission: 'ask', model: 'away-work', effort: 3, runsOn: 'this-computer', mode: 'chat' };
function value<T>(r: Receipt<T>): T { expect(r.ok).toBe(true); if (!r.ok) throw new Error(r.detail); return r.value; }
const state = (page: Page) => api<Proactivity>(page, 'schedules.get', {});

async function fixture() {
  const root = join(repoRoot, 'evidence', 'away-work'); mkdirSync(root, { recursive: true });
  const home = mkdtempSync(join(root, 'home-')), person = mkdtempSync(join(root, 'person-'));
  let answer = 'Summary of unread mail recorded.';
  const model = await startScriptedModel('away-work', () => ({ text: answer }));
  let app: ElectronApplication | undefined, proc: ChildProcess | undefined;
  const launch = async () => {
    const installed = process.env.BACKBONE_APP_EXECUTABLE;
    app = await _electron.launch({ ...(installed ? { executablePath: installed, args: [] } : { args: [appDir] }),
      env: { ...process.env, BACKBONE_HOME: home, BACKBONE_USER_HOME: person, BACKBONE_HARNESS: 'harness-pi', BACKBONE_MODEL_ENDPOINT: model.url, BACKBONE_MODEL_ID: model.model } });
    proc = app.process();
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(!!installed);
    const page = await app.firstWindow();
    await expect(page.locator('[data-ready=true]')).toBeVisible({ timeout: 60_000 });
    return page;
  };
  const quit = async () => {
    if (!app) return;
    const current = app;
    await Promise.all([current.waitForEvent('close'), current.evaluate(({ app }) => { setImmediate(() => app.quit()); })]);
    await expect.poll(() => proc?.exitCode).toBe(0); app = undefined;
  };
  return { launch, quit, answer: (text: string) => { answer = text; },
    async close() { try { await quit(); } finally { await model.close(); await removeDataHome(home); rmSync(person, { recursive: true, force: true }); } } };
}
async function project(page: Page) {
  return value(await api<Receipt<{ id: string }>>(page, 'projects.create', { name: 'Away work', kind: 'folder' })).id;
}
async function heartbeatSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: 'Heartbeat and brief', exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: 'Heartbeat' })).toBeEnabled();
  return dialog;
}

test('a person confirms a schedule from words, edits it without losing work, runs it and stops it after restart', async () => {
  const f = await fixture();
  try {
    let page = await f.launch(); const projectId = await project(page);
    const sent = value(await api<Receipt<{ threadId: string }>>(page, 'turns.send', { projectId, text: 'Summarise my unread mail', attachments: [], settings, clientKey: 'first' }));
    await expect.poll(async () => value(await api<Receipt<Thread>>(page, 'threads.get', { id: sent.threadId })).summary.running).toBe(false);
    await page.reload(); await expect(page.locator('[data-ready=true]')).toBeVisible();
    await page.getByRole('navigation').getByRole('button', { name: /^Away work(?: \d+)?$/ }).click();
    await page.getByRole('navigation').getByText('Summarise my unread mail', { exact: true }).first().click();
    await page.getByRole('button', { name: 'Chat details' }).click();
    await page.getByRole('menuitem', { name: 'Schedule…' }).click();
    let dialog = page.getByRole('dialog', { name: 'Schedule', exact: true });
    await dialog.getByRole('textbox', { name: 'What' }).fill('Summarise my unread mail');
    await dialog.getByRole('textbox', { name: 'When' }).fill('every weekday at 8');
    await expect(dialog.getByTestId('when-preview')).toContainText('08:00');
    expect((await state(page)).schedules).toHaveLength(0); // Preview alone never schedules work.
    await dialog.getByRole('textbox', { name: 'When' }).fill('whenever');
    await expect(dialog.getByRole('button', { name: 'Save schedule' })).toBeDisabled();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await dialog.getByRole('textbox', { name: 'When' }).fill('every weekday at 8');
    await expect(dialog.getByTestId('when-preview')).toContainText('08:00');
    await dialog.getByRole('button', { name: 'Save schedule' }).click(); await expect(dialog).toBeHidden();
    const initial = (await state(page)).schedules[0];
    expect(initial.anchor).toBeTruthy(); expect(initial.rule.kind).toBe('rrule');
    await openMoreView(page, 'Scheduled');
    await page.setViewportSize({ width: 375, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    let row = page.getByTestId('schedule-row');
    await row.getByRole('button', { name: 'Edit', exact: true }).click();
    let edit = page.getByRole('dialog', { name: 'Edit schedule' });
    await edit.getByRole('textbox', { name: 'What' }).fill('Summarise unread mail and flag deadlines');
    await edit.getByRole('textbox', { name: 'When' }).fill('every weekday at 10');
    await expect(edit.getByTestId('when-preview')).toContainText('10:00');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    // A schedule event while editing must not erase typed words or silently adopt a new base version.
    value(await api<Receipt<Schedule>>(page, 'schedules.update', { id: initial.id, baseVersion: initial.version, patch: { paused: true } }));
    await expect(row).toContainText('Paused');
    await expect(edit.getByRole('textbox', { name: 'What' })).toHaveValue('Summarise unread mail and flag deadlines');
    await edit.getByRole('button', { name: 'Save changes' }).click(); await expect(edit.getByRole('alert')).toBeVisible();
    await expect(edit).toBeVisible(); expect((await state(page)).schedules[0].text).toBe(initial.text);
    await page.keyboard.press('Escape');
    await row.getByRole('button', { name: 'Edit', exact: true }).click();
    await edit.getByRole('textbox', { name: 'What' }).fill('Summarise unread mail and flag deadlines');
    await edit.getByRole('textbox', { name: 'When' }).fill('every weekday at 10');
    await expect(edit.getByTestId('when-preview')).toContainText('10:00');
    await edit.getByRole('button', { name: 'Save changes' }).click(); await expect(edit).toBeHidden();
    await expect(row).toContainText('10:00'); await expect(row).toContainText('Paused');
    await row.getByRole('button', { name: 'Run now', exact: true }).click();
    await expect(page.getByTestId('run-row').first()).toContainText('Done');
    await f.quit(); page = await f.launch(); await openMoreView(page, 'Scheduled'); row = page.getByTestId('schedule-row');
    // Locators belong to a window; a restarted app has a new page even when its data is unchanged.
    dialog = page.getByRole('dialog', { name: 'Schedule', exact: true });
    edit = page.getByRole('dialog', { name: 'Edit schedule' });
    await expect(row).toContainText('Summarise unread mail and flag deadlines'); await expect(row).toContainText('Paused');
    await row.getByRole('button', { name: 'Remove', exact: true }).click(); await expect(row).toHaveCount(0);
    expect((await state(page)).schedules).toHaveLength(0);
    await page.getByTestId('run-row').first().getByRole('button', { name: 'Open chat', exact: true }).click();
    await page.getByRole('button', { name: 'Chat details' }).click();
    await page.getByRole('menuitem', { name: 'Schedule…' }).click();
    await dialog.getByRole('textbox', { name: 'When' }).fill('in 2 hours');
    await dialog.getByRole('textbox', { name: 'What' }).fill('Read unread mail');
    await expect(dialog.getByTestId('when-preview')).toBeVisible();
    await dialog.getByRole('button', { name: 'Save schedule' }).click(); await expect(dialog).toBeHidden();
    const relative = (await state(page)).schedules[0];
    const card = page.getByTestId('thread-schedule');
    await card.getByRole('button', { name: 'Edit', exact: true }).click();
    await edit.getByRole('textbox', { name: 'What' }).fill('Read unread mail and flag deadlines');
    await edit.getByRole('button', { name: 'Save changes' }).click(); await expect(edit).toBeHidden();
    const textOnly = (await state(page)).schedules[0];
    expect(textOnly.nextAt).toBe(relative.nextAt); expect(textOnly.anchor).toBe(relative.anchor); expect(textOnly.rule).toEqual(relative.rule);
    await card.getByRole('button', { name: 'Remove', exact: true }).click(); await expect(card).toHaveCount(0);
    await page.getByRole('button', { name: 'Chat details' }).click();
    await page.getByRole('menuitem', { name: 'Schedule…' }).click();
    await dialog.getByRole('textbox', { name: 'When' }).fill('every weekday at 8');
    await expect(dialog.getByTestId('when-preview')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Save schedule' })).toBeDisabled();
    value(await api<Receipt<unknown>>(page, 'goals.set', { threadId: sent.threadId, text: 'Prepare the weekly brief', baseVersion: 0 }));
    await expect(page.getByTestId('thread-goal')).toContainText('Prepare the weekly brief');
    await expect(dialog.getByTestId('schedule-goal')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Save schedule' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await page.reload(); await expect(page.locator('[data-ready=true]')).toBeVisible();
    await page.getByRole('button', { name: 'Chat details' }).click();
    await page.getByRole('menuitem', { name: 'Schedule…' }).click();
    await dialog.getByRole('textbox', { name: 'When' }).fill('every weekday at 8');
    await expect(dialog.getByTestId('when-preview')).toBeVisible();
    await expect(dialog.getByTestId('schedule-goal')).toContainText('Prepare the weekly brief');
    value(await api<Receipt<unknown>>(page, 'goals.set', { threadId: sent.threadId, text: 'Prepare a different brief', baseVersion: 1 }));
    await dialog.getByRole('button', { name: 'Save schedule' }).click(); await expect(dialog.getByRole('alert')).toBeVisible();
    expect((await state(page)).schedules).toHaveLength(0);
    await page.keyboard.press('Escape');
  } finally { await f.close(); }
});

test('the heartbeat keeps quiet, collects a daily brief once and interrupts only for an emergency', async () => {
  const f = await fixture();
  try {
    let page = await f.launch(); await project(page);
    let dialog = await heartbeatSettings(page);
    await dialog.getByRole('checkbox', { name: 'Heartbeat' }).check();
    await dialog.getByRole('spinbutton', { name: 'Every (minutes)' }).fill('120');
    // Equal start/end is the existing all-day rule; no wall-clock wait is needed to run checks now.
    await dialog.getByRole('textbox', { name: 'From' }).fill('00:00');
    await dialog.getByRole('textbox', { name: 'Until' }).fill('00:00');
    await dialog.getByRole('textbox', { name: 'What it checks' }).fill('Check invoices and security');
    await dialog.getByRole('button', { name: 'Save heartbeat' }).click(); await expect(dialog.getByRole('status')).toContainText('2 hours');
    await dialog.getByRole('textbox', { name: 'Daily brief at' }).fill('23:59');
    await dialog.getByRole('button', { name: 'Save brief time' }).click(); await expect(dialog.getByTestId('brief-time-saved')).toContainText('23:59');
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await f.quit(); page = await f.launch(); dialog = await heartbeatSettings(page);
    await expect(dialog.getByRole('checkbox', { name: 'Heartbeat' })).toBeChecked();
    await expect(dialog.getByRole('spinbutton', { name: 'Every (minutes)' })).toHaveValue('120');
    await expect(dialog.getByRole('textbox', { name: 'What it checks' })).toHaveValue('Check invoices and security');
    await expect(dialog.getByRole('textbox', { name: 'Daily brief at' })).toHaveValue('23:59');
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await openMoreView(page, 'Scheduled');
    const beat = (await state(page)).heartbeat!;
    const run = async (answer: string, key: string, outcome: string) => {
      f.answer(answer);
      value(await api<Receipt<unknown>>(page, 'schedules.run', { id: beat.id, clientKey: key }));
      await expect.poll(async () => (await state(page)).runs[0]?.outcome).toBe(outcome);
    };
    await run('HEARTBEAT_OK', 'quiet', 'quiet');
    expect((await state(page)).brief.latest).toBeNull();
    await expect(page.getByRole('alert').filter({ hasText: 'Emergency' })).toHaveCount(0);
    await run('An invoice needs your decision.', 'invoice', 'needs-you');
    expect((await state(page)).brief.latest).toBeNull(); expect((await state(page)).interruptions.emergencies).toHaveLength(0);
    await expect(page.getByRole('alert').filter({ hasText: 'Emergency' })).toHaveCount(0);
    value(await api<Receipt<unknown>>(page, 'brief.put', { time: '00:00' }));
    await expect.poll(async () => (await state(page)).brief.latest?.items.some(i => i.title.includes('invoice')), { timeout: 60_000 }).toBe(true);
    await page.getByRole('button', { name: /^Needs you/ }).click();
    const item = page.getByTestId('brief-item').filter({ hasText: 'invoice' });
    await expect(item).toHaveCount(1); await item.click();
    await expect.poll(async () => (await state(page)).brief.latest?.items.find(i => i.title.includes('invoice'))?.done).toBe(true);
    await run('URGENT-SECURITY: A shared key needs rotation now.', 'emergency', 'emergency');
    await expect(page.getByRole('alert').filter({ hasText: 'Emergency' })).toContainText('shared key');
    const result = await state(page); expect(result.interruptions.briefs).toBe(1); expect(result.interruptions.emergencies).toHaveLength(1);
    dialog = await heartbeatSettings(page); await dialog.getByRole('checkbox', { name: 'Heartbeat' }).uncheck();
    await expect.poll(async () => (await state(page)).heartbeat).toBeNull();
  } finally { await f.close(); }
});
