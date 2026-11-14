import { TEST_HANG_MS } from '../../../../scripts/lib/test-hang.ts';
// Assertion deadlines detect hangs; Playwright retains the pending locator/property and last value.
// Real Electron IPC, native test dialogs, Pi, Core and a local fake connector. No account or Keychain.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { ConnectorsView, Receipt, Thread } from '@backbone-next/platform';
import { startScriptedModel } from '@backbone-next/platform/testing';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { removeDataHome } from '@backbone-next/platform/composition';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { connectorWorld } from './connector-world';
import { api, appDir, repoRoot } from './journey';
interface Asked { message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number }
const value = <T>(r: Receipt<T>): T => { expect(r.ok, r.ok ? '' : r.detail).toBe(true); return (r as { ok: true; value: T }).value; };
async function queue(app: ElectronApplication, responses: number[]) {
  await app.evaluate((_, responses) => { (globalThis as unknown as { responses: number[] }).responses = responses; }, responses);
}
const asked = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { asked: Asked[] }).asked);
async function fixture() {
  const home = freshDataHome('connector-approval-electron'), world = connectorWorld(), log = join(world.root, 'calls.jsonl'), control = join(world.root, 'definitions.json');
  writeFileSync(control, JSON.stringify(['send_note', 'draft_note'].map(name => ({ name, description: 'Fake connector action.',
    inputSchema: { type: 'object', properties: { body: { type: 'string' }, send: { type: 'boolean' }, unknown: { type: 'boolean' } } }, annotations: { readOnlyHint: false } }))));
  writeFileSync(world.files.claude, JSON.stringify({ mcpServers: { notes: { command: process.execPath, args: [join(repoRoot, 'packages/platform/test/fake-mcp-kind-server.ts')],
    env: { FAKE_KIND_CONTROL: control, FAKE_KIND_LOG: log, FAKE_KIND_EXIT_ARG: 'unknown' } } } }));
  const model = await startScriptedModel('connector-approval-model', messages => {
    const start = messages.findLastIndex(m => m.role === 'user'), content = messages[start]?.content;
    const text = typeof content === 'string' ? content : (content ?? []).map(part => part.text ?? '').join('');
    if (messages.slice(start + 1).some(m => m.role === 'tool')) return { text: 'Connector receipt recorded.' };
    const tool = text.startsWith('Draft') ? 'draft_note' : 'send_note';
    return { calls: [{ name: `mcp__notes__${tool}`, args: { body: text, ...(text.includes('UNKNOWN') ? { unknown: true } : {}), ...(tool === 'send_note' ? { send: true } : {}) } }] };
  });
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: [appDir], env: { ...process.env, ...world.env, BACKBONE_HOME: home, BACKBONE_KEYS: 'plaintext', BACKBONE_SYSTEM_STORE_UNAVAILABLE: '1',
      BACKBONE_HARNESS: 'harness-pi', BACKBONE_MODEL_ENDPOINT: model.url, BACKBONE_MODEL_ID: model.model } as Record<string, string> });
    const page = await app.firstWindow(); await expect(page.locator('[data-ready=true]')).toBeVisible({ timeout: TEST_HANG_MS });
    await app.evaluate(({ dialog, systemPreferences }) => {
      const g = globalThis as unknown as { asked: Asked[]; responses: number[] };
      g.asked = []; g.responses = [];
      dialog.showMessageBox = (async (...args: unknown[]) => { const q = args.at(-1) as Asked; g.asked.push(q); return { response: g.responses.shift() ?? q.cancelId, checkboxChecked: false }; }) as typeof dialog.showMessageBox;
      systemPreferences.canPromptTouchID = () => false;
      systemPreferences.promptTouchID = async () => { throw Error('No real presence prompt in this test.'); };
    });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' }); await settings.getByRole('button', { name: 'Connected tools', exact: true }).click();
    const row = settings.getByTestId('connector-claude-code:notes'); await row.getByRole('button', { name: 'List tools', exact: true }).click();
    await queue(app, [0]); await row.getByRole('button', { name: 'Turn on notes', exact: true }).click();
    await expect(row.getByRole('button', { name: 'Turn off notes', exact: true })).toBeVisible();
    for (const tool of ['send_note', 'draft_note']) { await queue(app, [0]); await row.getByRole('button', { name: `Turn on ${tool}`, exact: true }).click(); await expect(row.getByRole('button', { name: `Turn off ${tool}`, exact: true })).toBeVisible(); }
    await queue(app, [0]); await row.getByRole('button', { name: 'Allow sending', exact: true }).click(); await expect(row.getByRole('button', { name: 'Close sending', exact: true })).toBeVisible();
    const project = value(await api<Receipt<{ id: string }>>(page, 'projects.create', { name: 'Connector approval', kind: 'folder' })); let n = 0;
    const view = () => api<ConnectorsView>(page, 'connectors.list', {});
    const send = async (text: string) => {
      const sent = value(await api<Receipt<{ threadId: string }>>(page, 'turns.send', { projectId: project.id, text, attachments: [], settings: { permission: 'full', model: model.model, effort: 2, mode: 'chat', runsOn: 'this-computer' }, clientKey: `approval-${++n}` }));
      await expect.poll(async () => value(await api<Receipt<Thread>>(page, 'threads.get', { id: sent.threadId })).summary.running, { timeout: TEST_HANG_MS }).toBe(false);
      const held = (await view()).held.find(h => h.args.body === text);
      expect(held, JSON.stringify({ calls: (await view()).held.map(h => ({ args: h.args, detail: h.detail })), turn: value(await api<Receipt<Thread>>(page, 'threads.get', { id: sent.threadId })).turns.at(-1)?.answer })).toBeDefined();
      return held!;
    };
    const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    const sign = async (tool: string) => { await queue(app!, [0]); const line = row.getByLabel(`What ${tool} does`).locator('..').locator('..'); await line.getByRole('button', { name: 'Let it act without asking' }).click(); await expect(line.getByRole('button', { name: 'Ask me every time' })).toBeVisible(); };
    return { home, world, app, page, settings, row, view, send, calls, sign, async close() { await app!.close(); await model.close(); await removeDataHome(home); world.remove(); } };
  } catch (error) { await app?.close(); await model.close(); await removeDataHome(home); world.remove(); throw error; }
}

test('a person releases one send, signs the tool, inspects UNKNOWN evidence and resumes only that tool', async () => {
  test.setTimeout(180_000); const f = await fixture();
  try {
    const first = await f.send('Send exactly these words.'); expect(first.state).toBe('waiting'); expect(f.calls()).toEqual([]);
    const card = f.settings.getByTestId(`connector-call-${first.effect}`);
    await queue(f.app, []); await card.getByRole('button', { name: 'Permit', exact: true }).click(); await expect(card.getByRole('button', { name: 'Permit', exact: true })).toBeEnabled(); expect(f.calls()).toEqual([]);
    await queue(f.app, [0]); await card.getByRole('button', { name: 'Permit', exact: true }).click();
    await expect.poll(() => f.calls().length).toBe(1); expect(f.calls()[0]).toEqual({ name: 'send_note', arguments: first.args });
    const release = (await asked(f.app)).filter(q => q.buttons[0] === 'Send').at(-1)!;
    expect(release.detail).toContain(JSON.stringify(first.statement)); expect(release.detail).toContain(JSON.stringify(first.args));
    await f.sign('send_note'); await f.sign('draft_note');
    const sign = (await asked(f.app)).filter(q => q.buttons[0] === 'Act without asking').at(-1)!;
    expect(sign.detail).toContain('Argument names supplied by server: "body", "send", "[hidden]"');
    expect(sign.detail).toContain('send, publish, post, share, deliver, notify or broadcast'); expect(sign.detail).not.toContain('arguments asking to send or publish are still stopped');
    const before = (await asked(f.app)).length;
    const signed = await f.send('Send the next exact message.'); expect(signed.state).toBe('sent'); expect(signed.standingSignatureId).toBeTruthy(); expect(signed.dispatchReceipt).toBeTruthy(); expect((await asked(f.app)).length).toBe(before);
    const lost = await f.send('Send UNKNOWN message.'); expect(lost.state).toBe('unknown');
    await f.settings.getByRole('button', { name: 'Tool permissions', exact: true }).click();
    const signedRow = f.settings.getByRole('article', { name: 'send_note on notes' });
    await expect(signedRow).toContainText('Paused');
    await expect(signedRow.getByTestId('permission-call-count')).toHaveText('2');
    await expect(f.settings.getByRole('article', { name: 'draft_note on notes' })).toContainText('Acts without asking');
    await f.settings.getByRole('button', { name: 'Connected tools', exact: true }).click();
    const deferred = await f.send('Send later different words.'); expect(deferred.state).toBe('waiting'); expect(f.calls()).toHaveLength(3);
    const waiting = f.settings.getByTestId(`connector-call-${deferred.effect}`); await expect(waiting.getByText('Waiting', { exact: true })).toBeVisible(); await expect(waiting.getByText('Unknown outcome', { exact: true })).toHaveCount(0);
    const other = await f.send('Draft something while send is paused.'); expect(other.state).toBe('sent'); expect(f.calls()).toHaveLength(4);
    const unknown = f.settings.getByTestId(`connector-call-${lost.effect}`);
    await expect(unknown).toContainText(JSON.stringify(lost.statement)); await expect(unknown).toContainText(lost.standingSignatureId!); await expect(unknown).toContainText(`Dispatch receipt: ${lost.dispatchReceipt!.seq}`);
    await expect(unknown.locator('time')).toHaveAttribute('datetime', lost.dispatchedAt!); await expect(f.row).toContainText('send_note is paused');
    await queue(f.app, [1]); await unknown.getByRole('button', { name: 'Resolve outcome' }).click();
    await expect.poll(async () => (await f.view()).held.find(h => h.effect === lost.effect)?.resolution?.answer).toBe('did_not_happen');
    await expect(f.row).not.toContainText('send_note is paused'); expect((await f.send('Send after my inspection.')).state).toBe('sent'); expect(f.calls()).toHaveLength(5);
    expect(f.calls().filter(c => c.arguments.unknown)).toHaveLength(1);
    const inspected = (await f.view()).held.find(h => h.effect === lost.effect)!; expect(inspected.resolution?.ledger).toBeTruthy();
    const foreign = await f.app.evaluate(async ({ BrowserWindow }, preload) => {
      const other = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true } });
      try { await other.loadURL('data:text/html,other'); return await other.webContents.executeJavaScript("Promise.all([window.backbone.resolveConnectorEffect('bad','bad'),window.backbone.releaseConnectorCall('bad','bad'),window.backbone.signConnectorTool('x','x')].map(p=>p.then(()=> 'allowed', e=>e.message)))"); }
      finally { other.destroy(); }
    }, join(appDir, 'dist/electron/preload.cjs'));
    expect(foreign).toHaveLength(3); for (const answer of foreign) expect(answer).toContain('only this app\'s own page');
  } finally { await f.close(); }
});

test('keep closed and cancel preserve the pause; CLI resolution takes the same native person path', async () => {
  test.setTimeout(180_000); const f = await fixture();
  try {
    await f.sign('send_note'); const lost = await f.send('Send UNKNOWN second message.');
    const card = f.settings.getByTestId(`connector-call-${lost.effect}`);
    for (const response of [3, 2]) {
      await queue(f.app, [response]); await card.getByRole('button', { name: 'Resolve outcome' }).click();
      await expect(card.getByRole('button', { name: 'Resolve outcome' })).toBeEnabled();
      expect((await f.view()).held.find(h => h.effect === lost.effect)!.state).toBe('unknown');
    }
    expect((await f.send('Send held after keep closed.')).state).toBe('waiting');
    await queue(f.app, [0]); await card.getByRole('button', { name: 'Resolve outcome' }).click();
    await expect.poll(async () => (await f.view()).held.find(h => h.effect === lost.effect)?.resolution?.answer).toBe('happened');
    const cliLost = await f.send('Send UNKNOWN CLI message.'); expect(cliLost.state).toBe('unknown');
    await queue(f.app, [0]);
    const child = spawn(process.execPath, [join(repoRoot, 'packages/surfaces/cli/src/main.ts'), 'connectors', 'resolve', cliLost.effect, '--args-hash', cliLost.argsHash, '--answer', 'happened', '--home', f.home, '--json'], { env: { ...process.env, ...f.world.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { err += b; });
    const code = await new Promise(resolve => child.once('exit', resolve)); expect(code, out + err).toBe(0);
    expect((await f.view()).held.find(h => h.effect === cliLost.effect)!.resolution?.answer).toBe('happened');
    expect((await asked(f.app)).at(-1)!.message).toContain('Record your inspection');
    expect((await f.send('Send after the CLI inspection.')).state).toBe('sent');
    expect(f.calls().filter(c => c.arguments.unknown)).toHaveLength(2);
    expect(f.calls().filter(c => c.arguments.body === lost.args.body)).toHaveLength(1);
    expect(f.calls().filter(c => c.arguments.body === cliLost.args.body)).toHaveLength(1);
    expect(await f.page.evaluate(() => window.backbone!.resolveConnectorEffect!('bad', 'bad'))).toMatchObject({ ok: false, outcome: 'REFUSED' });
  } finally { await f.close(); }
});
