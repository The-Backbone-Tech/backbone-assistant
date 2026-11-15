import { TEST_HANG_MS } from '../../../../scripts/lib/test-hang.ts';
// Assertion deadlines detect hangs; Playwright retains the pending locator/property and last value.
// J-01 on the built Electron app, on a fresh data home: phases 1–10 with a real quit and relaunch,
// and adverse cases A1 (kill during Save), A2 (Stop during a write) and A3 (side chat effect).
// The agent is the app's own harness, Pi behind the Harness port, on the scripted model: an
// OpenAI-compatible server on the loopback, so no network and no key.
// Cites R-UX-HOME-01, R-UX-SIDEBAR-01, R-UX-COMPOSER-01, R-UX-THREAD-01, R-UX-PANES-01, R-UX-KEYS-01,
// R-UX-SIDECHAT-01, R-BASE-01, R-BASE-02, R-BASE-03, R-BASE-04, R-FILES-ORIG-01, R-FILES-REFRESH-01, R-WT-01.
import { removeDataHome } from '@backbone-next/platform/composition';
import { startScriptedModel, type ScriptedModel } from '@backbone-next/platform/testing';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  api, appDir, evidenceDir, expectDocumentInfo, phase1Home, phase2ProjectAndAttach, phase3Brief, phase4Panes, phase5EditSave, phase6SideChat,
  phase7Restored, phase8FollowUp, phase10Classes, prepareColdStart, Recorder, repoRoot, type Phase,
} from './journey';

test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
// Made at the first launch, not at import: Playwright's runner imports this file once just to list its tests.
let home = '';
const rec = new Recorder(join(evidenceDir, 'electron'), () => page);
const adverse: Phase[] = [];
let projectId = '';
let model: ScriptedModel | undefined;

// BACKBONE_APP_EXECUTABLE runs the journey on the installed app (scripts/install-dmg.mjs); otherwise the unpacked build.
const installed = process.env.BACKBONE_APP_EXECUTABLE;
const build = join(appDir, 'dist', 'package', 'build.json');

function appBuild() {
  if (!installed) return { kind: 'unpacked', path: 'packages/surfaces/app/dist/electron (development build, not installed)' };
  const info = existsSync(build) ? JSON.parse(readFileSync(build, 'utf8')) : {};
  return { kind: 'installed', from_dmg: info.dmg, dmg_sha256: info.sha256, version: info.version, electron: info.electron, arch: info.arch, signed: false, installed_to: '<temporary folder>/Backbone.app' };
}

async function launch(env: Record<string, string> = {}) {
  // Deliberately not a prepared home (freshDataHome): this journey is the app's own personal mode, its
  // bundled PostgreSQL started from nothing, killed (A1) and found running again. One cluster per run.
  home ||= mkdtempSync(join(tmpdir(), 'backbone-j01-electron-'));
  model ??= await startScriptedModel();
  const route = { BACKBONE_MODEL_ENDPOINT: model.url, BACKBONE_MODEL_ID: model.model };
  const runtime = { env: { ...process.env, BACKBONE_HOME: home, ...route, ...env } as Record<string, string> };
  app = await electron.launch(installed ? { ...runtime, executablePath: installed, args: [] } : { ...runtime, args: [appDir] });
  page = await app.firstWindow();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await expect(page.locator('[data-ready=true]')).toBeVisible({ timeout: TEST_HANG_MS });
}

async function adverseCase(id: string, run: () => Promise<void>) {
  try {
    await run();
    adverse.push({ id, ok: true, evidence: [await rec.shot(id)] });
  } catch (err) {
    adverse.push({ id, ok: false, evidence: [await rec.shot(`${id}-failed`).catch(() => ''), String(err).slice(0, 400)] });
    throw err;
  }
}

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const result = {
    journey: 'J-01',
    commit,
    app_build: appBuild(),
    model: 'claude-opus-5-5',
    effort: 'low',
    api: 'createHost backed by packages/core (personal-mode PostgreSQL 18, crossings, effect gateway)',
    harness: 'harness-pi (Pi 1.4.0 behind the Harness port), every write through the effect gateway',
    model_route: 'the scripted model: an OpenAI-compatible server on the loopback (no network, no key)',
    model_requests: model?.requests.length ?? 0,
    phases: rec.phases,
    adverse,
    parity: { compared_with: [], approved_by: null, date: null },
    ok: false,
    why_not_ok: [
      'The engine ran on the scripted model; one live J-01 run on Alberto\'s own key or gateway is still to do.',
      'Parity comparison is not approved by Alberto (R-UX-PARITY-01).',
      'Phase 9 uses a person-made change: this slice grants the agent document writes only, not commands or repository edits.',
      ...(installed ? [] : ['This run used the unpacked build, not the installed app.']),
    ],
  };
  writeFileSync(join(evidenceDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  // The data home goes with the run, its database first (the A1 kill leaves the app's server running).
  if (home) await removeDataHome(home);
  await model?.close();
});

test('approved light chat cream is exact in the composed Electron build and Dark stays unchanged', async () => {
  await launch();
  try {
    const compiled = JSON.parse(readFileSync(join(appDir, 'dist', 'build.json'), 'utf8'));
    const runtime = await page.evaluate(() => window.backbone!.appInfo!());
    expect(runtime.packaged).toBe(!!installed);
    if (installed) expect(runtime.version).toBe(compiled.version);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const identity = page.getByTestId('build-identity');
    await expect(identity).toContainText(installed ? 'Packaged desktop app' : 'Unpacked desktop build');
    await expect(identity).toContainText(compiled.revision ? `Revision ${compiled.revision.slice(0, 12)}` : 'Revision unknown (Git unavailable)');
    await expect(identity).toContainText(compiled.dirty === null ? 'Working tree unknown' : compiled.dirty ? 'Includes uncommitted changes' : 'Clean source checkout');
    await identity.getByText('Build details', { exact: true }).click();
    await expect(identity.getByText(`Build ${compiled.id} · ${compiled.builtAt}`, { exact: true })).toBeVisible();
    await identity.scrollIntoViewIfNeeded();
    await rec.shot('compiled-build-identity');
    await page.keyboard.press('Escape');
    const conversation = page.locator('.bg-conversation').first();
    await page.getByRole('button', { name: 'Light theme', exact: true }).click();
    await expect(conversation).toHaveCSS('background-color', 'rgb(251, 247, 241)');
    const light = await conversation.evaluate((e) => getComputedStyle(e).backgroundColor);
    await rec.shot('approved-light-conversation');
    await page.getByRole('button', { name: 'Dark theme', exact: true }).click();
    await expect(conversation).toHaveCSS('background-color', 'rgb(22, 22, 22)');
    const dark = await conversation.evaluate((e) => getComputedStyle(e).backgroundColor);
    await rec.shot('approved-dark-conversation');
    writeFileSync(join(rec.dir, 'approved-background.json'), JSON.stringify({
      commit: compiled.revision,
      app_build: appBuild(), compiled, runtime, light, dark,
    }, null, 2) + '\n');
  } finally { await app.close(); }
});

test('phases 1–8 and 10, with a real quit and cold start', async () => {
  await launch();
  await page.getByRole('button', { name: 'Light theme' }).click();
  await rec.phase('01-home', () => phase1Home(page));
  await rec.phase('02-project-attach', async () => void (projectId = await phase2ProjectAndAttach(page)));
  await rec.phase('03-brief', async () => {
    await phase3Brief(page);
    await expect(page.getByText(/^Pi 1\.4\.0 · Local endpoint · scripted-model · no charge/)).toBeVisible();
  });
  await rec.phase('04-panes', () => phase4Panes(page));
  await rec.phase('05-edit-save', () => phase5EditSave(page));
  await rec.phase('06-side-chat', () => phase6SideChat(page, projectId, 'model'));
  adverse.push({ id: 'A3-side-chat-effect', ok: true, evidence: [rec.phases.at(-1)!.evidence.at(-1)!] });
  await prepareColdStart(page);
  await rec.phase('07-cold-start', async () => {
    await app.close();
    await launch();
    await phase7Restored(page);
  });
  await rec.phase('08-follow-up', () => phase8FollowUp(page));
  await rec.phase('10-classes', () => phase10Classes(page, projectId));
});

test('A1: kill during Save leaves exactly one current version, and the UI says which', async () => {
  await app.close();
  await launch({ BACKBONE_STUB_SAVE_DELAY_MS: '5000' });
  await page.getByRole('tab', { name: /brief\.md/ }).click();
  await expect(page.getByTestId('edit-state').filter({ visible: true })).toHaveText('Unsaved edit');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('edit-state').filter({ visible: true })).toHaveText('Saving…');
  await rec.shot('A1a-saving');
  app.process().kill('SIGKILL');
  await launch();
  await adverseCase('A1-kill-during-save', async () => {
    await page.getByRole('tab', { name: /brief\.md/ }).click();
    await expect(page.getByTestId('interrupted-save')).toHaveText(/The Save of v3 did not finish\. v2 is the current version\./);
    await expectDocumentInfo(page, 'v2 · saved by you', 'Unsaved edit');
    const brief = (await api<{ name: string; current: number; versions: unknown[] }[]>(page, 'material.list', { projectId })).find((e) => e.name === 'brief.md')!;
    expect([brief.current, brief.versions.length]).toEqual([2, 2]);
  });
});

test('A2: Stop during a write shows UNKNOWN, and the exact copy is not resent', async () => {
  await app.close();
  await launch({ BACKBONE_STUB_WRITE_DELAY_MS: '5000' });
  await page.getByRole('button', { name: 'Close pane' }).click();
  await page.getByRole('button', { name: 'New chat' }).click();
  await page.getByRole('textbox', { name: 'Message' }).fill('Draft a brief for the launch');
  await page.getByRole('textbox', { name: 'Message' }).press('Enter');
  await expect(page.getByTestId('work-block').last()).toHaveText(/Working/);
  // Stop must land after the write crosses: before it, the honest result is that nothing was proposed.
  await expect.poll(async () => {
    const [{ id }] = await api<{ id: string }[]>(page, 'threads.list', {});
    const thread = await api<{ value: { turns: { effects: { key: string }[] }[] } }>(page, 'threads.get', { id });
    return thread.value.turns.at(-1)?.effects.some((e) => e.key);
  }).toBe(true);
  await page.getByRole('button', { name: 'Stop' }).click();
  await adverseCase('A2-stop-during-write', async () => {
    await expect(page.getByTestId('effect-UNKNOWN')).toContainText('will not be resent');
    await page.getByRole('textbox', { name: 'Message' }).fill('Draft a brief for the launch');
    await page.getByRole('textbox', { name: 'Message' }).press('Enter');
    await expect(page.getByTestId('effect-REFUSED')).toContainText('is not resent');
  });
});

test('phase 9: a repository change shows on Uncommitted, and nothing is committed without the person', async () => {
  const deadline = Date.now() + test.info().timeout;
  const remaining = () => Math.max(1, deadline - Date.now() - 2_000);
  await rec.phase(
    '09-repository-changes',
    async () => {
      await page.getByRole('button', { name: 'New project' }).click();
      await page.getByRole('textbox', { name: 'Name' }).fill('scratch');
      await page.getByRole('radio', { name: 'Repository (git)' }).check();
      await page.getByRole('button', { name: 'Create project' }).click();
      await expect(page.getByRole('dialog', {name:'New project'})).toHaveCount(0, {timeout:remaining()});
      const scratch = (await api<{id:string;name:string}[]>(page, 'projects.list', {})).find(project => project.name === 'scratch');
      expect(scratch).toBeDefined();
      await expect.poll(async () => (await api<{selectedProjectId?:string}>(page, 'viewer.get', {})).selectedProjectId, {timeout:remaining()}).toBe(scratch!.id);
      await page.keyboard.press('Control+Backquote');
      await page.getByRole('textbox', { name: 'Terminal command' }).fill("printf 'export const answer = 42;\\n' > answer.ts");
      await page.getByRole('textbox', { name: 'Terminal command' }).press('Enter');
      await expect.poll(async () => {
        const changes = await api<{ok:boolean;value?:{files:{path:string}[]}}>(page, 'changes.get', {projectId:scratch!.id, scope:'uncommitted'});
        return changes.ok && changes.value?.files.some(file => file.path === 'answer.ts');
      }, {timeout:remaining()}).toBe(true);
      await page.getByRole('textbox', { name: 'Terminal command' }).fill('git log --oneline | wc -l');
      await page.getByRole('textbox', { name: 'Terminal command' }).press('Enter');
      await expect(page.getByTestId('terminal-tab').locator('pre').last()).toHaveText(/^\s*1\s*$/);
      await page.keyboard.press('Control+Shift+G');
      await page.getByRole('radio', { name: 'Uncommitted' }).click();
      await expect(page.getByTestId('changes-tab')).toContainText('answer.ts', {timeout:remaining()});
      await expect(page.getByTestId('changes-tab')).toContainText('export const answer = 42;', {timeout:remaining()});
    },
    'The agent is granted document writes only in this slice, so the change is made in the Terminal by the person; the agent-made half of phase 9 waits for command and repository grants.',
  );
});

test('screenshots: Dark, 375 and 320 px on the Electron app', async () => {
  const win = (w: number, h: number) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [w, h] as const);
  await page.getByRole('button', { name: 'Dark theme' }).click();
  await page.waitForTimeout(400);
  await rec.shot('dark-1440-repository');
  await page.getByRole('navigation').getByRole('button', { name: 'Q4 review' }).click();
  await rec.shot('dark-1440-home-in-project');
  await win(375, 812);
  await page.getByRole('button', { name: 'Close pane' }).click();
  await rec.shot('dark-375-home');
  await page.getByRole('button', { name: 'Open sidebar' }).click();
  await page.getByRole('button', { name: 'Light theme' }).click();
  await page.getByRole('button', { name: 'Close sidebar' }).click();
  await page.waitForTimeout(400);
  await rec.shot('light-375-home');
  await page.getByRole('button', { name: 'Open sidebar' }).click();
  await rec.shot('light-375-sidebar');
  await page.getByRole('navigation').getByRole('button', { name: 'Write an editable brief from these', exact: true }).click();
  await win(320, 640);
  await page.waitForTimeout(300);
  await rec.shot('light-320-thread');
  await page.getByRole('button', { name: 'Open sidebar' }).click();
  await page.getByRole('button', { name: 'Dark theme' }).click();
  await page.getByRole('button', { name: 'Close sidebar' }).click();
  await page.waitForTimeout(400);
  await rec.shot('dark-320-thread');
  await win(1440, 900);
});

test('R-MODEL-02, R-MODEL-01: Settings takes a key the person pastes, seals it, never shows it again, and says who bills', async () => {
  const canary = `canary-${crypto.randomUUID()}`;
  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: 'AI and models' }).click();
  await expect(dialog.getByTestId('model-active')).toContainText('Pi 1.4.0');
  await expect(dialog.getByTestId('model-active')).toContainText('Local endpoint · scripted-model');
  await dialog.getByText('Change your model', { exact: true }).click();
  const gateway = dialog.getByRole('form', { name: 'Or a gateway' });
  await gateway.getByRole('radio', { name: 'OpenRouter' }).check();
  await expect(gateway).toContainText('billed by OpenRouter to your credits, with its fee');
  await gateway.getByLabel('Or a gateway: key').fill(canary);
  await gateway.getByRole('button', { name: 'Save' }).click();
  await expect(gateway).toContainText('Key set · OpenRouter');
  await expect(gateway.getByLabel('Or a gateway: key')).toHaveValue('');
  await expect(dialog.getByTestId('model-active')).toContainText('OpenRouter · anthropic/claude-sonnet-5.5');
  await rec.shot('settings-gateway-key-set');
  expect(await page.content()).not.toContain(canary);
  expect(JSON.stringify(await api(page, 'settings.model.get', {}))).not.toContain(canary);
  await gateway.getByRole('button', { name: 'Remove' }).click();
  await expect(dialog.getByTestId('model-active')).toContainText('Local endpoint · scripted-model');
  await dialog.getByRole('button', { name: 'Done' }).click();
});
