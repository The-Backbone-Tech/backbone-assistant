import { hangDetector } from '../../../../scripts/lib/test-hang.ts';
// Settings › Assistants using this app, on the built Electron app: open Settings, connect a fake Claude Code, approve
// the grant in the main process's own window with one click, see "Connected", use the door the app
// ships (the command inside the app that every entry starts), see its receipt counted, disconnect. The renderer cannot grant:
// connecting is not an api method, and only main's confirmation connects. Native dialogs are
// answered from the test, in main. The tool's home, settings and command are a throwaway world
// (HOME, CLAUDE_CONFIG_DIR, CODEX_HOME and fake `claude` and `codex` on PATH): never this machine's.
import { removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { mcp, SEEDS, toolWorld, type ToolWorld } from '@backbone-next/platform/testing/tools';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { appDir, repoRoot } from './journey';

const evidence = join(repoRoot, 'evidence', 'tools');
let app: ElectronApplication | undefined;
let world: ToolWorld | undefined;
let home = '';

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  if (home) await removeDataHome(home);
  world?.remove();
});

interface Asked {
  message: string;
  detail?: string;
  buttons: string[];
}
/** Answer main's native dialogs from a queue (the last button, Cancel or Back, once it is empty), recording each. */
async function answerDialogs(electronApp: ElectronApplication, answers: { response: number; checkboxChecked?: boolean }[]) {
  await electronApp.evaluate(({ dialog }, queue) => {
    const g = globalThis as unknown as { asked: Asked[]; answers: typeof queue };
    g.asked = [];
    g.answers = queue;
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const o = (args.length > 1 ? args[1] : args[0]) as Asked;
      g.asked.push({ message: o.message, detail: o.detail, buttons: o.buttons });
      return g.answers.shift() ?? { response: o.buttons.length - 1, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  }, answers);
}
const asked = (electronApp: ElectronApplication) => electronApp.evaluate(() => (globalThis as unknown as { asked: Asked[] }).asked);

async function openSection(page: Page) {
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Assistants using this app' }).click();
  return settings;
}

test('connect a tool from Settings with one click in main’s confirmation, use it, and disconnect it', async () => {
  world = toolWorld();
  // A prepared home: its database is in the run's shared cluster, so neither the app nor the door starts one.
  home = freshDataHome('tools-electron');
  mkdirSync(evidence, { recursive: true });
  app = await electron.launch({ args: [appDir], env: { ...process.env, ...world.env, BACKBONE_HOME: home } as Record<string, string> });
  const page = await app.firstWindow();
  await expect(page.locator('[data-ready=true]')).toBeVisible();

  // One app per data home: a second launch on the same home stops by itself, and the first goes on.
  const second = spawn(createRequire(import.meta.url)('electron') as string, [appDir], { env: { ...process.env, ...world.env, BACKBONE_HOME: home }, stdio: 'ignore' });
  let code: number | null;
  try { [code] = await hangDetector(once(second, 'exit') as Promise<[number | null]>, 'second Electron app exits after singleton refusal', { diagnostic: () => JSON.stringify({ pid: second.pid, exitCode: second.exitCode, signal: second.signalCode }) }); }
  finally { if (second.exitCode === null && second.signalCode === null) second.kill(); }
  expect(code).toBe(0);
  await expect(page.locator('[data-ready=true]')).toBeVisible();

  // The renderer cannot grant: connecting is not a method of the transport it reaches.
  const direct = await page.evaluate(() =>
    (window as unknown as { backbone: { call(m: string, a: unknown): Promise<unknown> } }).backbone.call('tools.connect', { tool: 'claude-code' }).then(
      () => 'granted',
      (e: Error) => e.message,
    ),
  );
  expect(direct).toMatch(/Unknown api method/);
  expect(world.log().some((l) => l.argv[1] === 'add')).toBe(false);

  let settings = await openSection(page);
  const row = settings.getByTestId('tool-claude-code');
  await expect(row).toContainText('Not connected');

  // Cancel in main's window: nothing happens.
  await answerDialogs(app, []);
  await row.getByRole('button', { name: 'Connect' }).click();
  await expect.poll(async () => (await asked(app!)).length).toBe(1);
  await expect(row).toContainText('Not connected');
  expect(world.log().some((l) => l.argv[1] === 'add')).toBe(false);

  // One click on Connect in main's window, which shows the grant in plain words with the door's own defaults.
  await answerDialogs(app, [{ response: 0 }]);
  await row.getByRole('button', { name: 'Connect' }).click();
  await expect(row).toContainText('Connected');
  const [card] = await asked(app);
  expect(card.message).toBe('Connect Claude Code to Assistant?');
  expect(card.detail).toMatch(/^Claude Code may: write files to Assistant’s outbox · up to medium risk · until \d{1,2} [A-Z][a-z]{2} \d{4}\n/);
  expect(card.buttons).toEqual(['Connect', 'Change…', 'Cancel']);
  await expect(row).toContainText('0 receipts');
  await page.screenshot({ path: join(evidence, '02-connected.png') });

  // Change… narrows: a lower ceiling, a shorter span, and Codex asking before each call.
  await answerDialogs(app, [{ response: 1 }, { response: 1, checkboxChecked: true }, { response: 1 }, { response: 0 }]);
  const codexRow = settings.getByTestId('tool-codex');
  await codexRow.getByRole('button', { name: 'Connect' }).click();
  await expect(codexRow).toContainText('up to low risk');
  const steps = await asked(app);
  expect(steps.map((s) => s.message)).toEqual(['Connect Codex to Assistant?', 'Without asking you, up to', 'For how long?', 'Connect Codex to Assistant?']);
  expect(steps[1].buttons).toEqual(['read-only', 'low risk', 'medium risk', 'Back']);
  expect(steps[3].detail).toMatch(/^Codex may: write files to Assistant’s outbox · up to low risk · until .* · asks you before each call\n/);
  expect(readFileSync(world.files.codex, 'utf8')).toMatch(/default_tools_approval_mode = "prompt"/);

  // Claude Code's own command added the entry, under our own name: the door inside the app, the grant,
  // the data home and nothing else.
  const door = join(appDir, 'dist', 'bin', 'backbone-mcp');
  const entry = JSON.parse(readFileSync(world.files.claude, 'utf8')).mcpServers['backbone-door'];
  expect(entry).toEqual({ type: 'stdio', command: door, args: ['serve', '--grant', 'claude-code-1'], env: { BACKBONE_HOME: home } });
  expect(existsSync(join(world.claudeConfig, 'skills/backbone/SKILL.md'))).toBe(true);

  // The tool's side: the entry starts the door this app ships, which acts and keeps a receipt.
  const [reply] = await mcp(door, entry.args, entry.env, [
    { method: 'tools/call', params: { name: 'propose_effect', arguments: { operation: 'outbox.write', args: { name: 'hello.txt', content: 'hello' }, description: 'a note', idempotencyKey: 'e2e-hello-1' } } },
  ]);
  expect((reply as { result: { structuredContent: { value: { outcome: string } } } }).result.structuredContent.value.outcome).toBe('DONE');
  expect(readFileSync(join(home, 'outbox', 'hello.txt'), 'utf8')).toBe('hello');
  await settings.getByRole('button', { name: 'Done' }).click();
  settings = await openSection(page);
  await expect(settings.getByTestId('tool-claude-code')).toContainText('1 receipt');

  for (const id of ['claude-code', 'codex']) {
    await settings.getByTestId(`tool-${id}`).getByRole('button', { name: 'Disconnect' }).click();
    await expect(settings.getByTestId(`tool-${id}`)).toContainText('Disconnected:');
  }
  await page.screenshot({ path: join(evidence, '03-disconnected.png') });
  expect(readFileSync(world.files.claude, 'utf8')).toBe(SEEDS.claude);
  expect(readFileSync(world.files.codex, 'utf8')).toBe(SEEDS.codex);
  expect(existsSync(join(world.claudeConfig, 'skills/backbone'))).toBe(false);

  // Revoked: the door refuses whatever a stale entry still starts.
  const [after] = await mcp(door, entry.args, entry.env, [
    { method: 'tools/call', params: { name: 'propose_effect', arguments: { operation: 'outbox.write', args: { name: 'late.txt', content: 'late' }, description: 'a note', idempotencyKey: 'e2e-late-1' } } },
  ]);
  expect((after as { result: { structuredContent: { reason: string } } }).result.structuredContent.reason).toBe('NO_MANDATE');
});
