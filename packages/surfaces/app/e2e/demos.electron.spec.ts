import { TEST_HANG_MS } from '../../../../scripts/lib/test-hang.ts';
// Assertion deadlines detect hangs; Playwright retains the pending locator/property and last value.
// Scorecard demos on the built Electron app, or on the installed one when BACKBONE_APP_EXECUTABLE names
// it (scripts/e2e-installed.mjs): screenshots for rows 12, 14, 6 and 1, through what a person sees.
// - Row 12: a turn's document, its version diff and an answer's link open in the side pane.
// - Row 6: what an engine proposed is judged by a model turn: one line kept by itself with an undo,
//   one that may contradict the person's words waiting for them, with the model's reason.
// - Row 14: Settings › Backup exports into a folder picked in main's picker (stood in for, as native
//   dialogs are in every Electron journey), then `backbone restore` brings it into a new home (CLI only).
// - Row 1: a native Codex turn that delegates to a sub-agent, on the harness's own fake client.
// The model is the scripted one on the loopback (memory judgement included): no network, no key, and
// no claim about a real model's judgement. Terminal output is rendered as text pages beside the app's
// screenshots and named as such.
import { removeDataHome } from '@backbone-next/platform/composition';
import { scriptedStep, startScriptedModel, type Message, type ScriptedModel, type Step } from '@backbone-next/platform/testing';
import { _electron as electron, chromium, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync, execSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, appDir, fixture, openMoreView, phase1Home, phase2ProjectAndAttach, phase3Brief, repoRoot } from './journey';

test.describe.configure({ mode: 'serial' });

const installed = process.env.BACKBONE_APP_EXECUTABLE;
const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
const evidence = join(repoRoot, 'evidence', installed ? `installed-demos-${day}` : 'demos-unpacked');
const cli = join(repoRoot, 'packages', 'surfaces', 'cli', 'src', 'main.ts');
const homes: string[] = [];
const scratch: string[] = [];
let app: ElectronApplication | undefined;
let model: ScriptedModel | undefined;

const text = (m: Message) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((c) => c.text ?? '').join(''));
/**
 * The scripted model, plus two things a real engine does on its own: it links the document it wrote,
 * and "Propose <words>" calls propose_memory once. Consolidation is the scripted judge's word rules.
 */
function script(messages: Message[]): Step {
  const start = messages.findLastIndex((m) => m.role === 'user');
  const asked = text(messages[start]);
  // The judge's request goes to scriptedStep, which answers it by the scripted word rules.
  const proposing = asked.includes('Consolidate this memory.') ? undefined : /^Propose (.+)$/m.exec(asked)?.[1];
  if (proposing) {
    const said = messages.slice(start + 1).filter((m) => m.role === 'tool').map(text);
    if (!said.length) return { calls: [{ name: 'propose_memory', args: { text: proposing } }] };
    return { text: said[0] };
  }
  const step = scriptedStep(messages);
  if ('text' in step && /^I drafted brief\.md v\d+/.test(step.text)) return { text: `${step.text}\n\nOpen [the brief](brief.md) to read it.` };
  return step;
}

async function launch(label: string, env: Record<string, string>): Promise<Page> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), `backbone-demo-${label}-`)));
  homes.push(home);
  const runtime = { env: { ...process.env, BACKBONE_HOME: home, ...env } as Record<string, string> };
  app = await electron.launch(installed ? { ...runtime, executablePath: installed, args: [] } : { ...runtime, args: [appDir] });
  expect(await app.evaluate(({ app: a }) => a.isPackaged)).toBe(!!installed);
  const page = await app.firstWindow();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await expect(page.locator('[data-ready=true]')).toBeVisible({ timeout: TEST_HANG_MS });
  return page;
}

/** A person's quit, then wait until no process holds the home. */
async function quit() {
  const home = homes.at(-1)!;
  await app?.evaluate(({ app: a }) => { a.quit(); }).catch(() => undefined);
  app = undefined;
  await expect.poll(() => execSync(`ps -eo command | grep -F "${home}" | grep -v grep || true`).toString(), { timeout: TEST_HANG_MS }).toBe('');
}

async function idle(page: Page) {
  await expect.poll(async () => {
    const threads = await api<{ id: string }[]>(page, 'threads.list', {});
    const running = await Promise.all(threads.map(async (t) => (await api<{ value: { summary: { running: boolean } } }>(page, 'threads.get', { id: t.id })).value.summary.running));
    return running.some(Boolean);
  }, { timeout: TEST_HANG_MS }).toBe(false);
}

/** A terminal's output as a page of text, saved beside the app's screenshots and titled as what it is. */
async function transcript(name: string, title: string, body: string) {
  writeFileSync(join(evidence, `${name}.txt`), body);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 400 } });
    const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
    await page.setContent(`<body style="margin:0;background:#111;color:#e6e6e6;font:13px/1.45 Menlo,monospace"><div style="padding:10px 16px;background:#2a2a2a;color:#bbb;font:12px -apple-system,sans-serif">${esc(title)}</div><pre style="margin:0;padding:16px;white-space:pre-wrap">${esc(body)}</pre></body>`);
    await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: true });
  } finally {
    await browser.close();
  }
}

/** Shown paths say where they sit inside the temporary folder, not where that folder is. */
const tidy = (s: string) => s.replaceAll(realpathSync(tmpdir()), '$TMPDIR').replaceAll(tmpdir(), '$TMPDIR');

function listing(dir: string, root = dir, depth = 0): string[] {
  return readdirSync(dir).sort().flatMap((name) => {
    const path = join(dir, name);
    const s = statSync(path);
    const line = `${'  '.repeat(depth)}${name}${s.isDirectory() ? '/' : `  (${s.size} bytes)`}`;
    return s.isDirectory() ? [line, ...listing(path, root, depth + 1)] : [line];
  });
}

test.beforeAll(() => { mkdirSync(evidence, { recursive: true }); });
test.afterAll(async () => {
  if (app) await quit().catch(() => undefined);
  await model?.close();
  for (const home of homes) await removeDataHome(home).catch(() => undefined);
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

let exported = '';

test('row 12, 6 and 14: side pane, memory kept and waiting, Backup export', async () => {
  test.setTimeout(300_000);
  model = await startScriptedModel('scripted-model', script);
  const page = await launch('pi', { BACKBONE_MODEL_ENDPOINT: model.url, BACKBONE_MODEL_ID: model.model });
  const shot = (name: string) => page.screenshot({ path: join(evidence, `${name}.png`) });

  // Row 12. A turn writes brief.md v1 from the attachments; a second writes v2 and links it.
  await phase1Home(page);
  await phase2ProjectAndAttach(page);
  await phase3Brief(page);
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await message.fill('Write the brief again, without the attachments');
  await message.press('Enter');
  await expect(page.getByTestId('work-block')).toHaveCount(2);
  await expect(page.getByTestId('work-block').nth(1)).toHaveText(/Worked for \d+/, { timeout: TEST_HANG_MS });
  if (await page.getByTestId('pane').isVisible()) await page.getByRole('button', { name: 'Close pane' }).click();
  await expect(page.getByTestId('pane')).toBeHidden();
  const transcriptList = page.getByRole('list', { name: 'Transcript' });
  const answer = page.getByTestId('answer').last();
  await expect(answer).toContainText('I drafted brief.md v2');
  await shot('row12-01-answer-before-pane');

  // The document the turn wrote, beside the conversation.
  const pane = page.getByTestId('pane');
  const link = answer.getByRole('button', { name: 'the brief', exact: true });
  await expect(link).toHaveAttribute('data-workspace-link', 'brief.md');
  await page.keyboard.press('ControlOrMeta+p');
  await expect(page.getByTestId('files-tab')).toBeVisible();
  await page.getByTestId('file-row').filter({ hasText: 'brief.md' }).click();
  await expect(page.getByTestId('file-tab').filter({ visible: true })).toContainText('Request: Write the brief again');
  await expect(transcriptList).toBeVisible();
  await shot('row12-02-document-in-side-pane');

  // Its version diff, opened from the answer.
  await answer.getByRole('button', { name: 'Changes in brief.md v2' }).click();
  await expect(pane.getByRole('tab', { name: 'brief.md · v2 changes' })).toHaveAttribute('aria-selected', 'true');
  const diff = pane.getByTestId('version-changes');
  await expect(diff).toContainText('against v1');
  await expect(transcriptList).toBeVisible();
  const conversation = (await transcriptList.boundingBox())!;
  const beside = (await pane.boundingBox())!;
  expect(beside.x).toBeGreaterThanOrEqual(conversation.x + conversation.width);
  await shot('row12-03-version-diff-in-side-pane');

  // The answer's link to the file opens it there, at the version the turn wrote.
  await link.click();
  await expect(pane.getByRole('tab', { name: 'brief.md · v2', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(pane.getByRole('tabpanel', { name: 'brief.md · v2', exact: true })).toContainText('Request: Write the brief again');
  await shot('row12-04-answer-link-opened');
  if (await pane.isVisible()) await page.getByRole('button', { name: 'Close pane' }).click();

  // Row 6. The person's own line, then two proposals from engine turns, each judged after its turn.
  await openMoreView(page, 'Memory');
  const memory = page.getByTestId('memory');
  await memory.getByRole('textbox', { name: 'New memory' }).fill('The release build tag is chosen by the person.');
  await memory.getByRole('button', { name: 'Add' }).click();
  await expect(memory.getByTestId('memory-entry').filter({ hasText: 'chosen by the person' })).toContainText('Added by you');
  for (const words of ['Invoices are paid on the 5th.', 'The release build tag is canary-42.']) {
    await page.getByRole('navigation').getByRole('button', { name: 'Q4 review' }).click();
    await page.getByRole('button', { name: 'New chat' }).click();
    await message.fill(`Propose ${words}`);
    await message.press('Enter');
    await expect(page.getByTestId('answer').last()).toContainText('Proposed.', { timeout: TEST_HANG_MS });
    await idle(page);
  }
  await openMoreView(page, 'Memory');
  const kept = memory.getByTestId('memory-kept');
  const waiting = memory.getByTestId('memory-proposed');
  await expect(kept.getByTestId('memory-change').filter({ hasText: 'Invoices are paid on the 5th.' })).toContainText('Kept · New and consistent.', { timeout: TEST_HANG_MS });
  await expect(kept.getByRole('button', { name: 'Undo' })).toBeVisible();
  const held = waiting.getByTestId('memory-proposal').filter({ hasText: 'canary-42' });
  await expect(held).toContainText('Waits for you · It may change what the person said.', { timeout: TEST_HANG_MS });
  await expect(held).toContainText('It may contradict: “The release build tag is chosen by the person.”');
  await expect(held.getByRole('button', { name: 'Keep' })).toBeVisible();
  await waiting.scrollIntoViewIfNeeded();
  await shot('row06-01-waiting-for-you-and-tidied-by-itself');
  await kept.scrollIntoViewIfNeeded();
  await shot('row06-02-tidied-by-itself-with-undo');
  // Undo puts it back as it was: the kept line leaves memory.
  await kept.getByTestId('memory-change').filter({ hasText: 'Invoices are paid on the 5th.' }).getByRole('button', { name: 'Undo' }).click();
  await expect(memory.getByTestId('memory-change')).toHaveCount(0);
  await expect(memory.getByTestId('memory-entry').filter({ hasText: 'Invoices are paid' })).toHaveCount(0);
  await shot('row06-03-after-undo');
  const models = model.requests.filter((r) => r.body.includes('Consolidate this memory.'));
  expect(models.length, 'judged by model turns on the home\'s route').toBeGreaterThanOrEqual(2);
  expect(models.every((r) => { const tools = (JSON.parse(r.body) as { tools?: unknown[] }).tools; return !tools || tools.length === 0; }), 'the judge is offered no tool').toBe(true);

  // Row 14. Settings › Backup: the folder comes from main's picker, never from the page.
  const picked = realpathSync(mkdtempSync(join(tmpdir(), 'backbone-demo-export-')));
  scratch.push(picked);
  await app!.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as never;
  }, picked);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Backup' }).click();
  const section = dialog.getByTestId('backup');
  await expect(section.getByRole('button', { name: 'Export' })).toBeDisabled();
  await section.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(section.getByTestId('export-folder')).toContainText(join(picked, 'home-export-'));
  await shot('row14-01-folder-picked');
  await section.getByRole('button', { name: 'Export' }).click();
  const made = section.getByTestId('backup-made');
  await expect(made).toContainText(`Exported to ${join(picked, 'home-export-')}`, { timeout: TEST_HANG_MS });
  await expect(made).toContainText('Never in it');
  await shot('row14-02-exported');
  [exported] = readdirSync(picked).map((f) => join(picked, f));
  await section.getByRole('button', { name: 'Check' }).click();
  await expect(section.getByTestId('backup-checked')).toContainText('Every file matches');
  await shot('row14-03-export-checked');
  await quit();

  await transcript('row14-04-export-layout', `Terminal listing (not the app): the exported folder ${tidy(exported)}`, listing(exported).join('\n'));
});

test('row 14: backbone restore brings the export into a fresh home, and the restored home lists its projects', async () => {
  test.setTimeout(240_000);
  expect(exported, 'the export from the app').not.toBe('');
  const restored = join(realpathSync(mkdtempSync(join(tmpdir(), 'backbone-demo-restored-'))), 'home');
  const env = { ...process.env, BACKBONE_KEYS: 'plaintext', BACKBONE_HOME: '' };
  const run = (args: string[]) => {
    const shown = `$ backbone ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`;
    try {
      return `${shown}\n${execFileSync(process.execPath, [cli, ...args], { cwd: repoRoot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })}`;
    } catch (error) {
      const e = error as { status: number; stdout: string; stderr: string };
      throw new Error(`${shown} exited ${e.status}\n${e.stdout}\n${e.stderr}`);
    }
  };
  const out = [
    run(['restore', exported, '--home', restored, '--dry-run']),
    run(['restore', exported, '--home', restored]),
    run(['projects', 'list', '--home', restored]),
    run(['threads', 'list', '--all', '--home', restored]),
    run(['files', '--project', 'Q4 review', '--home', restored]),
  ].join('\n');
  expect(out).toContain('Imported into');
  expect(out).toContain('Q4 review');
  await transcript('row14-05-cli-restore', 'Terminal (not the app): backbone restore of the app\'s export into a new home, then that home\'s projects, chats and files', tidy(out));
  await removeDataHome(restored);
  rmSync(join(restored, '..'), { recursive: true, force: true });
});

test('row 1: a native Codex turn that delegates to a sub-agent, on the harness\'s fake client', async () => {
  test.setTimeout(240_000);
  const bin = mkdtempSync(join(tmpdir(), 'backbone-demo-codex-'));
  scratch.push(bin);
  const log = join(bin, 'turns.jsonl');
  writeFileSync(log, '');
  const client = join(repoRoot, 'packages/modules/harness-codex/test/fixtures/native.mjs');
  writeFileSync(join(bin, 'codex'), `#!/bin/sh\nBACKBONE_FAKE_CODEX_MODE=spawn exec '${process.execPath}' '${fixture('codex-client.mjs')}' '${log}' '${client}' "$@"\n`);
  chmodSync(join(bin, 'codex'), 0o755);
  const page = await launch('codex', {
    BACKBONE_HARNESS: 'harness-codex', BACKBONE_CODEX_SNAPSHOT_NODE: process.execPath,
    PATH: `${bin}:${process.env.PATH}`, BACKBONE_MODEL_ENDPOINT: '', BACKBONE_MODEL_ID: '',
  });
  await api(page, 'projects.create', { name: 'Native', kind: 'folder' });
  await page.getByRole('navigation').getByRole('button', { name: 'Native' }).click();
  await page.getByRole('textbox', { name: 'Message' }).fill('Write a brief, and hand the drafts to a helper');
  await page.getByRole('textbox', { name: 'Message' }).press('Enter');
  const work = page.getByTestId('work-block').first();
  await expect(work).toHaveText(/Worked for \d+/, { timeout: TEST_HANG_MS });
  await idle(page);
  const [{ id }] = await api<{ id: string }[]>(page, 'threads.list', {});
  type Work = { harness?: string; usage?: unknown; steps?: { label?: string }[] };
  const turn = (await api<{ value: { turns: { status: string; work?: Work; answer?: { files?: unknown[] } }[] } }>(page, 'threads.get', { id })).value.turns.at(-1)!;
  expect(turn.status, 'a turn in which the model delegates completes').toBe('done');
  await work.click();
  // The sub-agent's file comes in through the same staged import as the parent's.
  await expect(page.getByRole('button', { name: 'child.md v1', exact: true })).toBeVisible();
  // Recorded, not asserted: whether the app shows the harness's sub-agent events among the turn's steps.
  const subagentLines = await page.getByText(/^Sub-agent \/root\/helper/).count();
  await page.screenshot({ path: join(evidence, 'row01-01-delegating-turn-fake-codex.png') });
  writeFileSync(join(evidence, 'row01-fake-client.txt'), [
    'The Codex client was the harness\'s fake (packages/modules/harness-codex/test/fixtures/native.mjs, mode spawn), not real Codex.',
    `sub-agent event lines shown in the turn's steps: ${subagentLines}`,
    `turn status: ${turn.status}`,
    `turn steps: ${JSON.stringify((turn.work?.steps ?? []).map((s) => s.label))}`,
    `turn engine: ${turn.work?.harness ?? ''}`,
    `turn usage: ${JSON.stringify(turn.work?.usage ?? null)}`,
    `turns asked of the client: ${readFileSync(log, 'utf8').trim()}`,
  ].join('\n') + '\n');
  await quit();
});
