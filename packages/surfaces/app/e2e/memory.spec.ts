// Memory as a person meets it, on the browser bridge: a chat says what it remembered, the Memory
// page shows it to read, change or forget, instructions are kept, a skill drafted from a chat waits
// for an OK, and Codex's memories come in as a copy with their source. A temporary folder stands in
// for the person's home, so nothing outside the test is read.
import { removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBridge, stopBridge } from './bridge';
import { api, openMoreView } from './journey';

const settings = { permission: 'full', model: 'stub', effort: 3, runsOn: 'this-computer', mode: 'chat' };

async function opened(page: Page, label: string) {
  const home = freshDataHome(label);
  const user = mkdtempSync(join(tmpdir(), 'memory-user-'));
  mkdirSync(join(user, '.codex', 'memories'), { recursive: true });
  writeFileSync(join(user, '.codex', 'memories', 'notes.md'), '- Deploys happen on Tuesdays.\n');
  process.env.BACKBONE_USER_HOME = user;
  const bridge = await startBridge(home);
  delete process.env.BACKBONE_USER_HOME;
  await page.goto(bridge.url);
  await expect(page.locator('[data-ready=true]')).toBeVisible();
  const p = await api<{ value: { id: string } }>(page, 'projects.create', { name: 'Ops', kind: 'folder' });
  return { projectId: p.value.id, end: async () => { await stopBridge(bridge.proc); await removeDataHome(home); rmSync(user, { recursive: true, force: true }); } };
}

test('a chat says what it remembered, and the Memory page shows it to change or forget', async ({ page }) => {
  const { end } = await opened(page, 'memory-chat');
  try {
    await page.reload();
    await page.getByRole('navigation').getByRole('button', { name: 'Ops', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message' }).fill('Remember that the launch moved to Friday.');
    await page.getByRole('textbox', { name: 'Message' }).press('Enter');
    const card = page.getByTestId('turn-memory');
    await expect(card).toContainText('Remembered');
    await expect(card).toContainText('The launch moved to Friday.');

    await card.getByRole('button', { name: 'Memory' }).click();
    const memory = page.getByTestId('memory');
    await expect(memory.getByTestId('memory-entry')).toHaveCount(1);
    // While it is edited its words are in a text box, so the row is named by place, not by its text.
    const row = memory.getByTestId('memory-entry').first();
    await expect(row).toContainText('The launch moved to Friday.');
    await expect(row).toContainText('From a chat');
    await row.getByRole('button', { name: 'Edit' }).click();
    await row.getByRole('textbox', { name: 'Memory text' }).fill('The launch moved to Friday 6 Nov.');
    await row.getByRole('button', { name: 'Save' }).click();
    await expect(memory.getByTestId('memory-entry').filter({ hasText: 'Friday 6 Nov.' })).toBeVisible();
    await memory.getByTestId('memory-entry').filter({ hasText: 'Friday 6 Nov.' }).getByRole('button', { name: 'Forget' }).click();
    await expect(memory.getByTestId('memory-entry')).toHaveCount(0);

    await memory.getByRole('textbox', { name: 'Your instructions' }).fill('Be brief. Answer in English.');
    await memory.getByRole('button', { name: 'Save your instructions' }).click();
    await page.reload();
    await expect(page.getByTestId('memory').getByRole('textbox', { name: 'Your instructions' })).toHaveValue('Be brief. Answer in English.');

    await memory.getByRole('textbox', { name: 'New memory' }).fill('Invoices are paid on the 5th.');
    await memory.getByRole('button', { name: 'Add' }).click();
    await expect(memory.getByTestId('memory-entry').filter({ hasText: 'Invoices are paid on the 5th.' })).toContainText('Added by you');
  } finally { await end(); }
});

test('a skill drafted from a chat waits for an OK; memories from Codex come in as a copy', async ({ page }) => {
  const { projectId, end } = await opened(page, 'memory-skill');
  try {
    const sent = await api<{ value: { threadId: string } }>(page, 'turns.send', { projectId, text: 'Prepare the weekly report', attachments: [], settings, clientKey: 'first' });
    await expect.poll(async () => (await api<{ value: { summary: { running: boolean } } }>(page, 'threads.get', { id: sent.value.threadId })).value.summary.running).toBe(false);
    await page.reload();
    await page.getByRole('navigation').getByRole('button', { name: 'Ops', exact: true }).click();
    await page.getByRole('navigation').getByText('Prepare the weekly report').first().click();
    await page.getByRole('button', { name: 'Chat details' }).click();
    await page.getByRole('menuitem', { name: 'Make a skill from this chat' }).click();

    await openMoreView(page, 'Memory');
    const memory = page.getByTestId('memory');
    const proposed = memory.getByTestId('skill').filter({ hasText: 'prepare-the-weekly-report' });
    await expect(proposed).toContainText('Waiting for your OK');
    await proposed.getByRole('button', { name: 'Accept' }).click();
    await expect(memory.getByTestId('skill').filter({ hasText: 'prepare-the-weekly-report' })).not.toContainText('Waiting for your OK');

    await memory.getByRole('button', { name: 'Import from Codex' }).click();
    await expect(memory.getByRole('status')).toContainText('1 added');
    await expect(memory.getByTestId('memory-entry').filter({ hasText: 'Deploys happen on Tuesdays.' })).toContainText('notes.md');
  } finally { await end(); }
});
