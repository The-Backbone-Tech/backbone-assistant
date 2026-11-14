// Scheduled work as a person meets it, on the browser bridge with the stub engine: a chat gets a
// schedule, runs it now, and the Scheduled page lists it with its runs; the heartbeat is set in
// Settings and shows there too. Nothing leaves the app.
import { removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { expect, test, type Page } from '@playwright/test';
import { startBridge, stopBridge } from './bridge';
import { api, openMoreView } from './journey';

const settings = { permission: 'full', model: 'stub', effort: 3, runsOn: 'this-computer', mode: 'chat' };

async function chat(page: Page, label: string) {
  const home = freshDataHome(label);
  const bridge = await startBridge(home);
  await page.goto(bridge.url);
  await expect(page.locator('[data-ready=true]')).toBeVisible();
  const p = await api<{ value: { id: string } }>(page, 'projects.create', { name: 'Ops', kind: 'folder' });
  const sent = await api<{ value: { threadId: string } }>(page, 'turns.send', { projectId: p.value.id, text: 'Summarise the inbox', attachments: [], settings, clientKey: 'first' });
  await expect.poll(async () => (await api<{ value: { summary: { running: boolean } } }>(page, 'threads.get', { id: sent.value.threadId })).value.summary.running).toBe(false);
  await page.reload();
  await expect(page.locator('[data-ready=true]')).toBeVisible();
  await page.getByRole('navigation').getByRole('button', { name: 'Ops' }).click();
  await page.getByRole('navigation').getByText('Summarise the inbox').first().click();
  await expect(page.getByTestId('turn').first()).toBeVisible();
  return { end: async () => { await stopBridge(bridge.proc); await removeDataHome(home); } };
}

test('a chat gets a schedule, runs it now, and the Scheduled page lists it with its runs', async ({ page }) => {
  const { end } = await chat(page, 'scheduled-chat');
  try {
    await page.getByRole('button', { name: 'Chat details' }).click();
    await page.getByRole('menuitem', { name: 'Schedule…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Schedule' });
    await dialog.getByRole('textbox', { name: 'When' }).fill('whenever');
    await expect(dialog.getByRole('alert')).toContainText('Say how often');
    await expect(dialog.getByRole('button', { name: 'Save schedule' })).toBeDisabled();
    await dialog.getByRole('textbox', { name: 'When' }).fill('every weekday at 9am');
    await expect(dialog.getByTestId('when-preview')).toContainText('Weekdays at 09:00');
    await dialog.getByRole('textbox', { name: 'What' }).fill('Summarise the inbox');
    await dialog.getByRole('button', { name: 'Save schedule' }).click();
    await expect(dialog).toBeHidden();

    const card = page.getByTestId('thread-schedule');
    await expect(card).toContainText('Weekdays at 09:00');
    await expect(card).toContainText(/Next/);
    await card.getByRole('button', { name: 'Run now' }).click();
    await expect(page.getByTestId('turn')).toHaveCount(2);
    await expect(page.getByTestId('work-block').last()).toHaveText(/Worked for/);
    await card.getByRole('button', { name: 'Pause' }).click();
    await expect(card).toContainText('Paused');
    await expect(card.getByRole('button', { name: 'Resume' })).toBeVisible();

    await openMoreView(page, 'Scheduled');
    const scheduled = page.getByTestId('scheduled');
    await expect(scheduled.getByTestId('schedule-row')).toContainText('Summarise the inbox');
    await expect(scheduled.getByTestId('schedule-row')).toContainText('Paused');
    await expect(scheduled.getByTestId('run-row').first()).toContainText('Done');
    await scheduled.getByTestId('run-row').first().getByRole('button', { name: /Open/ }).click();
    await expect(page.getByTestId('thread-schedule')).toBeVisible();
  } finally { await end(); }
});

test('the Scheduled page makes a schedule with its own button, and a chat\'s sidebar menu offers Schedule…', async ({ page }) => {
  const { end } = await chat(page, 'scheduled-button');
  try {
    await openMoreView(page, 'Scheduled');
    const scheduled = page.getByTestId('scheduled');
    await expect(scheduled).toContainText('Nothing is scheduled. Choose New schedule.');
    await scheduled.getByRole('button', { name: 'New schedule' }).click();
    const dialog = page.getByRole('dialog', { name: 'Schedule', exact: true });
    await dialog.getByRole('textbox', { name: 'When' }).fill('every weekday at 9am');
    await expect(dialog.getByTestId('when-preview')).toContainText('Weekdays at 09:00');
    await dialog.getByRole('textbox', { name: 'What' }).fill('Check the build');
    await dialog.getByRole('button', { name: 'Save schedule' }).click();
    await expect(dialog).toBeHidden();
    await expect(scheduled.getByTestId('schedule-row')).toContainText('Check the build');
    await expect(scheduled).not.toContainText('Nothing is scheduled');

    const nav = page.getByRole('navigation');
    await nav.getByRole('button', { name: 'Ops' }).click();
    await nav.getByRole('button', { name: /^Thread actions for / }).first().click({ force: true });
    await page.getByRole('menuitem', { name: 'Schedule…' }).click();
    await expect(page.getByRole('dialog', { name: 'Schedule', exact: true }).getByRole('textbox', { name: 'When' })).toBeVisible();
  } finally { await end(); }
});

test('the heartbeat and the brief time are set in Settings, and the heartbeat shows on Scheduled', async ({ page }) => {
  const { end } = await chat(page, 'scheduled-heartbeat');
  try {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settingsDialog = page.getByRole('dialog', { name: 'Settings' });
    await settingsDialog.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Heartbeat and brief' }).click();
    await settingsDialog.getByRole('checkbox', { name: 'Heartbeat' }).check();
    await settingsDialog.getByRole('spinbutton', { name: 'Every (minutes)' }).fill('30');
    await settingsDialog.getByRole('textbox', { name: 'From' }).fill('08:00');
    await settingsDialog.getByRole('textbox', { name: 'Until' }).fill('20:00');
    await settingsDialog.getByRole('textbox', { name: 'What it checks' }).fill('Overdue invoices and failed jobs');
    await settingsDialog.getByRole('button', { name: 'Save heartbeat' }).click();
    await expect(settingsDialog.getByRole('status')).toContainText('Every 30 minutes, 08:00–20:00');
    await settingsDialog.getByRole('textbox', { name: 'Daily brief at' }).fill('07:30');
    await settingsDialog.getByRole('button', { name: 'Save brief time' }).click();
    await expect(settingsDialog.getByTestId('brief-time-saved')).toContainText('07:30');
    await settingsDialog.getByRole('button', { name: 'Done' }).click();

    await openMoreView(page, 'Scheduled');
    const beat = page.getByTestId('heartbeat-card');
    await expect(beat).toContainText('Every 30 minutes, 08:00–20:00');
    await expect(beat).toContainText('Overdue invoices and failed jobs');
    await expect(page.getByTestId('scheduled')).toContainText('Daily brief at 07:30');
  } finally { await end(); }
});
