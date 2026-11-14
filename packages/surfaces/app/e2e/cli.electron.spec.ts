import { TEST_HANG_MS } from '../../../../scripts/lib/test-hang.ts';
// Assertion deadlines detect hangs; Playwright retains the pending locator/property and last value.
// The command line against the built app on a home kept as a real one is: no plaintext, a vault whose
// holder is the Keychain, its own embedded PostgreSQL, no BACKBONE_KEYS anywhere. What differs from a
// real home is named here: safeStorage's wrap is a fixture (fixtures/fake-keychain.cjs), so the
// person's login Keychain is not touched, and the home's path is a temporary folder. The dialog's
// click is stood in for: the answer is the test's, and every question asked is recorded.
import { startScriptedModel, type ScriptedModel } from '@backbone-next/platform/testing';
import { removeDataHome } from '@backbone-next/platform/composition';
import { apiSocket } from '@backbone-next/platform/doors/api-line';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, appDir, fixture, repoRoot } from './journey';

const bin = join(repoRoot, 'packages/surfaces/cli/src/main.ts');
let app: ElectronApplication | undefined;
let page: Page;
let model: ScriptedModel | undefined;
let home: string;

interface Ran { code: number | null; out: string; err: string }
/** The person's terminal: no key is named, and BACKBONE_KEYS is not set. */
function cliEnv() {
  const { BACKBONE_KEYS: _k, BACKBONE_HARNESS: _h, ...rest } = process.env;
  return { ...rest, BACKBONE_HOME: home };
}
function start(args: string[]) {
  const proc = spawn(process.execPath, [bin, ...args], { env: cliEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  const seen = { out: '', err: '' };
  proc.stdout.on('data', (d) => (seen.out += String(d)));
  proc.stderr.on('data', (d) => (seen.err += String(d)));
  return { seen, done: new Promise<Ran>((r) => proc.once('close', (code) => r({ code, ...seen }))) };
}
const cli = (...args: string[]) => start(args).done;

const quit = async () => {
  const leaving = app?.waitForEvent('close', { timeout: TEST_HANG_MS }).catch(() => undefined);
  await app?.evaluate(({ app }) => { app.quit(); }).catch(() => undefined);
  await leaving;
  app = undefined;
};
test.afterEach(async () => {
  await quit();
  await model?.close();
  await removeDataHome(home);
});

test('the bin reaches the running app on a Keychain-kept home, and says so plainly once it is closed', async () => {
  test.setTimeout(240_000);
  home = mkdtempSync(join(tmpdir(), 'backbone-cli-app-'));
  model = await startScriptedModel('scripted-model');
  const { BACKBONE_KEYS: _keys, ...inherited } = process.env;
  app = await electron.launch({
    args: ['-r', fixture('fake-keychain.cjs'), appDir],
    env: { ...inherited, BACKBONE_HOME: home, BACKBONE_HARNESS: 'harness-pi', BACKBONE_MODEL_ENDPOINT: model.url, BACKBONE_MODEL_ID: model.model, BACKBONE_STUB_WRITE_DELAY_MS: '1500' } as Record<string, string>,
  });
  expect(await app.evaluate(() => (globalThis as { __fakeKeychain?: boolean }).__fakeKeychain)).toBe(true);
  page = await app.firstWindow();
  await expect(page.locator('[data-ready=true]')).toBeVisible({ timeout: TEST_HANG_MS });

  // The home is what a real one is: the Keychain holds its keys, and this process cannot open it.
  const vault = JSON.parse(readFileSync(join(home, 'keys', 'vault.json'), 'utf8'));
  expect([vault.holder, vault.wrap]).toEqual(['keychain', 'electron-safeStorage']);
  await expect.poll(() => existsSync(apiSocket(home)), { timeout: TEST_HANG_MS }).toBe(true);
  expect(lstatSync(apiSocket(home)).mode & 0o777).toBe(0o600);

  await api(page, 'projects.create', { name: 'Q4 review', kind: 'folder' });
  await app.evaluate(({ dialog }) => {
    const asked: string[] = [];
    (globalThis as { asked?: string[] }).asked = asked;
    dialog.showMessageBox = (async (...args: { message: string; detail: string }[]) => { asked.push(`${args.at(-1)!.message}\n${args.at(-1)!.detail}`); return { response: 0, checkboxChecked: false }; }) as never;
  });
  const asked = () => app!.evaluate(() => (globalThis as { asked?: string[] }).asked);

  // Reads: from the running app, with no model call and no question.
  const projects = await cli('projects', 'list', '--json');
  expect(projects.code, projects.err).toBe(0);
  expect(JSON.parse(projects.out).map((p: { name: string }) => p.name)).toEqual(['Q4 review']);
  expect(JSON.parse((await cli('threads', 'list', '--json')).out)).toEqual([]);
  expect((await cli('now')).code).toBe(0);
  expect(model.requests.length).toBe(0);
  expect(await asked()).toEqual([]);

  // A send: the person is asked, and the app itself sees the turn.
  const sent = await cli('send', 'Write a brief about the quarter');
  expect(sent.code, sent.out + sent.err).toBe(0);
  expect(sent.err).toContain('Waiting for you in the app');
  expect(sent.out).toContain('brief.md');
  const question = (await asked())![0];
  expect(question).toContain(JSON.parse(projects.out)[0].id);
  for (const shown of ['Write a brief about the quarter', 'Q4 review', 'a new thread', 'scripted-model', 'effort 3', 'ask', 'chat']) expect(question).toContain(shown);
  const threads = await api<{ id: string }[]>(page, 'threads.list', {});
  expect(threads).toHaveLength(1);
  await expect(page.getByText('Write a brief about the quarter').first()).toBeVisible();

  // Reading it again starts nothing.
  const calls = model.requests.length;
  expect(calls).toBeGreaterThan(0);
  expect((await cli('threads', 'show', threads[0].id)).code).toBe(0);
  expect((await cli('threads', 'list')).code).toBe(0);
  expect((await cli('models')).code).toBe(0);
  expect((await cli('doctor')).out).toContain('the process holding it (the app or the daemon)');
  expect(model.requests.length).toBe(calls);

  // A second send is asked about too, and another command stops it through the app.
  const again = await cli('send', 'Write a third brief about pay', '--thread', threads[0].id);
  expect(again.code, again.err).toBe(0);
  expect((await asked())![1]).toContain(threads[0].id);
  const running = start(['send', 'Write a second brief about hiring']);
  await expect.poll(() => /thread ([0-9a-f-]{36})/.exec(running.seen.out)?.[1], { timeout: TEST_HANG_MS }).toBeTruthy();
  const id = /thread ([0-9a-f-]{36})/.exec(running.seen.out)![1];
  const stop = await cli('stop', id);
  const ended = await running.done;
  expect([0, 3, 4], `send exited ${ended.code}: ${ended.err}`).toContain(ended.code);
  expect([0, 4], `stop exited ${stop.code}: ${stop.err}`).toContain(stop.code);
  expect(await asked()).toHaveLength(3);
  expect((await asked())![2]).toContain(`(${JSON.parse(projects.out)[0].id})`);

  // Project creation needs no click; unrelated writes stay off the line.
  const made = await cli('projects', 'create', 'Another');
  expect(made.code, made.err).toBe(0);
  const listed = await api<{ name: string }[]>(page, 'projects.list', {});
  expect(listed).toHaveLength(2);
  expect(listed.map(p => p.name)).toContain('Another');
  const beforeArchive = await api<{ id: string; archived: boolean }[]>(page, 'threads.list', {});
  expect(beforeArchive.find(t => t.id === threads[0].id)?.archived).toBe(false);
  const archived = await cli('threads', 'archive', threads[0].id);
  expect(archived.code).toBe(1);
  expect(archived.err).toContain('REFUSED (NOT_AVAILABLE)');
  expect(await api(page, 'threads.list', {})).toEqual(beforeArchive);

  await quit();
  expect(existsSync(apiSocket(home))).toBe(false);
  const closed = await cli('threads', 'list');
  expect(closed.code).toBe(1);
  expect(closed.err).toContain('app that keeps this data folder is not running');
  expect(existsSync(join(home, 'cli'))).toBe(false);
});
