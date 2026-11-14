import { TEST_HANG_MS } from '../../../../scripts/lib/test-hang.ts';
// Assertion deadlines detect hangs; Playwright retains the pending locator/property and last value.
// 10 November 2026: show real Core signature identities and label drained local end queues truthfully; stored desktop ending no longer requires discovery.
// The real desktop, IPC, Host, Core and fake MCP server. Test dialogs stand in for
// presence, as in triage/tools Electron journeys; keys are plaintext in a disposable home.
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataHomeAdminUrl } from '../../../core/src/db/testing.ts';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { removeDataHome } from '@backbone-next/platform/composition';
import { seedSignedHome } from '../test/fixtures/signed-home';
import { api, appDir, openSidebar } from './journey';

const require = createRequire(import.meta.url);
const executablePath = require('electron') as string;
interface SqlClient {
  connect(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}
const { Client } = require('pg') as { Client: new (options: { connectionString: string }) => SqlClient };
async function fixture() {
  const home = freshDataHome('signed-tools-electron');
  const person = mkdtempSync(join(tmpdir(), 'signed-tools-desktop-person-'));
  await seedSignedHome(home);
  let app: ElectronApplication | undefined;
  try {
    app = await _electron.launch({ executablePath, args: [appDir], env: { ...process.env,
      BACKBONE_HOME: home, BACKBONE_USER_HOME: person, HOME: person, BACKBONE_KEYS: 'plaintext',
      BACKBONE_SYSTEM_STORE_UNAVAILABLE: '1', BACKBONE_MODEL_ENDPOINT: '' } });
    const page = await app.firstWindow();
    await expect(page.locator('[data-ready=true]')).toBeVisible({ timeout: TEST_HANG_MS });
    await app.evaluate(({ dialog, systemPreferences }) => {
      const g = globalThis as unknown as { asked: { message: string; detail: string; buttons: string[] }[]; approve: boolean; touched: number };
      g.asked = []; g.approve = false; g.touched = 0;
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args.at(-1) as { message: string; detail: string; buttons: string[] };
        g.asked.push({ message: options.message, detail: options.detail, buttons: options.buttons });
        return { response: g.approve ? 0 : options.buttons.length - 1, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
      systemPreferences.canPromptTouchID = () => true;
      systemPreferences.promptTouchID = async () => { g.touched++; throw new Error('Unexpected test presence request'); };
    });
    return { home, person, app, page, async close() {
      await app!.close(); await removeDataHome(home); rmSync(person, { recursive: true, force: true });
    } };
  } catch (error) {
    await app?.close(); await removeDataHome(home); rmSync(person, { recursive: true, force: true }); throw error;
  }
}
async function signedSettings(page: Page) {
  await openSidebar(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Tool permissions', exact: true }).click();
  return settings;
}
async function revisit(page: Page) {
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'General', exact: true }).click();
  await settings.getByRole('button', { name: 'Tool permissions', exact: true }).click();
}

test('desktop lists, pauses and ends a product signature; Custom still asks the native signing question', async () => {
  const p = await fixture();
  const admin = new Client({ connectionString: dataHomeAdminUrl(p.home) }); await admin.connect();
  try {
    const settings = await signedSettings(p.page);
    let row = settings.getByRole('article', { name: 'draft_note on notes' });
    await expect(row).toContainText('Acts without asking');
    // 10 November 2026: the service now exposes immutable Core identity.
    await expect(row).toContainText('Permission ID:');
    await expect(row).not.toContainText('Permission ID: Not available yet.');
    // Actual catalogue mismatch, then restoration, on this disposable Core only.
    await admin.query('REVOKE EXECUTE ON FUNCTION gov.give_connector_signature(uuid,text,text) FROM backbone_app');
    await revisit(p.page);
    await expect(row).toContainText('Paused');
    expect(await api(p.page, 'core.signatureStatus', {})).toMatchObject({ state: 'paused' });
    await admin.query('GRANT EXECUTE ON FUNCTION gov.give_connector_signature(uuid,text,text) TO backbone_app');
    await revisit(p.page);
    await expect(row).toContainText('Acts without asking');

    // The new channel rejects nonstrings and cannot accept a grant-shaped payload.
    expect(await p.page.evaluate(() => window.backbone!.endConnectorSignature!({ standing: true } as unknown as string, 'draft_note'))).toMatchObject({ ok: false, outcome: 'REFUSED' });
    for (const part of ['server', 'tool']) {
      expect(await p.page.evaluate(part => window.backbone!.endConnectorSignature!(
        part === 'server' ? 'x'.repeat(1025) : 'home:notes',
        part === 'tool' ? 'x'.repeat(1025) : 'draft_note'), part)).toMatchObject({ ok: false, reason: 'INVALID', outcome: 'REFUSED' });
    }
    // A different real renderer with our preload is rejected by main's sender boundary.
    const refused = await p.app.evaluate(async ({ BrowserWindow }, preload) => {
      const other = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true } });
      try {
        await other.loadURL('data:text/html,<body>Other page</body>');
        return await other.webContents.executeJavaScript("window.backbone.endConnectorSignature('home:notes','draft_note').then(() => 'allowed', error => error.message)");
      } finally { other.destroy(); }
    }, join(appDir, 'dist/electron/preload.cjs'));
    expect(refused).toContain("only this app's own page");
    await expect(row).toContainText('Acts without asking');

    await row.getByRole('button', { name: 'End permission' }).click();
    await expect(row).toContainText('Ended locally. No pending Core end remains in the local record.');
    expect(JSON.parse(readFileSync(join(p.home, 'connectors/mcp.json'), 'utf8')).servers['home:notes'].tools.draft_note.standing).toBeUndefined();
    expect(await p.app.evaluate(() => (globalThis as unknown as { asked: unknown[] }).asked.length)).toBe(0);
    await settings.getByRole('combobox', { name: 'How much runs without asking' }).selectOption('custom');
    const choice = settings.getByRole('combobox', { name: 'Permission for draft_note on notes' });
    await choice.selectOption('acts');
    await expect(settings.getByRole('status').filter({ hasText: 'Not signed: you cancelled.' })).toBeVisible();
    await expect(choice).toHaveValue('asks');
    await p.app.evaluate(() => { (globalThis as unknown as { approve: boolean }).approve = true; });
    await choice.selectOption('acts');
    await expect(choice).toHaveValue('acts');
    row = settings.getByRole('article').filter({ has: p.page.getByRole('button', { name: 'End permission', exact: true }) });
    await expect(row).toContainText('Acts without asking');
    const presence = await p.app.evaluate(() => {
      const { asked, touched } = globalThis as unknown as { asked: { message: string; detail: string; buttons: string[] }[]; touched: number };
      return { asked, touched };
    });
    expect(presence.asked).toHaveLength(2);
    expect(presence.asked.every(q => q.message === 'Allow this tool to act without asking?')).toBe(true);
    for (const question of presence.asked) {
      expect(question.detail).toContain('Server: notes');
      expect(question.detail).toContain('Tool: draft_note');
      expect(question.detail).toContain('Description supplied by server:');
    }
    expect(presence.asked[1].buttons).toEqual(['Act without asking', 'Cancel']);
    expect(presence.touched).toBe(0);
  } finally {
    await admin.query('GRANT EXECUTE ON FUNCTION gov.give_connector_signature(uuid,text,text) TO backbone_app');
    await admin.end(); await p.close();
  }
});

test('desktop preserves the exact Core end failure without an IPC prefix and End again retries the real end', async () => {
  const p = await fixture();
  const blocker = new Client({ connectionString: dataHomeAdminUrl(p.home) });
  const observer = new Client({ connectionString: dataHomeAdminUrl(p.home) });
  await blocker.connect(); await observer.connect();
  try {
    const settings = await signedSettings(p.page);
    const row = settings.getByRole('article', { name: 'draft_note on notes' });
    await blocker.query('BEGIN'); await blocker.query('SELECT * FROM app.ledger_heads FOR UPDATE');
    await row.getByRole('button', { name: 'End permission' }).click();
    let pid = 0;
    await expect.poll(async () => {
      const result = await observer.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND query LIKE 'SELECT gov.end_connector_signature%' AND wait_event_type='Lock'");
      pid = Number(result.rows[0]?.pid ?? 0); return pid > 0;
    }).toBe(true);
    await observer.query('SELECT pg_cancel_backend($1)', [pid]);
    const diagnostic = 'The signature end could not be confirmed. Local authority stays closed and its receipt will be retried. Run backbone doctor.';
    await expect(settings.getByRole('alert')).toHaveText(`${diagnostic} Reload tool permissions`);
    await expect(settings).not.toContainText('Error invoking remote method');
    await expect(row).toContainText('End not confirmed');
    await expect(row).not.toContainText('Ended locally.');
    await expect(row.getByRole('button', { name: 'End again' })).toBeEnabled();
    await blocker.query('ROLLBACK');
    await row.getByRole('button', { name: 'End again' }).click();
    await expect(row).toContainText('Ended locally. No pending Core end remains in the local record.');
    const record = JSON.parse(readFileSync(join(p.home, 'connectors/mcp.json'), 'utf8'));
    expect(record.pendingEnds).toBeUndefined();
    expect((await observer.query("SELECT count(*)::int AS n FROM app.ledger WHERE entry_type='signature.ended'")).rows[0].n).toBe(1);
  } finally { await blocker.query('ROLLBACK'); await blocker.end(); await observer.end(); await p.close(); }
});

test('desktop stored ending works after its server disappears from discovery', async () => {
  const p = await fixture();
  const config = join(p.home, 'connectors/servers.json'), original = readFileSync(config, 'utf8');
  try {
    const settings = await signedSettings(p.page);
    const row = settings.getByRole('article', { name: 'draft_note on notes' });
    // The permission is shown first; only then does its server disappear from discovery.
    await expect(row).toContainText('Acts without asking');
    writeFileSync(config, JSON.stringify({ mcpServers: {} }));
    await row.getByRole('button', { name: 'End permission' }).click();
    // 10 November 2026: the ownership-only end acts on stored authority, without discovery.
    await expect(settings.getByRole('alert')).toHaveCount(0);
    await expect(settings).toContainText('No active permissions.');
    expect(JSON.parse(readFileSync(join(p.home, 'connectors/mcp.json'), 'utf8')).servers['home:notes'].tools.draft_note.standing).toBeUndefined();
  } finally { writeFileSync(config, original); await p.close(); }
});
